import { WebSocket } from 'ws';
import { getEnvironment } from './auth.js';
import {
  MdMessagesMethods,
  ClientMessageMethods,
  AggMessageMethods,
} from '@cubexch/client/lib/methods/market_data.js';
import {
  Side,
  KlineInterval,
  MarketByPriceDiff_DiffOp,
} from '@cubexch/client/lib/market_data.js';
import type {
  MdMessage,
  MarketByPrice_Level,
  Summary,
  Trades_Trade,
  Kline,
  TopOfBook,
  Heartbeat,
} from '@cubexch/client/lib/market_data.js';

// ── Exported types ─────────────────────────────────────────

export interface PriceLevel {
  price: bigint;
  quantity: bigint;
  side: 'BID' | 'ASK';
}

export interface MarketSummary {
  open: bigint | null;
  close: bigint | null;
  high: bigint | null;
  low: bigint | null;
  baseVolume: bigint;
  quoteVolume: bigint;
}

export interface TradeEntry {
  tradeId: string;
  price: bigint;
  quantity: bigint;
  side: 'BID' | 'ASK';
  timestamp: bigint;
}

export interface TopOfBookSnapshot {
  marketId: number;
  bidPrice: bigint | null;
  bidQuantity: bigint | null;
  askPrice: bigint | null;
  askQuantity: bigint | null;
  lastPrice: bigint | null;
  rolling24hPrice: bigint | null;
}

// ── Internal types ─────────────────────────────────────────

interface MarketSubscription {
  ws: WebSocket;
  bids: Map<bigint, bigint>;
  asks: Map<bigint, bigint>;
  summary: MarketSummary | null;
  trades: TradeEntry[];
  snapshotChunks: MarketByPrice_Level[][];
  snapshotComplete: boolean;
  heartbeatInterval: ReturnType<typeof setInterval>;
  heartbeatId: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  reconnectAttempts: number;
}

// ── Constants ──────────────────────────────────────────────

const HEARTBEAT_INTERVAL_MS = 25_000;
const MAX_TRADES = 100;
const MAX_RECONNECT_DELAY_MS = 30_000;
const BASE_RECONNECT_DELAY_MS = 1_000;

// ── Client ─────────────────────────────────────────────────

/**
 * Mendelev WebSocket client for Cube Exchange market data.
 *
 * NO AUTHENTICATION REQUIRED — all market data is public.
 * Connects to binary protobuf WebSocket endpoints for real-time data:
 * - /md/book/{marketId} — per-market order book, trades, and summary
 * - /md/tops — aggregate top-of-book for all markets
 *
 * Features:
 * - Automatic reconnection with exponential backoff
 * - MBP (Market By Price) order book maintenance
 * - 24h rolling summary updates
 * - Recent trades buffer (last 100)
 */
export class MendelevClient {
  // Per-market state
  private subscriptions = new Map<number, MarketSubscription>();

  // Tops (aggregate) connection
  private topsWs: WebSocket | null = null;
  private topsHeartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private topsHeartbeatId = 0;
  private topsReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private topsReconnectAttempts = 0;
  private tops = new Map<number, TopOfBookSnapshot>();
  private topsConnected = false;

  /**
   * Subscribe to a single market's order book, trades, and summary.
   * Connects to /md/book/{marketId}?mbp=true&trades=true&summary=true
   * No auth required.
   */
  async subscribe(marketId: number): Promise<void> {
    if (this.subscriptions.has(marketId)) return;

    const env = getEnvironment(process.env.CUBE_ENV);
    const url = `${env.wsMarketDataUrl}/book/${marketId}?mbp=true&trades=true&summary=true`;

    return new Promise<void>((resolve, reject) => {
      const connectTimeout = setTimeout(() => {
        reject(new Error(`Market data connect timed out for market ${marketId}`));
        if (ws) {
          try { ws.close(); } catch { /* ignore */ }
        }
      }, 10_000);

      const ws = new WebSocket(url);
      ws.binaryType = 'arraybuffer';

      const sub: MarketSubscription = {
        ws,
        bids: new Map(),
        asks: new Map(),
        summary: null,
        trades: [],
        snapshotChunks: [],
        snapshotComplete: false,
        heartbeatInterval: null as unknown as ReturnType<typeof setInterval>,
        heartbeatId: 0,
        reconnectTimer: null,
        reconnectAttempts: 0,
      };

      ws.on('open', () => {
        clearTimeout(connectTimeout);
        sub.reconnectAttempts = 0;
        sub.heartbeatInterval = setInterval(() => {
          sub.heartbeatId++;
          this.sendHeartbeat(ws, sub.heartbeatId);
        }, HEARTBEAT_INTERVAL_MS);

        this.subscriptions.set(marketId, sub);
        resolve();
      });

      ws.on('message', (data: ArrayBuffer | Buffer) => {
        const bytes = data instanceof ArrayBuffer
          ? new Uint8Array(data)
          : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        this.handleBookMessage(marketId, bytes);
      });

      ws.on('error', (err) => {
        clearTimeout(connectTimeout);
        if (!this.subscriptions.has(marketId)) {
          reject(err);
        }
      });

      ws.on('close', () => {
        const existing = this.subscriptions.get(marketId);
        if (existing) {
          if (existing.heartbeatInterval) clearInterval(existing.heartbeatInterval);
          // Auto-reconnect
          this.scheduleBookReconnect(marketId);
        }
      });
    });
  }

