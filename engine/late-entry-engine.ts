import { APIQueue } from "../tracker/api-queue.ts";
import type { LateEntryClient } from "./client.ts";
import { LateEntrySimClient, PolymarketLateEntryClient } from "./client.ts";
import { MarketLifecycle } from "./market-lifecycle.ts";
import { loadState, saveState, type CompletedMarketState } from "./state.ts";
import { getSlug } from "../utils/slot.ts";
import { log } from "./log.ts";
import { recover } from "./recovery.ts";
import {
  strategies,
  DEFAULT_STRATEGY,
  type Strategy,
} from "./strategy/index.ts";
import { WalletTracker } from "./wallet-tracker.ts";
import { TickerTracker } from "../tracker/ticker";
import { NonceGuardFillFeed } from "./nonce-guard-feed.ts";
import { Env } from "../utils/config.ts";

const SAVE_INTERVAL_MS = 5000;

export class LateEntryEngine {
  private _lifecycles = new Map<string, MarketLifecycle>();
  private _completedSlugs = new Set<string>();
  private _completedMarkets: CompletedMarketState[] = [];
  private _warnedStoppingSlugs = new Set<string>();
  private _client: LateEntryClient;
  private _apiQueue = new APIQueue();
  private _sessionPnl = 0;
  private _sessionLoss = 0;
  private _shuttingDown = false;
  private _lastSaveMs = 0;
  private readonly _strategyName: string;
  private readonly _strategy: Strategy;
  private readonly _slotOffset: number;

  private readonly _statePath: string;
  private readonly _rounds: number | null; // null = unlimited
  private readonly _prod: boolean;
  private readonly _paper: boolean;
  private readonly _minSessionPnl: number;
  private readonly _alwaysLog: boolean;
  private readonly _asset: string;
  private _roundsCreated = 0;
  private _tracker!: WalletTracker;
  private _ticker = new TickerTracker();
  private readonly _nonceGuardFeed = new NonceGuardFillFeed(
    process.env.NONCE_GUARD_FILL_FEED_PATH?.trim() || undefined,
  );

  constructor(
    strategyName?: string,
    slotOffset = 1,
    prod = false,
    rounds: number | null = null,
    alwaysLog = false,
    paper = false,
  ) {
    this._prod = prod;
    this._paper = paper;
    this._asset = Env.get("MARKET_SYMBOL");
    this._statePath = prod || paper
      ? `state/late-entry-${this._asset.toLowerCase()}-prod.json`
      : `state/late-entry-${this._asset.toLowerCase()}.json`;
    this._rounds = rounds;
    this._strategyName = strategyName ?? DEFAULT_STRATEGY;
    this._strategy = strategies[this._strategyName]!;
    this._slotOffset = slotOffset;
    this._alwaysLog = alwaysLog;
    // Default session-loss kill switch: 5% of starting bankroll (paper/sim) or
    // $25 (live, if WALLET_BALANCE not set). Override via MAX_SESSION_LOSS env.
    // Set DISABLE_LOSS_CAPS=true to remove the session-halt entirely (testing).
    if (process.env.DISABLE_LOSS_CAPS === "true") {
      this._minSessionPnl = Number.POSITIVE_INFINITY;
    } else {
      const bankrollForDefault = parseFloat(process.env.WALLET_BALANCE ?? "500");
      const defaultMaxLoss = Number.isFinite(bankrollForDefault) && bankrollForDefault > 0
        ? Math.max(3, bankrollForDefault * 0.05)
        : 25;
      this._minSessionPnl = parseFloat(
        process.env.MAX_SESSION_LOSS ?? defaultMaxLoss.toFixed(2),
      );
    }
    // In paper mode, use LateEntrySimClient (no CLOB auth needed).
    // Fills are simulated in _postPaperOrders using real ticker prices
    // (Binance/Coinbase), with CLOB order book used when available.
    if (!prod && !paper) {
      this._client = new LateEntrySimClient((tokenId) => {
        for (const lifecycle of this._lifecycles.values()) {
          const snap = lifecycle.getBookSnapshot(tokenId);
          if (snap) return snap;
        }
        return {
          bestAsk: null,
          bestAskLiquidity: null,
          bestBid: null,
          bestBidLiquidity: null,
        };
      });
    } else {
      this._client = new PolymarketLateEntryClient();
    }
  }

