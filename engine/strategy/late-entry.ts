import type { Strategy, StrategyContext } from "./types.ts";

// ============================================================================
// BTC-ONLY LATE ENTRY STRATEGY
//
// Edge:
//   The Polymarket orderbook lags BTC spot during the final minute of a
//   5-minute Up/Down market. When spot has moved decisively past the open
//   price, true P(settlement on our side) > ask. We enter, then either ride
//   the position to settlement or exit on a probability-based stop-loss /
//   time stop / killswitch.
//
// Risk management layers:
//   L1  per-trade:  ask ∈ [0.85, 0.95], P(win) ≥ 0.88, EV ≥ 3% after fees,
//                   min liquidity, feed-divergence check.
//   L2  sizing:     1/8 Kelly, capped at MAX_RISK_PER_TRADE, capped at
//                   MAX_TOP_LEVEL_SHARE of top-level liquidity.
//   L3  exit:       stop-loss when P(win) drops below STOP_LOSS_PROB;
//                   time-stop in final TIME_STOP_SECS seconds; killswitch
//                   on feed divergence / whale-dump. No take-profit —
//                   winners run to settlement.
//   L4  session:    consecutive-loss cooldown, daily-drawdown halt,
//                   one-entry-per-slot. Engine-level MAX_SESSION_LOSS
//                   already enforced externally.
// ============================================================================

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

const MIN_ENTRY_REMAINING_SECS = 15;
const MAX_ENTRY_REMAINING_SECS = 150;
const TIME_STOP_SECS = 6;
const SKIP_SUMMARY_INTERVAL_MS = 60_000;
const MODEL_EVAL_LOG_INTERVAL_MS = 5_000;

// BTC realised vol calibration. ~20 bps per 5 min ⇒ ~1.15 bps per √sec.
// Override via env BTC_SIGMA_BPS_PER_SQRT_SEC if the market regime shifts.
const DEFAULT_BTC_SIGMA_BPS_PER_SQRT_SEC = 1.15;

const ENTRY_PRICE_MIN = 0.75;
const ENTRY_PRICE_MAX = 0.97;
const MIN_TRUE_PROB = 0.78;
const MIN_EV_AFTER_FEES = 0.01;
const MAX_FEED_DIVERGENCE_USD = 25;
const MIN_LIQUIDITY_USD = 100;

const MAX_RISK_PER_TRADE_USD = 3;
const KELLY_FRACTION = 0.125;
const MAX_TOP_LEVEL_SHARE = 0.35;
const MIN_ORDER_USD = 1.5;

const STOP_LOSS_PROB = 0.70;
// Ignore killswitch/whale-dump triggers for the first N seconds after fill.
// Our entries fire precisely during fast spot moves, which produce transient
// cross-feed divergence. Without this grace window, the kill fires 8-15s
// into a winning move and clips the P&L.
const POST_ENTRY_KILL_GRACE_SECS = 15;

const MAX_CONSECUTIVE_LOSSES = 3;
const COOLDOWN_AFTER_LOSSES_MS = 10 * 60 * 1000;
const MAX_DAILY_LOSS_PCT = 0.05;
const DEFAULT_BANKROLL_BASELINE = 500;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type EntrySignal = {
  side: "UP" | "DOWN";
  ask: number;
  trueProb: number;
  edge: number;
  shares: number;
  liquidity: number;
};

type Position = {
  side: "UP" | "DOWN";
  tokenId: string;
  entryPrice: number;
  shares: number;
  filledAtMs: number;
};

type SlotState = {
  hasEntered: boolean;
  position: Position | null;
  exitFiring: boolean;
  exitReason: "sl" | "time" | "kill-div" | "kill-whale" | null;
  realizedPnl: number;
  skipBuckets: Record<string, number>;
  lastSkipSummaryMs: number;
  lastModelEvalMs: number;
};

// ---------------------------------------------------------------------------
// Cross-slot risk state (module-level, resets on process restart)
// ---------------------------------------------------------------------------

