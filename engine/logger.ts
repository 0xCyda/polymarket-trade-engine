import { appendFileSync, mkdirSync } from "fs";
import { join } from "path";

const TRADE_LEDGER_PATH = join("logs", "trades.jsonl");

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
    };

function formatSnapshot(data: object): string {
  // Standard pretty print first
  let json = JSON.stringify(data, null, 2);
  // Pass 1: collapse [number, number] pairs onto a single line
  json = json.replace(
    /\[\s*\n\s*([\d.]+),\s*\n\s*([\d.]+)\s*\n\s*\]/g,
    "[ $1, $2 ]",
  );
  // Pass 2: collapse arrays of [ num, num ] pairs onto a single line
  json = json.replace(/\[\s*\n(\s*\[ [\d., ]+ \],?\n)+\s*\]/g, (match) => {
    const pairs = match.match(/\[ [\d., ]+ \]/g) ?? [];
    return "[ " + pairs.join(", ") + " ]";
  });
  return json;
}

export class Logger {
  private _entries: string[] = [];
  private _filePath: string | null = null;
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
    this._entries = [];
    this._slug = slug;
    this._strategyName = strategyName;
    this._slotEndMs = endTime;
    mkdirSync("logs", { recursive: true });
    this._filePath = join("logs", `early-bird-${slug}.log`);
    this._append({ type: "slot", action: "start", slug, startTime, endTime, strategy: strategyName });
    this._writeSnapshot();
    this._snapshotTimer = setInterval(() => this._writeSnapshot(), 1000);
  }

  endSlot(slug: string) {
    if (this._snapshotTimer) {
      clearInterval(this._snapshotTimer);
      this._snapshotTimer = null;
    }
    this._writeSnapshot();
    this._entries.push("");
    this._append({ type: "slot", action: "end", slug });
    this._flush();
  }

  /** Stop the snapshot timer and discard all buffered entries without writing to disk. */
  destroy() {
    if (this._snapshotTimer) {
      clearInterval(this._snapshotTimer);
      this._snapshotTimer = null;
    }
    this._entries = [];
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
    this._entries.push(""); // blank line separator before each snapshot group
    const data = {
      ts: Date.now(),
      type: "orderbook_snapshot",
      ...this._snapshotProvider(),
    };
    this._entries.push(JSON.stringify(data));
    const remaining = parseFloat(
      ((this._slotEndMs - Date.now()) / 1000).toFixed(1),
    );
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
    const payload = { ts: Date.now(), ...entry };
    this._entries.push(JSON.stringify(payload));

    const type = (entry as { type?: string }).type;
    if ((type === "order" || type === "resolution") && this._slug) {
      const asset = this._slug.split("-")[0]?.toUpperCase() ?? "UNKNOWN";
      mkdirSync("logs", { recursive: true });
      appendFileSync(
        TRADE_LEDGER_PATH,
        JSON.stringify({
          ...payload,
          slug: this._slug,
          asset,
          strategy: this._strategyName,
        }) + "\n",
        "utf8",
      );
    }
  }

  private _flush() {
    if (!this._filePath || this._entries.length === 0) return;
    mkdirSync("logs", { recursive: true });
    appendFileSync(this._filePath, this._entries.join("\n") + "\n");
    this._entries = [];
  }
}
