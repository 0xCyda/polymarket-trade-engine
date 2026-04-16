import { Env } from "../utils/config";
import {
  createReconnectingWs,
  type ReconnectingWs,
} from "../utils/reconnecting-ws";

const COINBASE_WS_URL = "wss://ws-feed.exchange.coinbase.com";
const ASSET_CONFIG = {
  BTC: {
    binanceMarket: "btcusdt",
    coinbaseProduct: "BTC-USD",
    polymarketSymbol: "btc/usd",
    label: "BTC",
  },
  SOL: {
    binanceMarket: "solusdt",
    coinbaseProduct: "SOL-USD",
    polymarketSymbol: "sol/usd",
    label: "SOL",
  },
  XRP: {
    binanceMarket: "xrpusdt",
    coinbaseProduct: "XRP-USD",
    polymarketSymbol: "xrp/usd",
    label: "XRP",
  },
} as const;

// Maximum acceptable lag between Binance event time and current time
const MAX_STALENESS_MS = 1000; // 1 second
// Killswitch: abort trading if Binance/Coinbase diverge by more than $50 absolute
const KILLSWITCH_THRESHOLD = 50.0;
// Whale dump: Coinbase diverges from Binance by more than 0.15%
const WHALE_DUMP_THRESHOLD_PCT = 0.0015;

export class TickerTracker {
  private polymarketWs?: ReconnectingWs;
  private binanceWs?: ReconnectingWs;
  private coinbaseWs?: ReconnectingWs;
  private polymarketValue?: number;
  private binanceValue?: number;
  private coinbaseValue?: number;
  private validated = false;
  private readonly asset = ASSET_CONFIG[Env.get("MARKET_SYMBOL")];

  get price() {
    return this.polymarketValue ?? this.binanceValue ?? this.coinbaseValue;
  }

  get coinbasePrice() {
    return this.coinbaseValue;
  }

  get binancePrice() {
    return this.binanceValue;
  }

  // True when Binance/Coinbase diverge by more than $50 — market is structurally broken.
  get isKillswitch(): boolean {
    if (!this.divergence) return false;
    return this.divergence > KILLSWITCH_THRESHOLD;
  }

  // True when Coinbase drops vs Binance by more than 0.15% — whale dump signal.
  get isWhaleDump(): boolean {
    if (!this.price || !this.coinbaseValue) return false;
    return (
      Math.abs(this.coinbaseValue - this.price) >
      this.price * WHALE_DUMP_THRESHOLD_PCT
    );
  }

  get divergence(): number | null {
    if (!this.price || !this.coinbaseValue) return null;
    return Math.abs(this.coinbaseValue - this.price);
  }

  /** Resolves once every stream configured in BTC_TICKER has received its first price. */
  waitForReady(): Promise<void> {
    return new Promise<void>((resolve) => {
      const streams = Env.get("BTC_TICKER");
      const isReady = () =>
        (streams.indexOf("polymarket") === -1 ||
          this.polymarketValue !== undefined) &&
        (streams.indexOf("binance") === -1 ||
          this.binanceValue !== undefined) &&
        (streams.indexOf("coinbase") === -1 ||
          this.coinbaseValue !== undefined);
      if (isReady()) {
        resolve();
        return;
      }
      const interval = setInterval(() => {
        if (isReady()) {
          clearInterval(interval);
          resolve();
        }
      }, 100);
    });
  }

  schedule() {
    this.destroy();
    this.validated = false;

    const streams = Env.get("BTC_TICKER");
    if (streams.indexOf("polymarket") != -1) {
      this.connectPolymarket();
    }
    if (streams.indexOf("binance") != -1) {
      this.connectBinance();
    }
    if (streams.indexOf("coinbase") != -1) {
      this.connectCoinbase();
    }
  }

