// Buy and Hold strategy

import type { Strategy, StrategyContext } from "./types.ts";
import { Env } from "../../utils/config.ts";

class RSI {
  private _period: number;
  private _prev: number | null = null;
  private _avgGain: number | null = null;
  private _avgLoss: number | null = null;
  private _seedGains: number[] = [];
  private _seedLosses: number[] = [];
  private _value: number | null = null;

  constructor(period = 14) {
    this._period = period;
  }

  update(value: number): number | null {
    if (this._prev === null) {
      this._prev = value;
      return null;
    }

    const delta = value - this._prev;
    this._prev = value;

    const gain = delta > 0 ? delta : 0;
    const loss = delta < 0 ? -delta : 0;

    if (this._avgGain === null) {
      this._seedGains.push(gain);
      this._seedLosses.push(loss);

      if (this._seedGains.length >= this._period) {
        this._avgGain =
          this._seedGains.reduce((s, v) => s + v, 0) / this._period;
        this._avgLoss =
          this._seedLosses.reduce((s, v) => s + v, 0) / this._period;
        this._value = this._computeRsi(this._avgGain, this._avgLoss);
      }
      return this._value;
    }

    this._avgGain = (this._avgGain * (this._period - 1) + gain) / this._period;
    this._avgLoss = (this._avgLoss! * (this._period - 1) + loss) / this._period;
    this._value = this._computeRsi(this._avgGain, this._avgLoss!);
    return this._value;
  }

  get value(): number | null {
    return this._value;
  }

  private _computeRsi(avgGain: number, avgLoss: number): number {
    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return 100 - 100 / (1 + rs);
  }
}

class ATR {
  private _period: number;
  private _prev: number | null = null;
  private _avgTr: number | null = null;
  private _seedTrs: number[] = [];
  private _value: number | null = null;

  constructor(period = 14) {
    this._period = period;
  }

  update(price: number): number | null {
    if (this._prev === null) {
      this._prev = price;
      return null;
    }

    const tr = Math.abs(price - this._prev);
    this._prev = price;

    if (this._avgTr === null) {
      this._seedTrs.push(tr);
      if (this._seedTrs.length >= this._period) {
        this._avgTr = this._seedTrs.reduce((s, v) => s + v, 0) / this._period;
        this._value = this._avgTr;
      }
      return this._value;
    }

    this._avgTr = (this._avgTr * (this._period - 1) + tr) / this._period;
    this._value = this._avgTr;
    return this._value;
  }

  get value(): number | null {
    return this._value;
  }

  gapSafety(gap: number): number | null {
    if (!this._value) return null;
    return Math.abs(gap) / this._value;
  }
}

class RTV {
  private _window: number;
  private _prices: number[] = [];
  private _value: number | null = null;

  constructor(window = 30) {
    this._window = window;
  }

  update(price: number): void {
    this._prices.push(price);

    if (this._prices.length > this._window + 1) {
      this._prices.shift();
    }

    if (this._prices.length < 3) {
      this._value = null;
      return;
    }

    let sum = 0;
    for (let i = 1; i < this._prices.length; i++) {
      sum += Math.abs(this._prices[i]! - this._prices[i - 1]!);
    }
    this._value = sum / (this._prices.length - 1);
  }

  get value(): number | null {
    return this._value;
  }
}

class Indicators {
  private _rsi = new RSI(14);
  private _atr = new ATR(14);
  private _rtv = new RTV(30);
  private _peakAbsGap = 0;
  private _lastUpdate = 0;

  tick(gap: number | null, btcPrice: number | undefined): void {
    const now = Date.now();
    if (now - this._lastUpdate < 1000) return;
    this._lastUpdate = now;
    if (gap !== null) {
      this._rsi.update(gap);
      if (this._atr.value !== null) {
        const absGap = Math.abs(gap);
        if (absGap > this._peakAbsGap) this._peakAbsGap = absGap;
      }
    }
    if (btcPrice !== undefined) {
      this._atr.update(btcPrice);
      this._rtv.update(btcPrice);
    }
  }

  get rsi(): number | null {
    return this._rsi.value;
  }

  get atr(): number | null {
    return this._atr.value;
  }

  get rtv(): number | null {
    return this._rtv.value;
  }

  peakGapRatio(gap: number): number | null {
    if (this._peakAbsGap === 0) return null;
    return Math.abs(gap) / this._peakAbsGap;
  }