  /**
   * Unsubscribe from a market.
   */
  unsubscribe(marketId: number): void {
    this.cleanupSubscription(marketId);
  }

  /**
   * Connect to /md/tops for aggregate top-of-book for all markets.
   * No auth required.
   */
  async connectTops(): Promise<void> {
    if (this.topsConnected) return;

    const env = getEnvironment(process.env.CUBE_ENV);
    const url = `${env.wsMarketDataUrl}/tops`;

    return new Promise<void>((resolve, reject) => {
      const connectTimeout = setTimeout(() => {
        reject(new Error('Tops WebSocket connect timed out'));
        if (this.topsWs) {
          try { this.topsWs.close(); } catch { /* ignore */ }
          this.topsWs = null;
        }
      }, 10_000);

      this.topsWs = new WebSocket(url);
      this.topsWs.binaryType = 'arraybuffer';

      this.topsWs.on('open', () => {
        clearTimeout(connectTimeout);
        this.topsConnected = true;
        this.topsReconnectAttempts = 0;
        this.topsHeartbeatInterval = setInterval(() => {
          this.topsHeartbeatId++;
          if (this.topsWs && this.topsWs.readyState === WebSocket.OPEN) {
            this.sendHeartbeat(this.topsWs, this.topsHeartbeatId);
          }
        }, HEARTBEAT_INTERVAL_MS);
        resolve();
      });

      this.topsWs.on('message', (data: ArrayBuffer | Buffer) => {
        const bytes = data instanceof ArrayBuffer
          ? new Uint8Array(data)
          : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        this.handleTopsMessage(bytes);
      });

      this.topsWs.on('error', (err) => {
        clearTimeout(connectTimeout);
        if (!this.topsConnected) {
          reject(err);
        }
      });

      this.topsWs.on('close', () => {
        this.topsConnected = false;
        if (this.topsHeartbeatInterval) {
          clearInterval(this.topsHeartbeatInterval);
          this.topsHeartbeatInterval = null;
        }
        // Auto-reconnect
        this.scheduleTopsReconnect();
      });
    });
  }

  get isTopsConnected(): boolean {
    return this.topsConnected;
  }

  disconnectTops(): void {
    if (this.topsReconnectTimer) {
      clearTimeout(this.topsReconnectTimer);
      this.topsReconnectTimer = null;
    }
    this.cleanupTops();
  }

  /**
   * Get current order book for a subscribed market.
   * Returns bids and asks sorted by price.
   */
  getOrderBook(marketId: number): { bids: PriceLevel[]; asks: PriceLevel[] } | null {
    const sub = this.subscriptions.get(marketId);
    if (!sub || !sub.snapshotComplete) return null;

    const bids: PriceLevel[] = [];
    for (const [price, quantity] of sub.bids) {
      bids.push({ price, quantity, side: 'BID' });
    }
    bids.sort((a, b) => (b.price > a.price ? 1 : b.price < a.price ? -1 : 0));

    const asks: PriceLevel[] = [];
    for (const [price, quantity] of sub.asks) {
      asks.push({ price, quantity, side: 'ASK' });
    }
    asks.sort((a, b) => (a.price > b.price ? 1 : a.price < b.price ? -1 : 0));

    return { bids, asks };
  }