  private connectBinance() {
    const wsUrl = `wss://stream.binance.com:9443/ws/${this.asset.binanceMarket}@ticker`;
    this.binanceWs = createReconnectingWs({
      url: wsUrl,
      label: `${this.asset.label} Binance`,
      onmessage: (event) => {
        if (!event.data) return;
        const json = JSON.parse(event.data as string);
        const price = parseFloat(json.c); // "c" = last price
        if (!price) return;

        if (!this.validated) {
          this.validated = true;
          const eventTime: number = json.E; // "E" = event time ms
          if (eventTime) {
            const lagMs = Date.now() - eventTime;
            if (lagMs > MAX_STALENESS_MS) {
              const lagSec = Math.round(lagMs / 1000);
              console.error(
                `[${this.asset.label} Feed] Binance price feed is stale: event is ${lagSec}s behind current time (max allowed: ${MAX_STALENESS_MS / 1000}s). Exiting.`,
              );
              process.exit(1);
            }
          }
        }

        this.binanceValue = price;
      },
      onerror: (err) => console.error("Binance WS error:", err),
    });
  }

  private connectCoinbase() {
    this.coinbaseWs = createReconnectingWs({
      url: COINBASE_WS_URL,
      label: "Coinbase",
      onopen: (ws) => {
        ws.send(
          JSON.stringify({
            type: "subscribe",
            product_ids: [this.asset.coinbaseProduct],
            channels: ["ticker"],
          }),
        );
      },
      onmessage: (event) => {
        if (!event.data) return;
        const json = JSON.parse(event.data as string);
        if (json.type !== "ticker") return;
        const price = parseFloat(json.price);
        if (!price) return;
        this.coinbaseValue = price;
      },
      onerror: (err) => console.error("Coinbase WS error:", err),
    });
  }

  private connectPolymarket() {
    const WS_URL = "wss://ws-live-data.polymarket.com";
    const market = this.asset.polymarketSymbol;

    this.polymarketWs = createReconnectingWs({
      url: WS_URL,
      label: `${this.asset.label} Polymarket`,
      onopen: (ws) => {
        ws.send(
          JSON.stringify({
            action: "subscribe",
            subscriptions: [
              {
                topic: "crypto_prices_chainlink",
                type: "update",
                filters: JSON.stringify({ symbol: market }),
              },
            ],
          }),
        );
      },
      onmessage: (event) => {
        if (!event.data) return;
        const json = JSON.parse(event.data as string);
        const price: number = json.payload?.value;
        if (!price) return;

        if (!this.validated) {
          this.validated = true;
          const eventTime: number = json.timestamp; // top-level timestamp ms
          if (eventTime) {
            const lagMs = Date.now() - eventTime;
            if (lagMs > MAX_STALENESS_MS) {
              const lagSec = Math.round(lagMs / 1000);
              console.error(
                `[${this.asset.label} Feed] Polymarket price feed is stale: event is ${lagSec}s behind current time (max allowed: ${MAX_STALENESS_MS / 1000}s). Exiting.`,
              );
              process.exit(1);
            }
          }
        }

        this.polymarketValue = price;
      },
      // Polymarket WS error: {"isTrusted":true}
      onerror: (err) =>
        console.error(
          "Polymarket WS error:",
          JSON.stringify(err) + "\n\n\n\n\n",
        ),
    });
  }

  format(): string | null {
    const parts: string[] = [];
    if (this.binanceValue !== undefined)
      parts.push(`Binance: $${this.binanceValue.toLocaleString()}`);
    if (this.coinbaseValue !== undefined)
      parts.push(`Coinbase: $${this.coinbaseValue.toLocaleString()}`);
    if (this.divergence !== null)
      parts.push(`Divergence: $${this.divergence.toFixed(2)}`);
    if (this.isWhaleDump) parts.push(`\x1b[31mWhale Dump\x1b[0m`);
    return parts.length > 0 ? parts.join("  |  ") : null;
  }

  destroy() {
    this.polymarketWs?.destroy();
    this.polymarketWs = undefined;
    this.binanceWs?.destroy();
    this.binanceWs = undefined;
    this.coinbaseWs?.destroy();
    this.coinbaseWs = undefined;
  }
}
