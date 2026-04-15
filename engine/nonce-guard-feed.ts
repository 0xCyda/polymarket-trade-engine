import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { FillEnrichment } from "./client.ts";
import type { PendingOrder } from "./market-lifecycle.ts";

type NonceGuardFillRow = {
  fillId: string;
  timestampMs: number;
  txHash?: string;
  market: string;
  side: "BUY" | "SELL";
  price: number;
  size: number;
  maker?: string;
  taker?: string;
  counterparty?: string;
  meta: Record<string, unknown>;
};

const asAddress = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim().toLowerCase();
  return trimmed || undefined;
};

export class NonceGuardFillFeed {
  private readonly enabled: boolean;

  constructor(private readonly feedPath?: string) {
    this.enabled = Boolean(feedPath);
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  async emit(args: {
    slug: string;
    pending: PendingOrder;
    shares: number;
    fee: number;
    enrichment?: FillEnrichment | null;
  }): Promise<void> {
    if (!this.feedPath || !this.enabled) return;

    const { pending, enrichment, shares, fee, slug } = args;
    const now = Date.now();
    const txHash =
      typeof enrichment?.txHash === "string" ? enrichment.txHash : undefined;
    const maker = asAddress(enrichment?.maker);
    const taker = asAddress(enrichment?.taker);
    const counterparty = asAddress(enrichment?.counterparty);

    const row: NonceGuardFillRow = {
      fillId: pending.orderId,
      timestampMs: now,
      txHash,
      market: slug,
      side: pending.action === "buy" ? "BUY" : "SELL",
      price: pending.price,
      size: shares,
      maker,
      taker,
      counterparty,
      meta: {
        source: "polymarket-trade-engine",
        orderId: pending.orderId,
        tokenId: pending.tokenId,
        orderType: pending.orderType ?? "GTC",
        fee,
        owner: enrichment?.owner,
        traderSide: enrichment?.traderSide,
        tradeCount: enrichment?.trades?.length ?? 0,
        rawTrades: enrichment?.trades ?? [],
      },
    };

    await mkdir(path.dirname(this.feedPath), { recursive: true });
    await appendFile(this.feedPath, `${JSON.stringify(row)}\n`, "utf8");
  }
}