  /**
   * Get latest summary for a subscribed market.
   */
  getSummary(marketId: number): MarketSummary | null {
    const sub = this.subscriptions.get(marketId);
    return sub?.summary ?? null;
  }

  /**
   * Get recent trades for a subscribed market.
   */
  getRecentTrades(marketId: number): TradeEntry[] {
    const sub = this.subscriptions.get(marketId);
    return sub?.trades ?? [];
  }

  /**
   * Get top of book for all markets (from /md/tops).
   */
  getTops(): TopOfBookSnapshot[] {
    return Array.from(this.tops.values());
  }

  /**
   * Get top of book for a specific market.
   */
  getTop(marketId: number): TopOfBookSnapshot | null {
    return this.tops.get(marketId) ?? null;
  }

  /**
   * Check if a market has an active subscription with complete snapshot.
   */
  isSubscribed(marketId: number): boolean {
    const sub = this.subscriptions.get(marketId);
    return sub?.snapshotComplete ?? false;
  }

  /**
   * Disconnect all subscriptions.
   */
  disconnectAll(): void {
    for (const marketId of Array.from(this.subscriptions.keys())) {
      this.cleanupSubscription(marketId);
    }
    this.disconnectTops();
  }

  // ── Reconnection logic ────────────────────────────────────

  private scheduleBookReconnect(marketId: number): void {
    const sub = this.subscriptions.get(marketId);
    if (!sub) return;

    const delay = Math.min(
      BASE_RECONNECT_DELAY_MS * Math.pow(1.5, sub.reconnectAttempts),
      MAX_RECONNECT_DELAY_MS
    );
    sub.reconnectAttempts++;

    sub.reconnectTimer = setTimeout(async () => {
      // Reset book state for fresh snapshot
      sub.bids.clear();
      sub.asks.clear();
      sub.snapshotChunks = [];
      sub.snapshotComplete = false;
      sub.trades = [];
      sub.summary = null;

      const env = getEnvironment(process.env.CUBE_ENV);
      const url = `${env.wsMarketDataUrl}/book/${marketId}?mbp=true&trades=true&summary=true`;

      try {
        const ws = new WebSocket(url);
        ws.binaryType = 'arraybuffer';
        sub.ws = ws;

        ws.on('open', () => {
          sub.reconnectAttempts = 0;
          sub.heartbeatInterval = setInterval(() => {
            sub.heartbeatId++;
            this.sendHeartbeat(ws, sub.heartbeatId);
          }, HEARTBEAT_INTERVAL_MS);
        });

        ws.on('message', (data: ArrayBuffer | Buffer) => {
          const bytes = data instanceof ArrayBuffer
            ? new Uint8Array(data)
            : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
          this.handleBookMessage(marketId, bytes);
        });

        ws.on('error', () => { /* reconnect on close */ });
        ws.on('close', () => {
          if (sub.heartbeatInterval) clearInterval(sub.heartbeatInterval);
          if (this.subscriptions.has(marketId)) {
            this.scheduleBookReconnect(marketId);
          }
        });
      } catch {
        this.scheduleBookReconnect(marketId);
      }
    }, delay);
  }

  private scheduleTopsReconnect(): void {
    if (this.topsReconnectTimer) return;

    const delay = Math.min(
      BASE_RECONNECT_DELAY_MS * Math.pow(1.5, this.topsReconnectAttempts),
      MAX_RECONNECT_DELAY_MS
    );
    this.topsReconnectAttempts++;

    this.topsReconnectTimer = setTimeout(async () => {
      this.topsReconnectTimer = null;
      try {
        await this.connectTops();
      } catch {
        this.scheduleTopsReconnect();
      }
    }, delay);
  }

  // ── Private helpers ────────────────────────────────────────

