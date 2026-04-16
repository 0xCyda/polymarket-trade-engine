import { APIQueue } from "../tracker/api-queue.ts";
import { OrderBook } from "../tracker/orderbook.ts";
import { getSlug } from "../utils/slot.ts";
import { PolymarketEarlyBirdClient } from "../engine/client.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Side = "UP" | "DOWN";

async function main() {
  const symbol = (process.argv[2] ?? "BTC").toUpperCase();
  if (!["BTC", "ETH", "SOL", "XRP"].includes(symbol)) {
    throw new Error(`Unsupported symbol: ${symbol}`);
  }

  process.env.MARKET_SYMBOL = symbol;

  const slug = getSlug(0);
  const apiQueue = new APIQueue();
  await apiQueue.queueEventDetails(slug);
  const event = apiQueue.eventDetails.get(slug);
  if (!event?.markets?.[0]) throw new Error(`No market found for ${slug}`);

  const market = event.markets[0];
  const [upTokenId, downTokenId] = JSON.parse(market.clobTokenIds) as [string, string];

  const orderBook = new OrderBook();
  orderBook.subscribe([upTokenId, downTokenId]);
  await orderBook.waitForReady();
  await sleep(1500);

  const sides: Array<{
    side: Side;
    tokenId: string;
    ask: number;
    bid: number;
    askLiquidity: number;
    bidLiquidity: number;
    spread: number;
  }> = [];

  for (const side of ["UP", "DOWN"] as const) {
    const ask = orderBook.bestAskInfo(side);
    const bid = orderBook.bestBidInfo(side);
    const tokenId = side === "UP" ? upTokenId : downTokenId;
    if (!ask || !bid) continue;
    sides.push({
      side,
      tokenId,
      ask: ask.price,
      bid: bid.price,
      askLiquidity: ask.liquidity,
      bidLiquidity: bid.liquidity,
      spread: ask.price - bid.price,
    });
  }

  if (sides.length === 0) throw new Error("No live book on either side");

  const candidate = sides
    .filter((s) => s.askLiquidity >= 1 && s.bidLiquidity >= 1)
    .sort((a, b) => a.spread - b.spread || a.ask - b.ask)[0] ?? sides.sort((a, b) => a.spread - b.spread)[0]!;

  const shares = 1;
  const tickSize = orderBook.getTickSize(candidate.tokenId);
  const feeRateBps = orderBook.getFeeRate(candidate.tokenId);

  const client = new PolymarketEarlyBirdClient();
  await client.init();
  const balanceBefore = await client.getUSDCBalance();

  const buyResp = await client.postMultipleOrders([
    {
      tokenId: candidate.tokenId,
      action: "buy",
      price: candidate.ask,
      shares,
      tickSize,
      feeRateBps,
      negRisk: false,
      orderType: "FOK",
    },
  ]);
  const buy = buyResp[0];
  if (!buy?.success || !buy.orderId) {
    throw new Error(`Buy failed: ${buy?.errorMsg ?? "unknown"}`);
  }

  let buyOrder = await client.getOrderById(buy.orderId);
  for (let i = 0; i < 20 && (!buyOrder || buyOrder.status !== "filled"); i++) {
    await sleep(500);
    buyOrder = await client.getOrderById(buy.orderId);
  }
  if (!buyOrder || buyOrder.status !== "filled") {
    throw new Error(`Buy did not fill: ${JSON.stringify(buyOrder)}`);
  }

  let availableShares = 0;
  for (let i = 0; i < 20; i++) {
    await client.updateAvailableShares(candidate.tokenId).catch(() => {});
    availableShares = await client.getAvailableShares(candidate.tokenId);
    if (availableShares >= shares * 0.99) break;
    await sleep(500);
  }
  if (availableShares < shares * 0.99) {
    throw new Error(`Bought shares not available for sell yet: ${availableShares}`);
  }

  let sellOrderId = "";
  let sellPrice = 0;
  let sellError = "";
  for (let attempt = 0; attempt < 12; attempt++) {
    const bid = orderBook.bestBidInfo(candidate.side);
    if (!bid) {
      await sleep(400);
      continue;
    }
    sellPrice = bid.price;
    const sellResp = await client.postMultipleOrders([
      {
        tokenId: candidate.tokenId,
        action: "sell",
        price: sellPrice,
        shares,
        tickSize,
        feeRateBps,
        negRisk: false,
        orderType: "FOK",
      },
    ]);
    const sell = sellResp[0];
    if (sell?.success && sell.orderId) {
      sellOrderId = sell.orderId;
      break;
    }
    sellError = sell?.errorMsg ?? "unknown";
    await sleep(400);
  }

  if (!sellOrderId) {
    throw new Error(`Sell failed after retries: ${sellError}`);
  }

  let sellOrder = await client.getOrderById(sellOrderId);
  for (let i = 0; i < 20 && (!sellOrder || sellOrder.status !== "filled"); i++) {
    await sleep(500);
    sellOrder = await client.getOrderById(sellOrderId);
  }
  if (!sellOrder || sellOrder.status !== "filled") {
    throw new Error(`Sell did not fill: ${JSON.stringify(sellOrder)}`);
  }

  await client.updateUSDCBalance().catch(() => {});
  const balanceAfter = await client.getUSDCBalance();
  orderBook.destroy();

  console.log(
    JSON.stringify(
      {
        ok: true,
        slug,
        symbol,
        side: candidate.side,
        shares,
        buyPrice: candidate.ask,
        sellPrice,
        grossSpreadLoss: Number((candidate.ask - sellPrice).toFixed(4)),
        balanceBefore,
        balanceAfter,
        balanceDelta: Number((balanceAfter - balanceBefore).toFixed(4)),
        buyOrderId: buy.orderId,
        sellOrderId,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(String(error?.stack || error));
  process.exit(1);
});
