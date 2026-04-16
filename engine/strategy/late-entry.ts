import type { Strategy, StrategyContext } from "./types.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type EntrySignal = {
  side: "UP" | "DOWN";
  ask: number;
  gap: number;
  liquidity: number;
  stopLossPrice: number;
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
  stopLossPrice: number;
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

const SHARES = 6;
const MIN_ENTRY_REMAINING_SECS = 18;
const MAX_ENTRY_REMAINING_SECS = 70;
const MAX_DIVERGENCE = 20;
const MIN_ABS_GAP = 25;
const MAX_ABS_GAP = 180;
const MIN_LIQUIDITY = 100;
const ENTRY_PRICE_MIN = 0.8;
const ENTRY_PRICE_MAX = 0.95;
const HARD_ENTRY_CAP = 0.95;
const BASE_STOP_LOSS_PRICE = 0.72;
const HARD_STOP_LOSS_BUFFER = 0.08;
const SOFT_STOP_LOSS_BUFFER = 0.05;

function checkEntry(params: {
  remaining: number;
  btcPrice: number;
  priceToBeat: number;
  up: { price: number; liquidity: number } | null;
  down: { price: number; liquidity: number } | null;
  divergence: number | null;
}): { entered: true; signal: EntrySignal } | { entered: false; reason: string } {
  const {
    remaining,
    btcPrice,
    priceToBeat,
    up,
    down,
  } = params;

  if (remaining < MIN_ENTRY_REMAINING_SECS) {
    return { entered: false, reason: `too close to slot end (${remaining}s < ${MIN_ENTRY_REMAINING_SECS}s min)` };
  }
  if (remaining > MAX_ENTRY_REMAINING_SECS) {
    return { entered: false, reason: `too early in slot (${remaining}s > ${MAX_ENTRY_REMAINING_SECS}s max)` };
  }

  const gap = btcPrice - priceToBeat;
  const absGap = Math.abs(gap);
  const divergence = params.divergence ?? Infinity;

  if (absGap < MIN_ABS_GAP) {
    return { entered: false, reason: `gap too small (${absGap} < ${MIN_ABS_GAP})` };
  }
  if (absGap > MAX_ABS_GAP) {
    return { entered: false, reason: `gap too large (${absGap} > ${MAX_ABS_GAP})` };
  }

  if (divergence > MAX_DIVERGENCE) {
    return { entered: false, reason: `side divergence too high (${divergence} > ${MAX_DIVERGENCE})` };
  }

  const side: "UP" | "DOWN" = gap > 0 ? "UP" : "DOWN";
  const info = side === "UP" ? up : down;
  if (!info) {
    return { entered: false, reason: `no ${side} book data` };
  }

  if (info.liquidity < MIN_LIQUIDITY) {
    return { entered: false, reason: `liquidity too low ($${info.liquidity} < $${MIN_LIQUIDITY})` };
  }

  if (info.price > HARD_ENTRY_CAP) {
    return { entered: false, reason: `ask price ${info.price} above hard cap ${HARD_ENTRY_CAP}` };
  }

  if (info.price < ENTRY_PRICE_MIN) {
    return { entered: false, reason: `ask price ${info.price} below minimum momentum price ${ENTRY_PRICE_MIN}` };
  }

  return {
    entered: true,
    signal: {
      side,
      ask: info.price,
      gap: absGap,
      liquidity: info.liquidity,
      stopLossPrice: Math.max(
        BASE_STOP_LOSS_PRICE,
        info.price - (info.price >= 0.9 ? HARD_STOP_LOSS_BUFFER : SOFT_STOP_LOSS_BUFFER),
      ),
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
  const grossUpside = Math.max(0, (1 - signal.ask) * SHARES);
  const estimatedFee = SHARES * (feeRateBps / 10_000) * signal.ask;
  const estimatedSlippage = tickSize * SHARES * 0.5;
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
      req: { tokenId, action: "buy", price: signal.ask, shares: SHARES },
      expireAtMs: ctx.slotEndMs,
      onFilled(filledShares) {
        state.position = {
          side: signal.side,
          tokenId,
          entryPrice: signal.ask,
          shares: filledShares,
          stopLossPrice: signal.stopLossPrice,
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

function checkStopLoss(
  ctx: StrategyContext,
  state: LateEntryState,
  remaining: number,
  gap: number | null,
): void {
  const pos = state.position;
  if (!pos) return;

  const bestAsk = ctx.orderBook.bestAskInfo(pos.side)?.price ?? null;
  const bestBid = ctx.orderBook.bestBidPrice(pos.side);
  if (bestAsk === null) return;

  const gapConfirmsPosition =
    gap !== null &&
    ((pos.side === "UP" && gap > 10) || (pos.side === "DOWN" && gap < -10));
  const valueZonePosition = pos.entryPrice <= ENTRY_PRICE_MAX;

  const hardStopHit = bestAsk <= pos.stopLossPrice;
  const softStopHit =
    valueZonePosition && remaining <= 55 && bestAsk <= pos.entryPrice - SOFT_STOP_LOSS_BUFFER;

  const shouldSell =
    ((hardStopHit || softStopHit) && !gapConfirmsPosition) ||
    (remaining <= 15 && bestAsk < pos.entryPrice && !gapConfirmsPosition);

  if (!shouldSell) return;

  state.stopLossFired = true;
  state.position = null;

  const sellPrice =
    bestBid !== null ? Math.max(bestBid, bestAsk - 0.01) : bestAsk - 0.01;

  ctx.log(
    `[${ctx.slug}] late-entry: risk exit triggered — SELL ${pos.side} @ ${sellPrice}`,
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
            `[${ctx.slug}] late-entry: signal ${signal.side} @ ${signal.ask} (gap ${signal.gap.toFixed(0)}, liq $${signal.liquidity.toFixed(0)}, gross $${friction.grossUpside.toFixed(2)}, est net $${friction.estimatedNetUpside.toFixed(2)}, fee ${friction.feeRateBps}bps, slip ~$${friction.estimatedSlippage.toFixed(2)})`,
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
      checkStopLoss(ctx, state, remaining, gap);
    }
  }, 0);
};