  async start(): Promise<void> {
    log.write("[startup] Starting");
    this._ticker.schedule();
    await this._ticker.waitForReady();
    log.write(`[startup] ${this._asset} ticker ready`);

    await this._client.init();
    if (this._nonceGuardFeed.isEnabled) {
      log.write(
        `[startup] Nonce-guard fill feed output enabled: ${process.env.NONCE_GUARD_FILL_FEED_PATH}`,
      );
    } else {
      log.write("[startup] Nonce-guard fill feed disabled", "dim");
    }

    // Seed wallet tracker
    let initialBalance: number;
    if (this._paper) {
      // Paper mode: use WALLET_BALANCE env var, do not touch on-chain balance
      initialBalance = parseFloat(process.env.WALLET_BALANCE ?? "500");
      log.write(`[startup] [PAPER] Paper balance: $${initialBalance.toFixed(2)}`);
    } else if (this._prod) {
      // Live prod: fetch real on-chain balance
      await this._client.updateUSDCBalance();
      initialBalance = await this._client.getUSDCBalance();
      log.write(`[startup] [LIVE] On-chain balance: $${initialBalance.toFixed(2)}`);
    } else {
      // Sim mode: use WALLET_BALANCE env var
      initialBalance = parseFloat(process.env.WALLET_BALANCE ?? "50");
      log.write(`[startup] Sim balance: $${initialBalance.toFixed(2)}`);
    }
    this._tracker = new WalletTracker(initialBalance, (msg) =>
      log.write(msg, "dim"),
    );

    log.write(
      `[startup] Min session PnL exit: $${this._minSessionPnl.toFixed(2)}`,
    );

    const state = loadState(this._statePath);
    if (state) {
      log.write(`[startup] Loading state from ${this._statePath}`);
      this._sessionPnl = state.sessionPnl;
      this._sessionLoss = state.sessionLoss ?? 0;

      if (Math.abs(this._sessionLoss) >= this._minSessionPnl) {
        if (this._paper) {
          log.write(
            `[startup] Paper mode: resetting sessionLoss ($${this._sessionLoss.toFixed(2)} -> $0.00) instead of exiting.`,
            "yellow",
          );
          this._sessionLoss = 0;
          this._sessionPnl = 0;
        } else {
          log.write(
            `[startup] Session loss from previous session ($${this._sessionLoss.toFixed(2)}) already meets or exceeds the MAX_SESSION_LOSS threshold (-$${this._minSessionPnl.toFixed(2)}). ` +
              `The engine would shut down immediately. ` +
              `To start fresh, reset "sessionLoss" to 0 in ${this._statePath}, or increase MAX_SESSION_LOSS in your .env.`,
            "red",
          );
          process.exit(1);
        }
      }

      // Sim recovery: replay order history to reconstruct balance
      if (!this._prod) {
        for (const market of state.activeMarkets) {
          for (const order of market.orderHistory) {
            if (order.action === "buy")
              this._tracker.debit(order.price * order.shares);
            else this._tracker.credit(order.price * order.shares);
          }
        }
      }

      const recovered = await recover(
        state,
        this._client,
        this._apiQueue,
        (msg, color) => log.write(msg, color),
        this._tracker,
        this._ticker,
        this._nonceGuardFeed,
      );
      for (const [slug, lifecycle] of recovered) {
        this._lifecycles.set(slug, lifecycle);
      }
    } else {
      log.write("[startup] No saved state found. Starting fresh.");
    }

    process.on("exit", () => {
      log.flush();
      this._saveState();
    });

    const onSignal = (sig: string) => {
      log.write(
        `[shutdown] ${sig} received. Initiating graceful shutdown...`,
        "yellow",
      );
      log.flush();
      this._saveState();
      this._startShutdown(`${sig} received.`);
    };
    process.on("SIGINT", () => onSignal("SIGINT"));
    process.on("SIGTERM", () => onSignal("SIGTERM"));

    setInterval(() => this._tick(), 100);
  }