  private sendHeartbeat(ws: WebSocket, id: number): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    const encoded = ClientMessageMethods.encode({
      heartbeat: {
        requestId: BigInt(id),
        timestamp: BigInt(Math.floor(Date.now() / 1000)) * 1_000_000_000n,
      },
    }).finish();
    ws.send(encoded);
  }

  private handleBookMessage(marketId: number, bytes: Uint8Array): void {
    const sub = this.subscriptions.get(marketId);
    if (!sub) return;

    let wrapper;
    try {
      wrapper = MdMessagesMethods.decode(bytes);
    } catch {
      return;
    }

    for (const msg of wrapper.messages) {
      // MBP snapshot chunks
      if (msg.mbpSnapshot) {
        const snap = msg.mbpSnapshot;
        while (sub.snapshotChunks.length <= snap.chunk) {
          sub.snapshotChunks.push([]);
        }
        sub.snapshotChunks[snap.chunk] = snap.levels;

        if (snap.chunk === snap.numChunks - 1) {
          sub.bids.clear();
          sub.asks.clear();
          for (const chunk of sub.snapshotChunks) {
            for (const level of chunk) {
              if (level.side === Side.BID) {
                sub.bids.set(level.price, level.quantity);
              } else {
                sub.asks.set(level.price, level.quantity);
              }
            }
          }
          sub.snapshotComplete = true;
          sub.snapshotChunks = [];
        }
      }

      // MBP diffs
      if (msg.mbpDiff && sub.snapshotComplete) {
        for (const diff of msg.mbpDiff.diffs) {
          const book = diff.side === Side.BID ? sub.bids : sub.asks;

          if (diff.op === MarketByPriceDiff_DiffOp.REMOVE) {
            book.delete(diff.price);
          } else if (diff.op === MarketByPriceDiff_DiffOp.REPLACE) {
            book.set(diff.price, diff.quantity);
          }
        }
      }

      // Summary (24h OHLCV)
      if (msg.summary) {
        const s = msg.summary;
        sub.summary = {
          open: s.open ?? null,
          close: s.close ?? null,
          high: s.high ?? null,
          low: s.low ?? null,
          baseVolume: (BigInt(s.baseVolumeHi) << 64n) | BigInt(s.baseVolumeLo),
          quoteVolume: (BigInt(s.quoteVolumeHi) << 64n) | BigInt(s.quoteVolumeLo),
        };
      }

      // Trades
      if (msg.trades) {
        for (const t of msg.trades.trades) {
          const side = this.aggressingSideToSide(t.aggressingSide);
          sub.trades.push({
            tradeId: t.tradeId.toString(),
            price: t.price,
            quantity: t.fillQuantity,
            side,
            timestamp: t.transactTime,
          });
        }
        if (sub.trades.length > MAX_TRADES) {
          sub.trades = sub.trades.slice(-MAX_TRADES);
        }
      }
    }
  }

  private handleTopsMessage(bytes: Uint8Array): void {
    let agg;
    try {
      agg = AggMessageMethods.decode(bytes);
    } catch {
      return;
    }

    if (agg.topOfBooks) {
      for (const top of agg.topOfBooks.tops) {
        const mktId = Number(top.marketId);
        this.tops.set(mktId, {
          marketId: mktId,
          bidPrice: top.bidPrice ?? null,
          bidQuantity: top.bidQuantity ?? null,
          askPrice: top.askPrice ?? null,
          askQuantity: top.askQuantity ?? null,
          lastPrice: top.lastPrice ?? null,
          rolling24hPrice: top.rolling24hPrice ?? null,
        });
      }
    }
  }

  private aggressingSideToSide(aggressingSide: number): 'BID' | 'ASK' {
    return aggressingSide === 0 || aggressingSide === 2 ? 'BID' : 'ASK';
  }

  private cleanupSubscription(marketId: number): void {
    const sub = this.subscriptions.get(marketId);
    if (!sub) return;

    if (sub.reconnectTimer) clearTimeout(sub.reconnectTimer);
    if (sub.heartbeatInterval) clearInterval(sub.heartbeatInterval);
    if (sub.ws.readyState === WebSocket.OPEN || sub.ws.readyState === WebSocket.CONNECTING) {
      try { sub.ws.close(); } catch { /* ignore */ }
    }
    this.subscriptions.delete(marketId);
  }

  private cleanupTops(): void {
    if (this.topsHeartbeatInterval) {
      clearInterval(this.topsHeartbeatInterval);
      this.topsHeartbeatInterval = null;
    }
    if (this.topsWs) {
      if (this.topsWs.readyState === WebSocket.OPEN || this.topsWs.readyState === WebSocket.CONNECTING) {
        try { this.topsWs.close(); } catch { /* ignore */ }
      }
      this.topsWs = null;
    }
    this.topsConnected = false;
    this.tops.clear();
  }
}
