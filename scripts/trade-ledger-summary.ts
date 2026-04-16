import { readFileSync } from "fs";
import { join } from "path";

type TradeRow = {
  ts: number;
  type: "order" | "resolution";
  asset?: string;
  slug?: string;
  strategy?: string | null;
  action?: "buy" | "sell";
  side?: string;
  price?: number;
  shares?: number;
  status?: string;
  pnl?: number;
  reason?: string;
};

const path = join("logs", "trades.jsonl");
const raw = readFileSync(path, "utf8").trim();
const rows: TradeRow[] = raw ? raw.split("\n").map((line) => JSON.parse(line)) : [];

const byAsset = new Map<string, { orders: number; fills: number; failed: number; expired: number; canceled: number; resolutions: number; pnl: number }>();

for (const row of rows) {
  const asset = row.asset ?? "UNKNOWN";
  if (!byAsset.has(asset)) {
    byAsset.set(asset, { orders: 0, fills: 0, failed: 0, expired: 0, canceled: 0, resolutions: 0, pnl: 0 });
  }
  const stats = byAsset.get(asset)!;

  if (row.type === "order") {
    stats.orders += 1;
    if (row.status === "filled") stats.fills += 1;
    if (row.status === "failed") stats.failed += 1;
    if (row.status === "expired") stats.expired += 1;
    if (row.status === "canceled") stats.canceled += 1;
  }

  if (row.type === "resolution") {
    stats.resolutions += 1;
    stats.pnl += row.pnl ?? 0;
  }
}

for (const [asset, stats] of [...byAsset.entries()].sort()) {
  console.log(`${asset}: resolutions=${stats.resolutions} pnl=${stats.pnl.toFixed(2)} orders=${stats.orders} fills=${stats.fills} failed=${stats.failed} expired=${stats.expired} canceled=${stats.canceled}`);
}