  private _tick(): void {
    // Create a new lifecycle for next market if not shutting down and rounds allow
    const roundsExhausted =
      this._rounds !== null && this._roundsCreated >= this._rounds;
    if (!this._shuttingDown && !roundsExhausted) {
      const slug = getSlug(this._slotOffset);
      if (!this._lifecycles.has(slug) && !this._completedSlugs.has(slug)) {
        this._lifecycles.set(
          slug,
          new MarketLifecycle({
            slug,
            apiQueue: this._apiQueue,
            client: this._client,
            log: (msg, color) => log.write(msg, color),
            strategyName: this._strategyName,
            strategy: this._strategy,
            tracker: this._tracker,
            ticker: this._ticker,
            alwaysLog: this._alwaysLog,
            nonceGuardFeed: this._nonceGuardFeed,
            paper: this._paper,
          }),
        );
        this._roundsCreated++;
      }
    }

    // Tick all lifecycles (fire-and-forget; _ticking guard prevents re-entry)
    const done: string[] = [];
    for (const [slug, lifecycle] of this._lifecycles) {
      lifecycle
        .tick()
        .catch((e) => log.write(`[${slug}] tick error: ${e}`, "red"));
      if (lifecycle.state === "DONE") done.push(slug);
    }

    // Process completed lifecycles
    for (const slug of done) {
      const lifecycle = this._lifecycles.get(slug)!;
      this._sessionPnl = parseFloat(
        (this._sessionPnl + lifecycle.pnl).toFixed(4),
      );
      if (lifecycle.pnl < 0) {
        this._sessionLoss = parseFloat(
          (this._sessionLoss + lifecycle.pnl).toFixed(4),
        );
      }
      log.write(
        `[${slug}] Session PnL: ${this._sessionPnl >= 0 ? "+" : ""}$${this._sessionPnl.toFixed(2)}`,
        this._sessionPnl >= 0 ? "green" : "red",
      );
      this._completedMarkets.push({
        slug,
        strategyName: lifecycle.strategyName,
        pnl: lifecycle.pnl,
        orderHistory: lifecycle.orderHistory,
      });
      lifecycle.destroy();
      this._lifecycles.delete(slug);
      this._completedSlugs.add(slug);
      this._warnedStoppingSlugs.delete(slug);

      if (Math.abs(this._sessionLoss) >= this._minSessionPnl) {
        this._startShutdown(
          `Session loss limit reached (total losses: $${this._sessionLoss.toFixed(2)}, threshold: -$${this._minSessionPnl.toFixed(2)}).`,
        );
      }
    }

    // Check slot-end timeout for active stopping lifecycles.
    // Do not force a global shutdown here, a lifecycle can remain STOPPING
    // while waiting for final settlement after slot end.
    if (!this._shuttingDown) {
      const nowMs = Date.now();
      for (const [slug, lifecycle] of this._lifecycles) {
        if (lifecycle.state === "STOPPING" && nowMs > lifecycle.slotEndMs) {
          if (!this._warnedStoppingSlugs.has(slug)) {
            log.write(
              `[shutdown] Lifecycle ${slug} still STOPPING past slot end, waiting for settlement instead of shutting down.`,
              "yellow",
            );
            this._warnedStoppingSlugs.add(slug);
          }
        }
      }
    }

    // Throttled state persistence (every 5s)
    if (Date.now() - this._lastSaveMs >= SAVE_INTERVAL_MS) {
      this._saveState();
    }

    // Auto-shutdown when all rounds complete and no lifecycles remain
    if (!this._shuttingDown && roundsExhausted && this._lifecycles.size === 0) {
      this._startShutdown(`All ${this._rounds} round(s) complete.`);
    }

    // Exit once all lifecycles are settled during shutdown
    if (this._shuttingDown && this._lifecycles.size === 0) {
      log.write("[shutdown] All settled. Exiting.", "dim");
      this._saveState();
      this._ticker.destroy();
      process.exit(0);
    }
  }

  private _startShutdown(reason: string): void {
    if (this._shuttingDown) return;
    this._shuttingDown = true;
    log.write(`[shutdown] ${reason}`, "yellow");
    log.write("[shutdown] Signalling all lifecycles to cancel.", "yellow");

    for (const [, lifecycle] of this._lifecycles) {
      lifecycle.shutdown();
    }

    const stoppingCount = [...this._lifecycles.values()].filter(
      (l) => l.state === "STOPPING",
    ).length;

    if (stoppingCount > 0) {
      log.write(
        `[shutdown] Waiting for ${stoppingCount} lifecycle(s) to settle...`,
      );
    }
  }

  private _saveState(): void {
    this._lastSaveMs = Date.now();
    const activeMarkets = [...this._lifecycles.entries()]
      .filter(([, l]) => l.state === "RUNNING" || l.state === "STOPPING")
      .map(([slug, l]) => ({
        slug,
        state: l.state as "RUNNING" | "STOPPING",
        strategyName: l.strategyName,
        clobTokenIds: l.clobTokenIds!,
        pendingOrders: l.pendingOrders,
        orderHistory: l.orderHistory,
      }));

    saveState(this._statePath, {
      sessionPnl: this._sessionPnl,
      sessionLoss: this._sessionLoss,
      activeMarkets,
      completedMarkets: this._completedMarkets,
    });
  }
}