  gapSafety(gap: number): number | null {
    if (!gap) return null;
    return this._atr.gapSafety(gap);
  }
}

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
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SHARES = 6;
const MIN_ENTRY_REMAINING_SECS = 18;
const MAX_ENTRY_REMAINING_SECS = 70;
const MIN_ATR = 0.5;
const MAX_ATR = 1.4;
const MIN_GAP_SAFETY = 50;
const MAX_DIVERGENCE = 6;
const MIN_PEAK_GAP_RATIO = 0.85;
const MIN_ABS_GAP = 25;
const MAX_ABS_GAP = 140;
const MIN_LIQUIDITY = 100;
const VALUE_ENTRY_MIN = 0.86;
const VALUE_ENTRY_MAX = 0.95;
const CERTAINTY_ENTRY_MIN = 0.985;
const CERTAINTY_ENTRY_MAX = 0.995;
const CERTAINTY_MIN_REMAINING_SECS = 20;
const CERTAINTY_MAX_REMAINING_SECS = 35;
const CERTAINTY_LIQUIDITY_FLOOR = 1500;
const CERTAINTY_MAX_DIVERGENCE = 2.5;
const CERTAINTY_MIN_GAP_SAFETY = 90;
const CERTAINTY_MIN_PEAK_GAP_RATIO = 0.95;
const MID_RANGE_ENTRY_MIN = 0.95;
const MID_RANGE_ENTRY_MAX = 0.98;
const BASE_STOP_LOSS_PRICE = 0.72;
const HARD_STOP_LOSS_BUFFER = 0.08;
const SOFT_STOP_LOSS_BUFFER = 0.05;
const RSI_UP_CONFIRM = 58;
const RSI_DOWN_CONFIRM = 42;

