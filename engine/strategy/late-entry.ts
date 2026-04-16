import type { Strategy, StrategyContext } from "./types.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type EntrySignal = {
  side: "UP" | "DOWN";
  ask: number;
  gap: number;
  gapBps: number;
  liquidity: number;
  shares: number;
};

type FrictionEstimate = {
  feeRateBps: number;
  tickSize: number;
  grossUpside: number;
  estimatedFee: number;
  estimatedSlippage: number;
  estimatedNetUpside: number;
};

type LateEntryPosition = {
  side: "UP" | "DOWN";
  tokenId: string;
  entryPrice: number;
  shares: number;
};

type LateEntryState = {
  hasEntered: boolean;
  position: LateEntryPosition | null;
  stopLossFired: boolean;
  lastSkipReason: string | null;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MIN_ENTRY_REMAINING_SECS = 18;
const MAX_ENTRY_REMAINING_SECS = 70;
const ASSET_CONFIG = {
  BTC: {
    minGapBps: 3.5,
    maxGapBps: 28,
    maxDivergence: 20,
    minLiquidityUsd: 100,
    entryPriceMin: 0.82,
    entryPriceMax: 0.95,
    targetNotionalUsd: 2.5,
    minOrderUsd: 1.5,
    maxTopLevelShare: 0.2,
    emergencyReversalBps: 4.5,
  },
  ETH: {
    minGapBps: 4,
    maxGapBps: 35,
    maxDivergence: 20,
    minLiquidityUsd: 100,
    entryPriceMin: 0.82,
    entryPriceMax: 0.95,
    targetNotionalUsd: 2.25,
    minOrderUsd: 1.5,
    maxTopLevelShare: 0.2,
    emergencyReversalBps: 5,
  },
  SOL: {
    minGapBps: 5,
    maxGapBps: 45,
    maxDivergence: 24,
    minLiquidityUsd: 100,
    entryPriceMin: 0.8,
    entryPriceMax: 0.95,
    targetNotionalUsd: 1.75,
    minOrderUsd: 1.25,
    maxTopLevelShare: 0.18,
    emergencyReversalBps: 6,
  },
  XRP: {
    minGapBps: 6,
    maxGapBps: 60,
    maxDivergence: 28,
    minLiquidityUsd: 100,
    entryPriceMin: 0.8,
    entryPriceMax: 0.95,
    targetNotionalUsd: 1.5,
    minOrderUsd: 1,
    maxTopLevelShare: 0.18,
    emergencyReversalBps: 7,
  },
} as const;

type AssetSymbol = keyof typeof ASSET_CONFIG;

function getAssetFromSlug(slug: string): AssetSymbol {
  const prefix = slug.split("-")[0]?.toUpperCase();
  if (prefix === "BTC" || prefix === "ETH" || prefix === "SOL" || prefix === "XRP") {
    return prefix;
  }
  return "BTC";
}

function sizeShares(ask: number, liquidityUsd: number, targetNotionalUsd: number, minOrderUsd: number, maxTopLevelShare: number): number | null {
  const cappedNotional = Math.min(targetNotionalUsd, liquidityUsd * maxTopLevelShare);
  if (cappedNotional < minOrderUsd) return null;
  const rawShares = cappedNotional / ask;
  const roundedShares = Math.floor(rawShares * 100) / 100;
  return roundedShares > 0 ? roundedShares : null;
}

function checkEntry(params: {
  asset: AssetSymbol;
  remaining: number;
  btcPrice: number;
  priceToBeat: number;
  up: { price: number; liquidity: number } | null;
  down: { price: number; liquidity: number } | null;
  divergence: number | null;
}): { entered: true; signal: EntrySignal } | { entered: false; reason: string } {
  const {
    asset,
    remaining,
    btcPrice,
    priceToBeat,
    up,
    down,
  } = params;
  const cfg = ASSET_CONFIG[asset];

  if (remaining < MIN_ENTRY_REMAINING_SECS) {
    return { entered: false, reason: `too close to slot end (${remaining}s < ${MIN_ENTRY_REMAINING_SECS}s min)` };
  }
  if (remaining > MAX_ENTRY_REMAINING_SECS) {
    return { entered: false, reason: `too early in slot (${remaining}s > ${MAX_ENTRY_REMAINING_SECS}s max)` };
  }

  const gap = btcPrice - priceToBeat;
  const absGap = Math.abs(gap);
  const gapBps = (absGap / priceToBeat) * 10_000;
  const divergence = params.divergence ?? Infinity;

  if (gapBps < cfg.minGapBps) {
    return { entered: false, reason: `gap too small (${gapBps.toFixed(2)}bps < ${cfg.minGapBps}bps)` };
  }
  if (gapBps > cfg.maxGapBps) {
    return { entered: false, reason: `gap too large (${gapBps.toFixed(2)}bps > ${cfg.maxGapBps}bps)` };
  }

  if (divergence > cfg.maxDivergence) {
    return { entered: false, reason: `side divergence too high (${divergence} > ${cfg.maxDivergence})` };
  }

  const side: "UP" | "DOWN" = gap > 0 ? "UP" : "DOWN";
  const info = side === "UP" ? up : down;
  if (!info) {
    return { entered: false, reason: `no ${side} book data` };
  }

  if (info.liquidity < cfg.minLiquidityUsd) {
    return { entered: false, reason: `liquidity too low ($${info.liquidity} < $${cfg.minLiquidityUsd})` };
  }

  if (info.price > cfg.entryPriceMax) {
    return { entered: false, reason: `ask price ${info.price} above hard cap ${cfg.entryPriceMax}` };
  }

  if (info.price < cfg.entryPriceMin) {
    return { entered: false, reason: `ask price ${info.price} below minimum momentum price ${cfg.entryPriceMin}` };
  }

  const shares = sizeShares(
    info.price,
    info.liquidity,
    cfg.targetNotionalUsd,
    cfg.minOrderUsd,
    cfg.maxTopLevelShare,
  );
  if (!shares) {
    return { entered: false, reason: `size too small after liquidity cap` };
  }

  return {
    entered: true,
    signal: {
      side,
      ask: info.price,
      gap: absGap,
      gapBps,
      liquidity: info.liquidity,
      shares,
    },
  };
}

// ---------------------------------------------------------------------------
// Order placement helpers
// ---------------------------------------------------------------------------

function estimateFriction(
  ctx: StrategyContext,
  signal: EntrySignal,
): FrictionEstimate {
  const tokenId =
    signal.side === "UP" ? ctx.clobTokenIds[0] : ctx.clobTokenIds[1];
  const feeRateBps = ctx.orderBook.getFeeRate(tokenId);
  const tickSize = parseFloat(ctx.orderBook.getTickSize(tokenId));
  const grossUpside = Math.max(0, (1 - signal.ask) * signal.shares);
  const estimatedFee = signal.shares * (feeRateBps / 10_000) * signal.ask;
  const estimatedSlippage = tickSize * signal.shares * 0.5;
  const estimatedNetUpside = grossUpside - estimatedFee - estimatedSlippage;
  return { feeRateBps, tickSize, grossUpside, estimatedFee, estimatedSlippage, estimatedNetUpside };
}

function placeEntry(
  ctx: StrategyContext,
  state: LateEntryState,
  signal: EntrySignal,
): void {
  const tokenId =
    signal.side === "UP" ? ctx.clobTokenIds[0] : ctx.clobTokenIds[1];
  const friction = estimateFriction(ctx, signal);

  ctx.postOrders([
    {
      req: { tokenId, action: "buy", price: signal.ask, shares: signal.shares },
      expireAtMs: ctx.slotEndMs,
      onFilled(filledShares) {
        state.position = {
          side: signal.side,
          tokenId,
          entryPrice: signal.ask,
          shares: filledShares,
        };
        ctx.log(
          `[${ctx.slug}] late-entry: BUY ${signal.side} filled @ ${signal.ask} (${filledShares} shares, gross $${friction.grossUpside.toFixed(2)}, est net $${friction.estimatedNetUpside.toFixed(2)})`,
          "green",
        );
      },
      onExpired() {
        ctx.log(
          `[${ctx.slug}] late-entry: BUY ${signal.side} @ ${signal.ask} expired — resetting`,
          "yellow",
        );
        state.hasEntered = false;
      },
      onFailed(reason) {
        ctx.log(
          `[${ctx.slug}] late-entry: BUY ${signal.side} @ ${signal.ask} failed (${reason}) — resetting`,
          "red",
        );
        state.hasEntered = false;
      },
    },
  ]);
}

function checkEmergencyExit(
  ctx: StrategyContext,
  state: LateEntryState,
  gap: number | null,
  priceToBeat: number,
): void {
  const pos = state.position;
  if (!pos) return;

  const asset = getAssetFromSlug(ctx.slug);
  const cfg = ASSET_CONFIG[asset];

  let reason: string | null = null;
  if (ctx.ticker.isKillswitch) {
    reason = `provider divergence hit kill switch ($${ctx.ticker.divergence?.toFixed(2) ?? '?'})`;
  }

  if (!reason && gap !== null) {
    const reversalBps = (Math.abs(gap) / priceToBeat) * 10_000;
    const hardReversal =
      (pos.side === "UP" && gap < 0 && reversalBps >= cfg.emergencyReversalBps) ||
      (pos.side === "DOWN" && gap > 0 && reversalBps >= cfg.emergencyReversalBps);
    if (hardReversal) {
      reason = `direction fully reversed (${reversalBps.toFixed(2)}bps against position)`;
    }
  }

  if (!reason) return;

  const bestAsk = ctx.orderBook.bestAskInfo(pos.side)?.price ?? null;
  const bestBid = ctx.orderBook.bestBidPrice(pos.side);
  if (bestAsk === null) return;

  state.stopLossFired = true;
  state.position = null;

  const sellPrice =
    bestBid !== null ? Math.max(bestBid, bestAsk - 0.01) : bestAsk - 0.01;

  ctx.log(
    `[${ctx.slug}] late-entry: emergency exit triggered (${reason}) — SELL ${pos.side} @ ${sellPrice}`,
    "red",
  );

  ctx.postOrders([
    {
      req: {
        tokenId: pos.tokenId,
        action: "sell",
        price: sellPrice,
        shares: pos.shares,
      },
      expireAtMs: ctx.slotEndMs,
      onFilled() {
        ctx.log(
          `[${ctx.slug}] late-entry: risk-exit SELL filled @ ${sellPrice}`,
          "green",
        );
      },
      onExpired() {
        ctx.log(
          `[${ctx.slug}] late-entry: risk-exit SELL expired — emergency selling`,
          "red",
        );
        const sellIds = ctx.pendingOrders
          .filter((o) => o.action === "sell")
          .map((o) => o.orderId);
        if (sellIds.length > 0) {
          ctx.emergencySells(sellIds);
        }
      },
    },
  ]);
}

// ---------------------------------------------------------------------------
// Strategy
// ---------------------------------------------------------------------------

export const lateEntry: Strategy = async (ctx) => {
  // ── ctx.hold() ────────────────────────────────────────────────────────────
  const releaseLock = ctx.hold();

  const state: LateEntryState = {
    hasEntered: false,
    position: null,
    stopLossFired: false,
    lastSkipReason: null,
  };

  const tickInterval = setInterval(() => {
    const remaining = Math.floor((ctx.slotEndMs - Date.now()) / 1000);

    if (remaining <= 0) {
      clearInterval(tickInterval);
      return;
    }

    if (remaining <= 5 && !state.position) {
      clearInterval(tickInterval);
      releaseLock();
      return;
    }

    const marketResult = ctx.getMarketResult();
    const priceToBeat = marketResult?.openPrice ?? null;
    if (!priceToBeat) {
      // Log this once per slot when no market data yet
      if (remaining === Math.floor((ctx.slotEndMs - Date.now()) / 1000)) {
        state.lastSkipReason = "no open price from market result yet";
      }
      return;
    }

    const btcPrice = ctx.ticker.price;
    const gap = btcPrice !== undefined ? btcPrice - priceToBeat : null;

    if (!state.hasEntered) {
      const up = ctx.orderBook.bestAskInfo("UP");
      const down = ctx.orderBook.bestAskInfo("DOWN");

      if (btcPrice !== undefined) {
        const result = checkEntry({
          remaining,
          asset: getAssetFromSlug(ctx.slug),
          btcPrice,
          priceToBeat,
          up,
          down,
          divergence: ctx.ticker.divergence,
        });

        if (result.entered) {
          const { signal } = result;
          const friction = estimateFriction(ctx, signal);
          state.hasEntered = true;
          state.lastSkipReason = null;
          ctx.log(
            `[${ctx.slug}] late-entry: signal ${signal.side} @ ${signal.ask} (${signal.shares} shares, gap ${signal.gap.toFixed(4)}, ${signal.gapBps.toFixed(2)}bps, liq $${signal.liquidity.toFixed(0)}, gross $${friction.grossUpside.toFixed(2)}, est net $${friction.estimatedNetUpside.toFixed(2)}, fee ${friction.feeRateBps}bps, slip ~$${friction.estimatedSlippage.toFixed(2)})`,
            "cyan",
          );
          placeEntry(ctx, state, signal);
        } else {
          // Only log if skip reason changed (avoid spam)
          if (state.lastSkipReason !== result.reason) {
            state.lastSkipReason = result.reason;
            ctx.log(
              `[${ctx.slug}] late-entry: no-entry (${result.reason}) remaining=${remaining}s gap=${gap !== null ? gap.toFixed(0) : '?'} divergence=${ctx.ticker.divergence?.toFixed(1) ?? '?'}`,
              "dim",
            );
          }
        }
      }
    }

    if (state.position && !state.stopLossFired) {
      checkEmergencyExit(ctx, state, gap, priceToBeat);
    }
  }, 0);
};
