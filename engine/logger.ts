import { appendFileSync, mkdirSync } from "fs";
import { join } from "path";

const LOG_JSONL_PATH = join("logs", "late-entry.jsonl");
const TRADE_LEDGER_PATH = join("logs", "trades.jsonl");

// Snapshot cadence. Orderbook on Polymarket binaries doesn't move fast enough
// to justify 1s sampling; 5s captures the shape and slashes log volume by 5x.
const SNAPSHOT_INTERVAL_MS = 5000;
// Only write snapshots in the final N seconds of a slot (strategy entry window
// + buffer). The first ~3 minutes of each slot are pure wait-state with no
// strategy decisions, so capturing them just bloats the log.
const SNAPSHOT_WINDOW_FROM_END_MS = 180_000;

type LogEntry =
  | {
      type: "slot";
      action: "start" | "end";
      slug: string;
      startTime?: number;
      endTime?: number;
    }
  | {
      type: "order";
      orderId?: string;
      action: "buy" | "sell";
      side: string;
      tokenId?: string;
      price: number;
      shares?: number;
      cost?: number;
      status: "placed" | "filled" | "failed" | "expired" | "canceled";
      reason?: string;
    }
  | { type: "info"; msg: string; reason?: string }
  | {
      type: "resolution";
      direction: "UP" | "DOWN";
      openPrice: number;
      closePrice: number;
      unfilledShares: number;
      payout: number;
      pnl: number;
    }
  | {
      type: "strategy";
      event: string;
      [key: string]: unknown;
    };

export class Logger {
  private _slug: string | null = null;
  private _strategyName: string | null = null;
  private _snapshotProvider: (() => object) | null = null;
  private _tickerProvider:
    | (() => {
        btcPrice?: number;
        binancePrice?: number;
        coinbasePrice?: number;
        divergence?: number | null;
      })
    | null = null;
  private _marketResultProvider:
    | (() => { openPrice?: number; gap?: number; priceToBeat?: number })
    | null = null;
  private _snapshotTimer: NodeJS.Timeout | null = null;
  private _slotEndMs: number = 0;

  /** Inject an orderbook snapshot provider — called automatically before every log entry. */
  setSnapshotProvider(fn: () => object) {
    this._snapshotProvider = fn;
  }

  /** Inject a market result provider — emits a market_price entry when openPrice is available. */
  setMarketResultProvider(
    fn: () => { openPrice?: number; gap?: number; priceToBeat?: number },
  ) {
    this._marketResultProvider = fn;
  }

  /** Inject a BTC ticker provider — emits a btc_ticker entry alongside each snapshot. */
  setTickerProvider(
    fn: () => {
      btcPrice?: number;
      binancePrice?: number;
      coinbasePrice?: number;
      divergence?: number | null;
    },
  ) {
    this._tickerProvider = fn;
  }

  startSlot(slug: string, startTime: number, endTime: number, strategyName: string) {
    this._slug = slug;
    this._strategyName = strategyName;
    this._slotEndMs = endTime;
    this._append({ type: "slot", action: "start", slug, startTime, endTime, strategy: strategyName });
    this._writeSnapshot();
    this._snapshotTimer = setInterval(() => this._writeSnapshot(), SNAPSHOT_INTERVAL_MS);
  }

  endSlot(slug: string) {
    if (this._snapshotTimer) {
      clearInterval(this._snapshotTimer);
      this._snapshotTimer = null;
    }
    this._writeSnapshot();
    this._append({ type: "slot", action: "end", slug });
  }

  /** Stop the snapshot timer without writing an end marker. */
  destroy() {
    if (this._snapshotTimer) {
      clearInterval(this._snapshotTimer);
      this._snapshotTimer = null;
    }
    this._slug = null;
    this._strategyName = null;
  }

  /** Log a structured NDJSON entry. Automatically prepends an orderbook snapshot. */
  log(entry: LogEntry) {
    this._writeSnapshot();
    this._append(entry);
  }

  /** Write a standalone orderbook snapshot. */
  snapshot() {
    this._writeSnapshot();
  }

  private _writeSnapshot() {
    if (!this._snapshotProvider) return;
    // Skip snapshots during the wait-state portion of the slot.
    const remainingMs = this._slotEndMs - Date.now();
    if (remainingMs > SNAPSHOT_WINDOW_FROM_END_MS) return;
    this._append({ type: "orderbook_snapshot", ...this._snapshotProvider() });
    const remaining = parseFloat((remainingMs / 1000).toFixed(1));
    this._append({ type: "remaining", seconds: remaining });
    if (this._tickerProvider) {
      this._append({ type: "btc_ticker", ...this._tickerProvider() });
    }
    if (this._marketResultProvider) {
      const data = this._marketResultProvider();
      if (data.openPrice) {
        this._append({ type: "market_price", ...data });
      }
    }
  }

  private _append(entry: object) {
    const payload: Record<string, unknown> = {
      ts: Date.now(),
      slug: this._slug,
      ...entry,
    };

    mkdirSync("logs", { recursive: true });
    appendFileSync(LOG_JSONL_PATH, JSON.stringify(payload) + "\n", "utf8");

    const type = (entry as { type?: string }).type;
    if ((type === "order" || type === "resolution") && this._slug) {
      const asset = this._slug.split("-")[0]?.toUpperCase() ?? "UNKNOWN";
      appendFileSync(
        TRADE_LEDGER_PATH,
        JSON.stringify({
          ...payload,
          asset,
          strategy: this._strategyName,
        }) + "\n",
        "utf8",
      );
    }
  }
}