function checkEntry(params: {
  remaining: number;
  btcPrice: number;
  priceToBeat: number;
  up: { price: number; liquidity: number } | null;
  down: { price: number; liquidity: number } | null;
  rsi: number | null;
  atr: number | null;
  rtv: number | null;
  gapSafety: number | null;
  divergence: number | null;
  peakGapRatio: number | null;
}): EntrySignal | null {
  const {
    remaining,
    btcPrice,
    priceToBeat,
    up,
    down,
    rsi,
    atr,
    rtv,
    gapSafety,
    peakGapRatio,
  } = params;

  if (
    remaining < MIN_ENTRY_REMAINING_SECS ||
    remaining > MAX_ENTRY_REMAINING_SECS
  ) {
    return null;
  }

  const gap = btcPrice - priceToBeat;
  const absGap = Math.abs(gap);
  const divergence = params.divergence ?? Infinity;

  if (absGap < MIN_ABS_GAP || absGap > MAX_ABS_GAP) {
    return null;
  }

  if (
    !atr ||
    atr < MIN_ATR ||
    atr > MAX_ATR ||
    !gapSafety ||
    gapSafety < MIN_GAP_SAFETY ||
    divergence > MAX_DIVERGENCE ||
    !peakGapRatio ||
    peakGapRatio < MIN_PEAK_GAP_RATIO ||
    rtv === null
  ) {
    return null;
  }

  const side: "UP" | "DOWN" = gap > 0 ? "UP" : "DOWN";
  const info = side === "UP" ? up : down;
  if (!info) return null;

  const rsiConfirmsDirection =
    rsi !== null &&
    (side === "UP" ? rsi >= RSI_UP_CONFIRM : rsi <= RSI_DOWN_CONFIRM);
  if (!rsiConfirmsDirection) {
    return null;
  }

  if (info.liquidity < MIN_LIQUIDITY) {
    return null;
  }

  const inValueZone =
    info.price >= VALUE_ENTRY_MIN && info.price <= VALUE_ENTRY_MAX;
  const inMidRangeDeadZone =
    info.price > MID_RANGE_ENTRY_MIN && info.price < MID_RANGE_ENTRY_MAX;
  const inCertaintyZone =
    info.price >= CERTAINTY_ENTRY_MIN && info.price <= CERTAINTY_ENTRY_MAX;

  if (inMidRangeDeadZone) {
    return null;
  }

  if (inValueZone) {
    return {
      side,
      ask: info.price,
      gap: absGap,
      liquidity: info.liquidity,
      stopLossPrice: Math.max(BASE_STOP_LOSS_PRICE, info.price - SOFT_STOP_LOSS_BUFFER),
    };
  }

  if (
    inCertaintyZone &&
    remaining >= CERTAINTY_MIN_REMAINING_SECS &&
    remaining <= CERTAINTY_MAX_REMAINING_SECS &&
    info.liquidity >= CERTAINTY_LIQUIDITY_FLOOR &&
    divergence <= CERTAINTY_MAX_DIVERGENCE &&
    gapSafety >= CERTAINTY_MIN_GAP_SAFETY &&
    peakGapRatio >= CERTAINTY_MIN_PEAK_GAP_RATIO
  ) {
    return {
      side,
      ask: info.price,
      gap: absGap,
      liquidity: info.liquidity,
      stopLossPrice: Math.max(0.9, info.price - HARD_STOP_LOSS_BUFFER),
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Order placement helpers
// ---------------------------------------------------------------------------

function placeEntry(
  ctx: StrategyContext,
  state: LateEntryState,
  signal: EntrySignal,
): void {
  const tokenId =
    signal.side === "UP" ? ctx.clobTokenIds[0] : ctx.clobTokenIds[1];

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
          `[${ctx.slug}] late-entry: BUY ${signal.side} filled @ ${signal.ask} (${filledShares} shares)`,
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
  rsi: number | null,
): void {
  const pos = state.position;
  if (!pos) return;

  const bestAsk = ctx.orderBook.bestAskInfo(pos.side)?.price ?? null;
  const bestBid = ctx.orderBook.bestBidPrice(pos.side);
  if (bestAsk === null) return;

  const gapConfirmsPosition =
    gap !== null &&
    ((pos.side === "UP" && gap > 10) || (pos.side === "DOWN" && gap < -10));
  const rsiConfirmsMomentum =
    rsi !== null &&
    (pos.side === "UP" ? rsi >= RSI_UP_CONFIRM : rsi <= RSI_DOWN_CONFIRM);

  const valueZonePosition = pos.entryPrice <= VALUE_ENTRY_MAX;
  const certaintyZonePosition = pos.entryPrice >= CERTAINTY_ENTRY_MIN;

  const hardStopHit = bestAsk <= pos.stopLossPrice;
  const softStopHit =
    valueZonePosition && remaining <= 55 && bestAsk <= pos.entryPrice - SOFT_STOP_LOSS_BUFFER;
  const certaintyStopHit =
    certaintyZonePosition && remaining <= 30 && bestAsk <= pos.entryPrice - 0.03;

  const shouldSell =
    ((hardStopHit || softStopHit || certaintyStopHit) &&
      !gapConfirmsPosition &&
      !rsiConfirmsMomentum) ||
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
  // ── Prod guard ────────────────────────────────────────────────────────────
  // This strategy is specially designed for simulation only. If you still
  // want to run it in production, remove this guard and make the necessary
  // changes to the strategy logic as per your needs.
  if (Env.get("PROD")) {
    ctx.log(
      "[late-entry] This strategy is specially designed for simulation only. " +
        "If you still want to run it in production, remove this guard and make " +
        "the necessary changes to the strategy logic as per your needs.",
      "red",
    );
    process.exit(1);
  }

  // ── ctx.hold() ────────────────────────────────────────────────────────────
  // By default, the engine transitions out of RUNNING as soon as the strategy
  // function returns. Since this strategy is event-driven (it reacts to price
  // ticks over the life of the market), we need to keep the lifecycle in
  // RUNNING until we are truly done.
  //
  // ctx.hold() increments an internal counter and returns a release function.
  // The lifecycle will not exit RUNNING until every active hold has been
  // released. Call release() exactly once when your strategy has no more work
  // to do (position closed, stop-loss fired, or time ran out). Forgetting to
  // call it will cause the engine to hang after the market closes.
  const releaseLock = ctx.hold();

  const state: LateEntryState = {
    hasEntered: false,
    position: null,
    stopLossFired: false,
  };
  const indicators = new Indicators();

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

    const priceToBeat = ctx.getMarketResult()?.openPrice ?? null;
    if (!priceToBeat) return;

    const btcPrice = ctx.ticker.price;
    const gap = btcPrice !== undefined ? btcPrice - priceToBeat : null;

    indicators.tick(gap, btcPrice);

    if (!state.hasEntered) {
      const up = ctx.orderBook.bestAskInfo("UP");
      const down = ctx.orderBook.bestAskInfo("DOWN");

      if (btcPrice !== undefined) {
        const signal = checkEntry({
          remaining,
          btcPrice,
          priceToBeat,
          up,
          down,
          rsi: indicators.rsi,
          atr: indicators.atr,
          rtv: indicators.rtv,
          gapSafety: gap !== null ? indicators.gapSafety(gap) : null,
          divergence: ctx.ticker.divergence,
          peakGapRatio: gap !== null ? indicators.peakGapRatio(gap) : null,
        });

        if (signal) {
          state.hasEntered = true;
          ctx.log(
            `[${ctx.slug}] late-entry: signal ${signal.side} @ ${signal.ask} (gap ${signal.gap.toFixed(0)}, liq $${signal.liquidity.toFixed(0)})`,
            "cyan",
          );
          placeEntry(ctx, state, signal);
        }
      }
    }

    if (state.position && !state.stopLossFired) {
      checkStopLoss(ctx, state, remaining, gap, indicators.rsi);
    }
  }, 0);
};