type RiskState = {
  consecutiveLosses: number;
  cooldownUntilMs: number;
  dailyLossUsd: number;
  dailyDayStartMs: number;
};

const riskState: RiskState = {
  consecutiveLosses: 0,
  cooldownUntilMs: 0,
  dailyLossUsd: 0,
  dailyDayStartMs: startOfUtcDay(Date.now()),
};

function startOfUtcDay(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function bankrollBaseline(): number {
  const raw = process.env.BANKROLL_BASELINE ?? process.env.WALLET_BALANCE;
  const n = raw !== undefined ? parseFloat(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_BANKROLL_BASELINE;
}

function btcSigma(): number {
  const raw = process.env.BTC_SIGMA_BPS_PER_SQRT_SEC;
  const n = raw !== undefined ? parseFloat(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_BTC_SIGMA_BPS_PER_SQRT_SEC;
}

function rolloverDailyIfNeeded(nowMs: number): void {
  const day = startOfUtcDay(nowMs);
  if (day !== riskState.dailyDayStartMs) {
    riskState.dailyDayStartMs = day;
    riskState.dailyLossUsd = 0;
  }
}

function recordOutcome(pnlUsd: number): void {
  rolloverDailyIfNeeded(Date.now());
  if (pnlUsd < 0) {
    riskState.consecutiveLosses += 1;
    riskState.dailyLossUsd += Math.abs(pnlUsd);
    if (riskState.consecutiveLosses >= MAX_CONSECUTIVE_LOSSES) {
      riskState.cooldownUntilMs = Date.now() + COOLDOWN_AFTER_LOSSES_MS;
    }
  } else if (pnlUsd > 0) {
    riskState.consecutiveLosses = 0;
  }
}

function lossCapsDisabled(): boolean {
  return process.env.DISABLE_LOSS_CAPS === "true";
}

function circuitBreakerReason(nowMs: number): string | null {
  if (lossCapsDisabled()) return null;
  rolloverDailyIfNeeded(nowMs);
  if (nowMs < riskState.cooldownUntilMs) {
    const remainingS = Math.ceil((riskState.cooldownUntilMs - nowMs) / 1000);
    return `cooldown ${remainingS}s (after ${riskState.consecutiveLosses} losses)`;
  }
  const dailyLimit = bankrollBaseline() * MAX_DAILY_LOSS_PCT;
  if (riskState.dailyLossUsd >= dailyLimit) {
    return `daily loss $${riskState.dailyLossUsd.toFixed(2)} ≥ $${dailyLimit.toFixed(2)}`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Probability model
// ---------------------------------------------------------------------------

// N(0,1) CDF — Abramowitz & Stegun 26.2.17, ~7.5e-8 max error.
function normCdf(x: number): number {
  const absX = Math.abs(x);
  const t = 1 / (1 + 0.2316419 * absX);
  const d = 0.3989422804014327 * Math.exp(-(absX * absX) / 2);
  const p =
    d *
    t *
    (0.319381530 +
      t *
        (-0.356563782 +
          t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? 1 - p : p;
}

function estimateWinProb(params: {
  gap: number;
  side: "UP" | "DOWN";
  remainingSecs: number;
  openPrice: number;
}): number {
  const { gap, side, remainingSecs, openPrice } = params;
  if (remainingSecs <= 0) {
    if (side === "UP") return gap > 0 ? 1 : 0;
    return gap < 0 ? 1 : 0;
  }
  const gapBps = (gap / openPrice) * 10_000;
  const signedBps = side === "UP" ? gapBps : -gapBps;
  const sigma = btcSigma() * Math.sqrt(remainingSecs);
  if (sigma <= 0) return signedBps > 0 ? 1 : 0;
  return normCdf(signedBps / sigma);
}

// ---------------------------------------------------------------------------
// Entry gate
// ---------------------------------------------------------------------------

function checkEntry(params: {
  remainingSecs: number;
  spot: number;
  openPrice: number;
  divergence: number | null;
  up: { price: number; liquidity: number } | null;
  down: { price: number; liquidity: number } | null;
  feeBps: (side: "UP" | "DOWN") => number;
  bankroll: number;
}):
  | { entered: true; signal: EntrySignal }
  | { entered: false; reason: string } {
  const { remainingSecs, spot, openPrice, up, down, feeBps, bankroll } = params;
  const divergence = params.divergence ?? Infinity;

  if (remainingSecs < MIN_ENTRY_REMAINING_SECS) {
    return {
      entered: false,
      reason: `too close to end (${remainingSecs}s < ${MIN_ENTRY_REMAINING_SECS}s)`,
    };
  }
  if (remainingSecs > MAX_ENTRY_REMAINING_SECS) {
    return {
      entered: false,
      reason: `too early (${remainingSecs}s > ${MAX_ENTRY_REMAINING_SECS}s)`,
    };
  }
  if (divergence > MAX_FEED_DIVERGENCE_USD) {
    return {
      entered: false,
      reason: `feed divergence $${divergence.toFixed(2)} > $${MAX_FEED_DIVERGENCE_USD}`,
    };
  }

  const gap = spot - openPrice;
  if (gap === 0) return { entered: false, reason: "no directional gap" };
  const side: "UP" | "DOWN" = gap > 0 ? "UP" : "DOWN";

  const info = side === "UP" ? up : down;
  if (!info) return { entered: false, reason: `no ${side} book data` };
  if (info.price < ENTRY_PRICE_MIN) {
    return {
      entered: false,
      reason: `ask ${info.price.toFixed(3)} < min ${ENTRY_PRICE_MIN}`,
    };
  }
  if (info.price > ENTRY_PRICE_MAX) {
    return {
      entered: false,
      reason: `ask ${info.price.toFixed(3)} > max ${ENTRY_PRICE_MAX}`,
    };
  }
  if (info.liquidity < MIN_LIQUIDITY_USD) {
    return {
      entered: false,
      reason: `liquidity $${info.liquidity.toFixed(0)} < $${MIN_LIQUIDITY_USD}`,
    };
  }

  const trueProb = estimateWinProb({ gap, side, remainingSecs, openPrice });
  if (trueProb < MIN_TRUE_PROB) {
    return {
      entered: false,
      reason: `P(win)=${(trueProb * 100).toFixed(1)}% < ${(MIN_TRUE_PROB * 100).toFixed(0)}%`,
    };
  }

  // EV after buy-side fees, per dollar staked.
  const feeRatio = feeBps(side) / 10_000;
  const effectiveCost = info.price * (1 + feeRatio);
  const evPerDollar =
    (trueProb * (1 - effectiveCost) - (1 - trueProb) * effectiveCost) /
    effectiveCost;
  if (evPerDollar < MIN_EV_AFTER_FEES) {
    return {
      entered: false,
      reason: `EV ${(evPerDollar * 100).toFixed(2)}% < ${(MIN_EV_AFTER_FEES * 100).toFixed(1)}% (P=${(trueProb * 100).toFixed(1)}%, ask=${info.price.toFixed(3)}, fee=${feeBps(side)}bps)`,
    };
  }

  // Kelly fraction on raw book price (before fees). Fractional-Kelly for safety.
  const b = (1 - info.price) / info.price;
  const fStar = (trueProb * b - (1 - trueProb)) / b;
  if (fStar <= 0) return { entered: false, reason: "Kelly non-positive" };

  const kellyRiskUsd = bankroll * fStar * KELLY_FRACTION;
  const targetRiskUsd = Math.min(
    kellyRiskUsd,
    MAX_RISK_PER_TRADE_USD,
    info.liquidity * MAX_TOP_LEVEL_SHARE,
  );
  if (targetRiskUsd < MIN_ORDER_USD) {
    return {
      entered: false,
      reason: `sized risk $${targetRiskUsd.toFixed(2)} < min $${MIN_ORDER_USD}`,
    };
  }

  const shares = Math.floor((targetRiskUsd / info.price) * 100) / 100;
  if (shares <= 0) return { entered: false, reason: "zero shares after rounding" };

  return {
    entered: true,
    signal: {
      side,
      ask: info.price,
      trueProb,
      edge: evPerDollar,
      shares,
      liquidity: info.liquidity,
    },
  };
}

// ---------------------------------------------------------------------------
// Strategy
// ---------------------------------------------------------------------------

export const lateEntry: Strategy = async (ctx) => {
  // BTC-only guard. The engine routes by MARKET_SYMBOL, but we refuse anyway.
  if (!ctx.slug.toLowerCase().startsWith("btc-")) {
    ctx.log(
      `[${ctx.slug}] late-entry: BTC-only strategy. Refusing to run.`,
      "red",
    );
    return;
  }

  const releaseLock = ctx.hold();
  const slot: SlotState = {
    hasEntered: false,
    position: null,
    exitFiring: false,
    exitReason: null,
    realizedPnl: 0,
    skipBuckets: {},
    lastSkipSummaryMs: Date.now(),
    lastModelEvalMs: 0,
  };

  const bucketize = (reason: string): string => {
    if (reason.startsWith("too close") || reason.startsWith("too early")) return "time-window";
    if (reason.startsWith("feed divergence")) return "divergence";
    if (reason.includes("book data")) return "no-book";
    if (reason === "no directional gap") return "no-gap";
    if (reason.startsWith("ask ")) return "price-band";
    if (reason.startsWith("liquidity")) return "liquidity";
    if (reason.startsWith("P(win)")) return "prob";
    if (reason.startsWith("EV ")) return "ev";
    if (reason.startsWith("Kelly")) return "kelly";
    if (reason.startsWith("sized risk") || reason.startsWith("zero shares")) return "sizing";
    if (reason.startsWith("cooldown") || reason.startsWith("daily loss")) return "circuit-breaker";
    return "other";
  };

  const flushSkipSummary = (nowMs: number) => {
    const entries = Object.entries(slot.skipBuckets);
    if (entries.length === 0) return;
    const total = entries.reduce((s, [, n]) => s + n, 0);
    const parts = entries
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k}:${v}`)
      .join("  ");
    ctx.log(
      `[${ctx.slug}] skip-summary (${total} in ${Math.round((nowMs - slot.lastSkipSummaryMs) / 1000)}s) — ${parts}`,
      "dim",
    );
    slot.skipBuckets = {};
    slot.lastSkipSummaryMs = nowMs;
  };

  const onSellFilled = (exitPrice: number, shares: number) => {
    if (!slot.position) return;
    const pnl = (exitPrice - slot.position.entryPrice) * shares;
    slot.realizedPnl += pnl;
    ctx.log(
      `[${ctx.slug}] SELL filled @ ${exitPrice.toFixed(3)} (${shares}) → ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}`,
      pnl >= 0 ? "green" : "red",
    );
    slot.position = null;
  };

  const postExit = (
    reason: NonNullable<SlotState["exitReason"]>,
    sellPrice: number,
  ) => {
    if (!slot.position || slot.exitFiring) return;
    const pos = slot.position;
    slot.exitFiring = true;
    slot.exitReason = reason;
    ctx.log(
      `[${ctx.slug}] EXIT(${reason}) SELL ${pos.side} ${pos.shares}@${sellPrice.toFixed(3)}`,
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
        onFilled(filled) {
          onSellFilled(sellPrice, filled);
        },
        onExpired() {
          ctx.log(
            `[${ctx.slug}] EXIT(${reason}) expired — lifecycle will emergency-sell`,
            "red",
          );
          slot.exitFiring = false;
        },
        onFailed(why) {
          ctx.log(`[${ctx.slug}] EXIT(${reason}) failed: ${why}`, "red");
          slot.exitFiring = false;
        },
      },
    ]);
  };

  const tryExit = (nowMs: number) => {
    if (!slot.position || slot.exitFiring) return;
    const pos = slot.position;
    const remainingSecs = Math.floor((ctx.slotEndMs - nowMs) / 1000);

    const bidInfo = ctx.orderBook.bestBidInfo(pos.side);
    const askInfo = ctx.orderBook.bestAskInfo(pos.side);
    const fallbackSell = () => {
      const bid = bidInfo?.price ?? pos.entryPrice - 0.05;
      const ask = askInfo?.price ?? bid + 0.01;
      return Math.max(bid, ask - 0.01);
    };

    if (ctx.ticker.isKillswitch || ctx.ticker.isWhaleDump) {
      const sinceFillSecs = (nowMs - pos.filledAtMs) / 1000;
      if (sinceFillSecs < POST_ENTRY_KILL_GRACE_SECS) {
        // Within grace window — the divergence is almost certainly the same
        // spot move that generated our entry. Don't cut.
        ctx.logEvent("kill_suppressed", {
          sinceFillSecs,
          isKillswitch: ctx.ticker.isKillswitch,
          isWhaleDump: ctx.ticker.isWhaleDump,
          divergence: ctx.ticker.divergence,
        });
      } else {
        const reason = ctx.ticker.isKillswitch ? "kill-div" : "kill-whale";
        postExit(reason, fallbackSell());
        return;
      }
    }

    if (remainingSecs <= TIME_STOP_SECS) {
      postExit("time", fallbackSell());
      return;
    }

    const marketResult = ctx.getMarketResult();
    const openPrice = marketResult?.openPrice;
    const spot = ctx.ticker.price;
    if (openPrice != null && spot != null) {
      const gap = spot - openPrice;
      const probNow = estimateWinProb({
        gap,
        side: pos.side,
        remainingSecs,
        openPrice,
      });
      if (probNow < STOP_LOSS_PROB) {
        postExit("sl", fallbackSell());
        return;
      }
    }
  };

  const interval = setInterval(() => {
    const nowMs = Date.now();
    const remaining = Math.floor((ctx.slotEndMs - nowMs) / 1000);
    if (remaining <= 0) {
      flushSkipSummary(nowMs);
      clearInterval(interval);
      return;
    }
    if (remaining <= 5 && !slot.position) {
      flushSkipSummary(nowMs);
      clearInterval(interval);
      releaseLock();
      return;
    }

    if (slot.position) {
      tryExit(nowMs);
      return;
    }
    if (slot.hasEntered) return;

    if (nowMs - slot.lastSkipSummaryMs >= SKIP_SUMMARY_INTERVAL_MS) {
      flushSkipSummary(nowMs);
    }

    const breaker = circuitBreakerReason(nowMs);
    if (breaker) {
      slot.skipBuckets[bucketize(breaker)] = (slot.skipBuckets[bucketize(breaker)] ?? 0) + 1;
      return;
    }

    const marketResult = ctx.getMarketResult();
    const openPrice = marketResult?.openPrice;
    const spot = ctx.ticker.price;
    if (openPrice == null || spot == null) return;

    const up = ctx.orderBook.bestAskInfo("UP");
    const down = ctx.orderBook.bestAskInfo("DOWN");

    // Periodic structured snapshot of model state for retrospective analysis.
    if (nowMs - slot.lastModelEvalMs >= MODEL_EVAL_LOG_INTERVAL_MS) {
      slot.lastModelEvalMs = nowMs;
      const gap = spot - openPrice;
      const gapBps = (gap / openPrice) * 10_000;
      const candidateSide: "UP" | "DOWN" = gap >= 0 ? "UP" : "DOWN";
      const trueProb = estimateWinProb({
        gap,
        side: candidateSide,
        remainingSecs: remaining,
        openPrice,
      });
      const candidate = candidateSide === "UP" ? up : down;
      const feeRatio = candidate
        ? ctx.orderBook.getFeeRate(ctx.orderBook.getTokenId(candidateSide)) / 10_000
        : null;
      const ev =
        candidate && feeRatio !== null
          ? (() => {
              const eff = candidate.price * (1 + feeRatio);
              return (trueProb * (1 - eff) - (1 - trueProb) * eff) / eff;
            })()
          : null;
      ctx.logEvent("model_eval", {
        remainingSecs: remaining,
        spot,
        openPrice,
        gap,
        gapBps,
        side: candidateSide,
        ask: candidate?.price ?? null,
        liquidityUsd: candidate?.liquidity ?? null,
        bestBidUp: ctx.orderBook.bestBidInfo("UP")?.price ?? null,
        bestBidDown: ctx.orderBook.bestBidInfo("DOWN")?.price ?? null,
        bestAskUp: up?.price ?? null,
        bestAskDown: down?.price ?? null,
        trueProb,
        ev,
        divergence: ctx.ticker.divergence,
        feeBps: candidate
          ? ctx.orderBook.getFeeRate(ctx.orderBook.getTokenId(candidateSide))
          : null,
        thresholds: {
          minTrueProb: MIN_TRUE_PROB,
          minEv: MIN_EV_AFTER_FEES,
          entryPriceMin: ENTRY_PRICE_MIN,
          entryPriceMax: ENTRY_PRICE_MAX,
          minLiquidityUsd: MIN_LIQUIDITY_USD,
        },
      });
    }

    const result = checkEntry({
      remainingSecs: remaining,
      spot,
      openPrice,
      divergence: ctx.ticker.divergence,
      up,
      down,
      feeBps: (side) => ctx.orderBook.getFeeRate(ctx.orderBook.getTokenId(side)),
      bankroll: bankrollBaseline(),
    });

    if (!result.entered) {
      const bucket = bucketize(result.reason);
      slot.skipBuckets[bucket] = (slot.skipBuckets[bucket] ?? 0) + 1;
      return;
    }

    const { signal } = result;
    slot.hasEntered = true;
    flushSkipSummary(nowMs);
    ctx.logEvent("entry", {
      side: signal.side,
      ask: signal.ask,
      shares: signal.shares,
      trueProb: signal.trueProb,
      edge: signal.edge,
      liquidity: signal.liquidity,
      remainingSecs: remaining,
    });
    const tokenId = ctx.orderBook.getTokenId(signal.side);

    ctx.log(
      `[${ctx.slug}] ENTRY ${signal.side} ${signal.shares}@${signal.ask.toFixed(3)} ` +
        `P=${(signal.trueProb * 100).toFixed(1)}% edge=${(signal.edge * 100).toFixed(2)}% ` +
        `liq=$${signal.liquidity.toFixed(0)}`,
      "cyan",
    );

    ctx.postOrders([
      {
        req: {
          tokenId,
          action: "buy",
          price: signal.ask,
          shares: signal.shares,
          orderType: "FOK",
        },
        expireAtMs: ctx.slotEndMs,
        onFilled(filled) {
          slot.position = {
            side: signal.side,
            tokenId,
            entryPrice: signal.ask,
            shares: filled,
            filledAtMs: Date.now(),
          };
          ctx.log(
            `[${ctx.slug}] BUY filled ${filled}@${signal.ask.toFixed(3)}`,
            "green",
          );
        },
        onExpired() {
          ctx.log(`[${ctx.slug}] BUY expired — no fill`, "yellow");
        },
        onFailed(why) {
          ctx.log(`[${ctx.slug}] BUY failed: ${why}`, "red");
        },
      },
    ]);
  }, 100);

  return () => {
    clearInterval(interval);
    if (!slot.hasEntered) return;

    const marketResult = ctx.getMarketResult();
    const pos = slot.position;
    let finalPnl = slot.realizedPnl;
    if (
      pos &&
      marketResult?.openPrice != null &&
      marketResult?.closePrice != null
    ) {
      const won =
        (marketResult.closePrice > marketResult.openPrice) ===
        (pos.side === "UP");
      const settlement = won ? 1.0 - pos.entryPrice : -pos.entryPrice;
      finalPnl += settlement * pos.shares;
    }

    recordOutcome(finalPnl);
    ctx.log(
      `[${ctx.slug}] slot-PnL ${finalPnl >= 0 ? "+" : ""}$${finalPnl.toFixed(2)} | ` +
        `streak=${riskState.consecutiveLosses} dailyLoss=$${riskState.dailyLossUsd.toFixed(2)}`,
      finalPnl >= 0 ? "green" : "red",
    );
  };
};
