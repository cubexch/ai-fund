/**
 * Real-time market data streaming via CCXT Pro WebSocket.
 *
 * Maintains a single exchange instance with WebSocket connections
 * for order book, trades, and ticker streaming. Auto-reconnects.
 */

import ccxt from 'ccxt';

export interface StreamSnapshot {
  orderBook?: {
    bids: [number, number][];
    asks: [number, number][];
    bestBid: number | undefined;
    bestAsk: number | undefined;
    mid: number | undefined;
    spread: number | undefined;
    spreadBps: number | undefined;
    timestamp: number | undefined;
  };
  ticker?: {
    last: number | undefined;
    bid: number | undefined;
    ask: number | undefined;
    volume: number | undefined;
    timestamp: number | undefined;
  };
  trades?: {
    id: string;
    side: string;
    price: number;
    amount: number;
    timestamp: number;
  }[];
  lastUpdate: number;
}

export class StreamManager {
  private exchange: any;
  private snapshots = new Map<string, StreamSnapshot>();
  private watchers = new Map<string, AbortController>();
  private _exchangeId: string;

  constructor(exchangeId: string, config?: { apiKey?: string; secret?: string; sandbox?: boolean }) {
    this._exchangeId = exchangeId;
    // Try to create pro exchange
    const ProClass = (ccxt.pro as any)?.[exchangeId];
    if (!ProClass) {
      throw new Error(`Exchange ${exchangeId} does not support WebSocket streaming (no ccxt.pro support)`);
    }
    const cfg: any = {};
    if (config?.apiKey) cfg.apiKey = config.apiKey;
    if (config?.secret) cfg.secret = config.secret;
    this.exchange = new ProClass(cfg);
    if (config?.sandbox) {
      this.exchange.setSandboxMode(true);
    }
  }

  get exchangeId(): string { return this._exchangeId; }

  private static readonly MAX_RETRIES = 20;
  private static readonly MAX_BACKOFF_MS = 30_000;

  /**
   * Run a watch loop with exponential backoff.
   * On success, retries reset. After MAX_RETRIES consecutive failures, the loop stops.
   */
  private watchLoop(key: string, fn: (signal: AbortSignal) => Promise<void>): void {
    const controller = new AbortController();
    this.watchers.set(key, controller);

    const loop = async () => {
      let consecutiveErrors = 0;
      while (!controller.signal.aborted) {
        try {
          await fn(controller.signal);
          consecutiveErrors = 0; // reset on success
        } catch (err) {
          if (controller.signal.aborted) break;
          consecutiveErrors++;
          if (consecutiveErrors >= StreamManager.MAX_RETRIES) {
            process.stderr.write(`[stream] ${key}: giving up after ${consecutiveErrors} consecutive errors\n`);
            this.watchers.delete(key);
            break;
          }
          const backoffMs = Math.min(
            StreamManager.MAX_BACKOFF_MS,
            1000 * Math.pow(2, consecutiveErrors - 1),
          );
          await new Promise(r => setTimeout(r, backoffMs));
        }
      }
    };

    loop().catch(err => {
      process.stderr.write(`[stream] ${key}: fatal error: ${err?.message ?? err}\n`);
      this.watchers.delete(key);
    });
  }

  /**
   * Subscribe to real-time order book updates for a symbol.
   * Runs in background, updates snapshot continuously.
   */
  async subscribeOrderBook(symbol: string, limit = 20): Promise<void> {
    const key = `ob:${symbol}`;
    if (this.watchers.has(key)) return; // already subscribed

    this.watchLoop(key, async () => {
      const ob = await this.exchange.watchOrderBook(symbol, limit);
      const bids = (ob.bids || []).slice(0, limit) as [number, number][];
      const asks = (ob.asks || []).slice(0, limit) as [number, number][];
      const bestBid = bids.length > 0 ? bids[0][0] : undefined;
      const bestAsk = asks.length > 0 ? asks[0][0] : undefined;
      const mid = bestBid != null && bestAsk != null ? (bestBid + bestAsk) / 2 : undefined;
      const spread = bestBid != null && bestAsk != null ? bestAsk - bestBid : undefined;
      const spreadBps = mid && spread ? Math.round((spread / mid) * 10000 * 100) / 100 : undefined;

      const snap = this.getOrCreate(symbol);
      snap.orderBook = { bids, asks, bestBid, bestAsk, mid, spread, spreadBps, timestamp: ob.timestamp };
      snap.lastUpdate = Date.now();
    });
  }

  /**
   * Subscribe to real-time ticker updates.
   */
  async subscribeTicker(symbol: string): Promise<void> {
    const key = `tk:${symbol}`;
    if (this.watchers.has(key)) return;

    this.watchLoop(key, async () => {
      const t = await this.exchange.watchTicker(symbol);
      const snap = this.getOrCreate(symbol);
      snap.ticker = {
        last: t.last, bid: t.bid, ask: t.ask,
        volume: t.baseVolume, timestamp: t.timestamp,
      };
      snap.lastUpdate = Date.now();
    });
  }

  /**
   * Subscribe to real-time trade stream.
   */
  async subscribeTrades(symbol: string, maxTrades = 100): Promise<void> {
    const key = `tr:${symbol}`;
    if (this.watchers.has(key)) return;

    this.watchLoop(key, async () => {
      const trades = await this.exchange.watchTrades(symbol);
      const snap = this.getOrCreate(symbol);
      const existing = snap.trades || [];
      const newTrades = trades.map((t: any) => ({
        id: t.id, side: t.side, price: t.price,
        amount: t.amount, timestamp: t.timestamp,
      }));
      snap.trades = [...existing, ...newTrades].slice(-maxTrades);
      snap.lastUpdate = Date.now();
    });
  }

  /** Get current snapshot for a symbol. */
  getSnapshot(symbol: string): StreamSnapshot | undefined {
    return this.snapshots.get(symbol);
  }

  /** Get all active subscriptions. */
  getSubscriptions(): { symbol: string; channels: string[] }[] {
    const subs = new Map<string, string[]>();
    for (const key of this.watchers.keys()) {
      const [channel, symbol] = key.split(':');
      if (!subs.has(symbol)) subs.set(symbol, []);
      subs.get(symbol)!.push(channel === 'ob' ? 'orderBook' : channel === 'tk' ? 'ticker' : 'trades');
    }
    return Array.from(subs.entries()).map(([symbol, channels]) => ({ symbol, channels }));
  }

  /** Unsubscribe from a symbol's channel. */
  unsubscribe(symbol: string, channel?: string): void {
    if (channel) {
      const prefix = channel === 'orderBook' ? 'ob' : channel === 'ticker' ? 'tk' : 'tr';
      const key = `${prefix}:${symbol}`;
      this.watchers.get(key)?.abort();
      this.watchers.delete(key);
    } else {
      // Unsubscribe all channels for this symbol
      for (const [key, ctrl] of this.watchers) {
        if (key.endsWith(`:${symbol}`)) {
          ctrl.abort();
          this.watchers.delete(key);
        }
      }
      this.snapshots.delete(symbol);
    }
  }

  /** Close all connections. */
  async close(): Promise<void> {
    for (const ctrl of this.watchers.values()) {
      ctrl.abort();
    }
    this.watchers.clear();
    this.snapshots.clear();
    if (this.exchange.close) {
      await this.exchange.close();
    }
  }

  private getOrCreate(symbol: string): StreamSnapshot {
    let snap = this.snapshots.get(symbol);
    if (!snap) {
      snap = { lastUpdate: 0 };
      this.snapshots.set(symbol, snap);
    }
    return snap;
  }
}
