export type MarketWindow = "5m" | "15m";

export type Config = {
  BTC_TICKER: ("polymarket" | "binance" | "coinbase")[];
  MARKET_WINDOW: MarketWindow;
  PROD: boolean;
  PRIVATE_KEY: string;
  POLY_FUNDER_ADDRESS: string;
};

export class Env {
  private static readonly defaults: Config = {
    BTC_TICKER: ["polymarket", "coinbase"],
    MARKET_WINDOW: "5m",
    PROD: false,
    PRIVATE_KEY: "",
    POLY_FUNDER_ADDRESS: "",
  };

  static get<T extends keyof Config>(key: T): Config[T] {
    const raw = process.env[key];
    const defaultVal = this.defaults[key];

    // No env var set, return default
    if (raw === undefined) return defaultVal;

    // Infer type from default value
    if (typeof defaultVal === "boolean") {
      return (raw === "true") as Config[T];
    }

    if (Array.isArray(defaultVal)) {
      return raw.split(",").map((s) => s.trim()) as Config[T];
    }

    return raw as Config[T];
  }
}
