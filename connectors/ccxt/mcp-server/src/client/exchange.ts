/**
 * Universal CCXT exchange client wrapper.
 *
 * Wraps any CCXT exchange instance behind a typed interface that maps
 * to the ai-fund unified tool API. Public methods (market data) work
 * without credentials. Private methods (trading, account) require
 * API key + secret.
 */

import ccxt, { type Exchange, type Ticker, type Order } from 'ccxt';
import { MarketDataStore, type OHLCVRow } from '@ai-fund/lib/datastore';
import { RateLimiter } from './rate-limiter';
import { LatencyTracker } from './latency-tracker';

// ── Types ────────────────────────────────────────────────────

export interface ExchangeClientOpts {
  exchangeId: string;
  apiKey?: string;
  secret?: string;
  password?: string;
  sandbox?: boolean;
  exchangeInstance?: Exchange;
  /** Optional DuckDB store for read-through caching of OHLCV data. */
  store?: MarketDataStore;
  /** Optional trade journal for auto-recording executions. */
  journal?: any;
  /** Max requests per second for rate limiting. */
  rateLimit?: number;
}

export interface TickerResult {
  symbol: string;
  last: number | undefined;
  bid: number | undefined;
  ask: number | undefined;
  high: number | undefined;
  low: number | undefined;
  open: number | undefined;
  close: number | undefined;
  volume: number | undefined;
  quoteVolume: number | undefined;
  change: number | undefined;
  percentage: number | undefined;
  timestamp: number | undefined;
}

export interface BarResult {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface OrderBookResult {
  symbol: string;
  bids: [number, number][];
  asks: [number, number][];
  bestBid: number | undefined;
  bestAsk: number | undefined;
  mid: number | undefined;
  spread: number | undefined;
  spreadBps: number | undefined;
  timestamp: number | undefined;
}

export interface TradeResult {
  id: string | undefined;
  timestamp: number | undefined;
  symbol: string;
  side: string;
  price: number;
  amount: number;
  cost: number | undefined;
}

export interface OrderResult {
  id: string;
  clientOrderId: string | undefined;
  symbol: string;
  side: string;
  type: string;
  amount: number | undefined;
  filled: number | undefined;
  remaining: number | undefined;
  price: number | undefined;
  average: number | undefined;
  status: string | undefined;
  timestamp: number | undefined;
  datetime: string | undefined;
}

export interface BalanceResult {
  currency: string;
  free: number;
  used: number;
  total: number;
}

export interface PositionResult {
  symbol: string;
  side: string;
  amount: number;
  unrealizedPnl: number | undefined;
  entryPrice: number | undefined;
  currentPrice: number | undefined;
}

export interface MarketResult {
  symbol: string;
  base: string;
  quote: string;
  type: string | undefined;
  active: boolean | undefined;
  precision: { amount: number | undefined; price: number | undefined };
  limits: {
    amount: { min: number | undefined; max: number | undefined };
    price: { min: number | undefined; max: number | undefined };
  };
}

export interface QuoteResult {
  symbol: string;
  bid: number | undefined;
  bidSize: number | undefined;
  ask: number | undefined;
  askSize: number | undefined;
  mid: number | undefined;
  spread: number | undefined;
  spreadBps: number | undefined;
  last: number | undefined;
  timestamp: number | undefined;
}

export interface FeeResult {
  symbol: string | undefined;
  maker: number | undefined;
  taker: number | undefined;
  percentage: boolean;
}

export interface ExchangeInfoResult {
  id: string;
  name: string;
  countries: string[];
  rateLimit: number;
  has: Record<string, boolean>;
  timeframes: string[];
  totalMarkets: number;
  activeMarkets: number;
}

// ── Helpers ────────────────────────────────────────────────

function str(v: string | undefined): string {
  return v ?? '';
}

function formatMarket(m: { symbol?: string; base?: string; quote?: string; type?: string; active?: boolean; precision?: any; limits?: any }): MarketResult {
  return {
    symbol: str(m.symbol),
    base: str(m.base),
    quote: str(m.quote),
    type: m.type,
    active: m.active,
    precision: {
      amount: m.precision?.amount,
      price: m.precision?.price,
    },
    limits: {
      amount: { min: m.limits?.amount?.min, max: m.limits?.amount?.max },
      price: { min: m.limits?.price?.min, max: m.limits?.price?.max },
    },
  };
}

function formatTrade(t: any): TradeResult {
  return {
    id: t.id,
    timestamp: t.timestamp,
    symbol: str(t.symbol),
    side: str(t.side),
    price: t.price ?? 0,
    amount: t.amount ?? 0,
    cost: t.cost,
  };
}

// ── Client ──────────────────────────────────────────────────

export class ExchangeClient {
  private readonly exchange: Exchange;
  private readonly _sandbox: boolean;
  private readonly limiter: RateLimiter | null;
  readonly exchangeId: string;
  /** DuckDB store for read-through caching. Null when not configured. */
  readonly store: MarketDataStore | null;
  /** Trade journal for auto-recording executions. */
  readonly journal: any;  // TradeJournal | null
  /** Per-method API latency tracker for performance monitoring. */
  readonly latency = new LatencyTracker();

  constructor(opts: ExchangeClientOpts) {
    this.exchangeId = opts.exchangeId;
    this._sandbox = opts.sandbox ?? false;
    this.store = opts.store ?? null;
    this.journal = opts.journal ?? null;
    this.limiter = opts.rateLimit ? new RateLimiter(opts.rateLimit) : null;

    if (opts.exchangeInstance) {
      this.exchange = opts.exchangeInstance;
    } else {
      const ExchangeClass = (ccxt as any)[opts.exchangeId];
      if (!ExchangeClass) {
        throw new Error(`Unknown exchange: ${opts.exchangeId}. Supported: ${ccxt.exchanges.join(', ')}`);
      }

      const config: Record<string, unknown> = {};
      if (opts.apiKey) config.apiKey = opts.apiKey;
      if (opts.secret) config.secret = opts.secret;
      if (opts.password) config.password = opts.password;

      this.exchange = new ExchangeClass(config) as Exchange;

      if (opts.sandbox) {
        this.exchange.setSandboxMode(true);
      }
    }
  }

  get hasCredentials(): boolean {
    return !!(this.exchange.apiKey && this.exchange.secret);
  }

  get isSandbox(): boolean {
    return this._sandbox;
  }

  get name(): string {
    return this.exchange.name ?? this.exchangeId;
  }

  private _marketsLoaded = false;

  /** Ensure markets are loaded (cached by CCXT after first call). */
  async ensureMarkets(): Promise<void> {
    if (!this._marketsLoaded) {
      await this.exchange.loadMarkets();
      this._marketsLoaded = true;
    }
  }

  /**
   * Round amount to exchange precision. Must call ensureMarkets() first.
   * Uses CCXT's built-in precision handling (TICK_SIZE, DECIMAL_PLACES, etc.).
   */
  roundAmount(symbol: string, amount: number): number {
    try {
      return Number(this.exchange.amountToPrecision(symbol, amount));
    } catch {
      return amount;
    }
  }

  /** Round price to exchange precision. Must call ensureMarkets() first. */
  roundPrice(symbol: string, price: number): number {
    try {
      return Number(this.exchange.priceToPrecision(symbol, price));
    } catch {
      return price;
    }
  }

  private async throttle(): Promise<void> {
    if (this.limiter) await this.limiter.acquire();
  }

  private async timed<T>(method: string, fn: () => Promise<T>): Promise<T> {
    const start = performance.now();
    try {
      const result = await fn();
      this.latency.record(method, performance.now() - start);
      return result;
    } catch (err) {
      this.latency.recordError(method);
      throw err;
    }
  }

  // ── Public: Market Data ──────────────────────────────────

  async loadMarkets(): Promise<MarketResult[]> {
    const markets = await this.exchange.loadMarkets();
    return Object.values(markets)
      .filter((m): m is NonNullable<typeof m> => m != null)
      .map(formatMarket);
  }

  async getTicker(symbol: string): Promise<TickerResult> {
    await this.throttle();
    const t = await this.timed('fetchTicker', () => this.exchange.fetchTicker(symbol));
    return this.formatTicker(t);
  }

  async getTickers(symbols?: string[]): Promise<TickerResult[]> {
    await this.throttle();
    const tickers = await this.timed('fetchTickers', () => this.exchange.fetchTickers(symbols));
    return Object.values(tickers).map(t => this.formatTicker(t));
  }

  async getBars(symbol: string, timeframe: string, since?: number, limit?: number): Promise<BarResult[]> {
    await this.throttle();
    // Read-through cache: check DuckDB first, fetch delta from exchange, merge
    if (this.store) {
      const cached = await this.store.query({
        symbol,
        interval: timeframe,
        exchange: this.exchangeId,
        start: since ? new Date(since) : undefined,
        limit,
      });

      // Determine if we need fresh data from the exchange
      const lastCachedTs = cached.length > 0 ? cached[cached.length - 1].timestamp : undefined;
      const fetchSince = lastCachedTs ? lastCachedTs + 1 : since;

      const ohlcv = await this.timed('fetchOHLCV', () => this.exchange.fetchOHLCV(symbol, timeframe, fetchSince, limit));
      const fresh: BarResult[] = ohlcv.map(candle => ({
        timestamp: candle[0] as number,
        open: candle[1] as number,
        high: candle[2] as number,
        low: candle[3] as number,
        close: candle[4] as number,
        volume: candle[5] as number,
      }));

      // Persist new bars to DuckDB (fire-and-forget, don't block response)
      if (fresh.length > 0) {
        const rows: OHLCVRow[] = fresh.map(b => ({
          symbol,
          exchange: this.exchangeId,
          asset_type: 'crypto',
          interval: timeframe,
          ts: new Date(b.timestamp),
          open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume,
        }));
        this.store.insertOHLCV(rows).catch(err => {
          process.stderr.write(`[ccxt] DuckDB write error: ${err?.message ?? err}\n`);
        }); // best-effort persist
      }

      // Merge cached + fresh, dedup by timestamp
      if (cached.length > 0 && fresh.length > 0) {
        const seen = new Set(cached.map(c => c.timestamp));
        const merged = cached.map(c => ({
          timestamp: c.timestamp, open: c.open, high: c.high,
          low: c.low, close: c.close, volume: c.volume,
        }));
        for (const f of fresh) {
          if (!seen.has(f.timestamp)) merged.push(f);
        }
        merged.sort((a, b) => a.timestamp - b.timestamp);
        return limit ? merged.slice(-limit) : merged;
      }

      return fresh.length > 0 ? fresh : cached.map(c => ({
        timestamp: c.timestamp, open: c.open, high: c.high,
        low: c.low, close: c.close, volume: c.volume,
      }));
    }

    // No store — direct fetch
    const ohlcv = await this.timed('fetchOHLCV', () => this.exchange.fetchOHLCV(symbol, timeframe, since, limit));
    return ohlcv.map(candle => ({
      timestamp: candle[0] as number,
      open: candle[1] as number,
      high: candle[2] as number,
      low: candle[3] as number,
      close: candle[4] as number,
      volume: candle[5] as number,
    }));
  }

  async getOrderBook(symbol: string, limit?: number): Promise<OrderBookResult> {
    await this.throttle();
    const ob = await this.timed('fetchOrderBook', () => this.exchange.fetchOrderBook(symbol, limit));
    const bids = ob.bids as [number, number][];
    const asks = ob.asks as [number, number][];
    const bestBid = bids.length > 0 ? bids[0][0] : undefined;
    const bestAsk = asks.length > 0 ? asks[0][0] : undefined;
    const mid = bestBid != null && bestAsk != null ? (bestBid + bestAsk) / 2 : undefined;
    const spread = bestBid != null && bestAsk != null ? bestAsk - bestBid : undefined;
    const spreadBps = mid != null && spread != null && mid > 0
      ? Math.round((spread / mid) * 10000 * 100) / 100
      : undefined;
    return {
      symbol,
      bids,
      asks,
      bestBid,
      bestAsk,
      mid,
      spread,
      spreadBps,
      timestamp: ob.timestamp,
    };
  }

  async getTrades(symbol: string, since?: number, limit?: number): Promise<TradeResult[]> {
    await this.throttle();
    const trades = await this.timed('fetchTrades', () => this.exchange.fetchTrades(symbol, since, limit));
    return trades.map(formatTrade);
  }

  async searchMarkets(query: string): Promise<MarketResult[]> {
    const markets = await this.exchange.loadMarkets();
    const q = query.toLowerCase();
    return Object.values(markets)
      .filter((m): m is NonNullable<typeof m> => m != null)
      .filter(m =>
        m.active !== false &&
        (str(m.symbol).toLowerCase().includes(q) ||
         str(m.base).toLowerCase().includes(q) ||
         str(m.quote).toLowerCase().includes(q))
      )
      .slice(0, 20)
      .map(formatMarket);
  }

  // ── Private: Account ─────────────────────────────────────

  async getBalance(): Promise<BalanceResult[]> {
    await this.throttle();
    const balance = await this.exchange.fetchBalance();
    const results: BalanceResult[] = [];
    const totals = (balance as any).total ?? {};
    const frees = (balance as any).free ?? {};
    const useds = (balance as any).used ?? {};
    for (const [currency, data] of Object.entries(totals)) {
      const total = data as number;
      if (total !== 0) {
        results.push({
          currency,
          free: (frees[currency] as number) ?? 0,
          used: (useds[currency] as number) ?? 0,
          total,
        });
      }
    }
    return results;
  }

  async getPositions(symbols?: string[]): Promise<PositionResult[]> {
    await this.throttle();
    if (typeof this.exchange.fetchPositions === 'function') {
      const positions = await this.exchange.fetchPositions(symbols);
      return positions.map((p: any) => ({
        symbol: str(p.symbol),
        side: str(p.side) || 'long',
        amount: p.contracts ?? p.contractSize ?? 0,
        unrealizedPnl: p.unrealizedPnl,
        entryPrice: p.entryPrice,
        currentPrice: p.markPrice ?? p.lastPrice,
      }));
    }
    // Fallback: return balances as "positions" for spot exchanges
    const balances = await this.getBalance();
    return balances.map(b => ({
      symbol: b.currency,
      side: 'long' as const,
      amount: b.total,
      unrealizedPnl: undefined,
      entryPrice: undefined,
      currentPrice: undefined,
    }));
  }

  // ── Private: Orders ──────────────────────────────────────

  async placeOrder(
    symbol: string,
    type: string,
    side: string,
    amount: number,
    price?: number,
  ): Promise<OrderResult> {
    if (type === 'limit' && (price === undefined || price === null)) {
      throw new Error('Limit orders require a price');
    }
    if (amount <= 0) {
      throw new Error('Order amount must be positive');
    }
    await this.throttle();
    await this.ensureMarkets();
    const roundedAmount = this.roundAmount(symbol, amount);
    const roundedPrice = price !== undefined ? this.roundPrice(symbol, price) : undefined;
    const order = await this.timed('createOrder', () => this.exchange.createOrder(symbol, type, side, roundedAmount, roundedPrice));
    const result = this.formatOrder(order);
    // Auto-record to trade journal (fire-and-forget)
    if (this.journal) {
      this.journal.record({
        id: result.id,
        exchange: this.exchangeId,
        symbol: result.symbol,
        side: result.side,
        type: result.type,
        amount: result.amount ?? 0,
        price: result.price ?? null,
        cost: (result.amount ?? 0) * (result.price ?? 0) || null,
        fee: null,
        feeCurrency: null,
        timestamp: result.timestamp ?? Date.now(),
        orderId: result.id,
        strategy: null,
      }).catch((err: any) => { process.stderr.write(`[ccxt] journal write error: ${err?.message ?? err}\n`); });
    }
    return result;
  }

  async cancelOrder(orderId: string, symbol?: string): Promise<void> {
    await this.throttle();
    await this.timed('cancelOrder', () => this.exchange.cancelOrder(orderId, symbol));
  }

  async modifyOrder(
    orderId: string,
    symbol: string,
    type: string,
    side: string,
    amount?: number,
    price?: number,
  ): Promise<OrderResult> {
    await this.ensureMarkets();
    await this.throttle();
    const roundedAmount = amount !== undefined ? this.roundAmount(symbol, amount) : undefined;
    const roundedPrice = price !== undefined ? this.roundPrice(symbol, price) : undefined;
    let raw: any;
    if (typeof this.exchange.editOrder === 'function') {
      raw = await this.exchange.editOrder(orderId, symbol, type, side, roundedAmount, roundedPrice);
    } else {
      // Fallback: cancel + replace (each call needs its own rate-limit token)
      await this.throttle();
      await this.exchange.cancelOrder(orderId, symbol);
      await this.throttle();
      raw = await this.exchange.createOrder(symbol, type, side, roundedAmount!, roundedPrice);
    }
    const result = this.formatOrder(raw);
    // Auto-record to trade journal (fire-and-forget)
    if (this.journal) {
      this.journal.record({
        id: result.id,
        exchange: this.exchangeId,
        symbol: result.symbol,
        side: result.side,
        type: result.type,
        amount: result.amount ?? 0,
        price: result.price ?? null,
        cost: (result.amount ?? 0) * (result.price ?? 0) || null,
        fee: null,
        feeCurrency: null,
        timestamp: result.timestamp ?? Date.now(),
        orderId: result.id,
        strategy: null,
      }).catch((err: any) => { process.stderr.write(`[ccxt] journal write error: ${err?.message ?? err}\n`); });
    }
    return result;
  }

  async cancelAllOrders(symbol?: string): Promise<void> {
    await this.throttle();
    if (typeof this.exchange.cancelAllOrders === 'function') {
      await this.exchange.cancelAllOrders(symbol);
    } else {
      const openOrders = await this.exchange.fetchOpenOrders(symbol);
      const results = await Promise.allSettled(
        openOrders.map(order => this.exchange.cancelOrder(order.id, order.symbol))
      );
      const failures = results.filter(r => r.status === 'rejected');
      if (failures.length > 0) {
        throw new Error(`Failed to cancel ${failures.length}/${openOrders.length} orders`);
      }
    }
  }

  async getOpenOrders(symbol?: string): Promise<OrderResult[]> {
    await this.throttle();
    const orders = await this.exchange.fetchOpenOrders(symbol);
    return orders.map(o => this.formatOrder(o));
  }

  async getClosedOrders(symbol?: string, since?: number, limit?: number): Promise<OrderResult[]> {
    await this.throttle();
    const orders = await this.exchange.fetchClosedOrders(symbol, since, limit);
    return orders.map(o => this.formatOrder(o));
  }

  async getOrder(orderId: string, symbol?: string): Promise<OrderResult> {
    await this.throttle();
    const order = await this.exchange.fetchOrder(orderId, symbol);
    return this.formatOrder(order);
  }

  async getMyTrades(symbol?: string, since?: number, limit?: number): Promise<TradeResult[]> {
    await this.throttle();
    const trades = await this.exchange.fetchMyTrades(symbol, since, limit);
    return trades.map(formatTrade);
  }

  // ── Public: Quoting & Fees ────────────────────────────────

  async getQuote(symbol: string): Promise<QuoteResult> {
    await this.throttle();
    const t = await this.timed('fetchTicker', () => this.exchange.fetchTicker(symbol));
    const bid = t.bid;
    const ask = t.ask;
    const mid = bid != null && ask != null ? (bid + ask) / 2 : undefined;
    const spread = bid != null && ask != null ? ask - bid : undefined;
    const spreadBps = mid != null && spread != null && mid > 0
      ? (spread / mid) * 10000
      : undefined;
    return {
      symbol: str(t.symbol),
      bid,
      bidSize: (t as any).bidVolume,
      ask,
      askSize: (t as any).askVolume,
      mid,
      spread,
      spreadBps: spreadBps != null ? Math.round(spreadBps * 100) / 100 : undefined,
      last: t.last,
      timestamp: t.timestamp,
    };
  }

  async getTradingFees(symbol?: string): Promise<FeeResult[]> {
    await this.ensureMarkets();
    if (symbol) {
      try {
        const fee = (this.exchange as any).calculateFee?.(symbol, 'limit', 'buy', 1, 1, 'taker');
        if (fee) {
          return [{
            symbol,
            maker: (this.exchange.markets[symbol] as any)?.maker,
            taker: (this.exchange.markets[symbol] as any)?.taker,
            percentage: true,
          }];
        }
      } catch { /* fallthrough */ }
    }
    // Try to get fees from market data (always available after loadMarkets)
    const results: FeeResult[] = [];
    const markets = this.exchange.markets;
    const symbols = symbol ? [symbol] : Object.keys(markets).slice(0, 10);
    for (const sym of symbols) {
      const m = markets[sym] as any;
      if (m) {
        results.push({
          symbol: sym,
          maker: m.maker,
          taker: m.taker,
          percentage: true,
        });
      }
    }
    return results;
  }

  async getExchangeInfo(): Promise<ExchangeInfoResult> {
    await this.ensureMarkets();
    const markets = this.exchange.markets;
    const allMarkets = Object.values(markets).filter(m => m != null);
    const activeMarkets = allMarkets.filter(m => (m as any).active !== false);
    const has: Record<string, boolean> = {};
    const capabilities = this.exchange.has as Record<string, any>;
    for (const key of [
      'fetchTicker', 'fetchOrderBook', 'fetchOHLCV', 'fetchTrades',
      'createOrder', 'editOrder', 'cancelOrder', 'cancelAllOrders',
      'fetchBalance', 'fetchPositions', 'fetchMyTrades',
      'createMarketOrder', 'createLimitOrder', 'createStopOrder',
      'fetchTradingFees', 'fetchFundingRate',
    ]) {
      has[key] = !!capabilities[key];
    }
    return {
      id: this.exchangeId,
      name: this.name,
      countries: (this.exchange as any).countries ?? [],
      rateLimit: (this.exchange as any).rateLimit ?? 0,
      has,
      timeframes: Object.keys((this.exchange as any).timeframes ?? {}),
      totalMarkets: allMarkets.length,
      activeMarkets: activeMarkets.length,
    };
  }

  async getMarketInfo(symbol: string): Promise<MarketResult & { maker: number | undefined; taker: number | undefined }> {
    await this.ensureMarkets();
    const m = this.exchange.markets[symbol] as any;
    if (!m) {
      throw new Error(`Market not found: ${symbol}`);
    }
    return {
      ...formatMarket(m),
      maker: m.maker,
      taker: m.taker,
    };
  }

  // ── Helpers ──────────────────────────────────────────────

  /**
   * Format a CCXT ticker into our typed interface.
   *
   * Handles exchanges (e.g. Coinbase) that return incomplete tickers:
   * - bid/ask may be empty strings or zero → normalized to undefined
   * - last may be missing → derived from bid/ask midpoint
   * - volume/high/low/change may be missing → left as undefined
   *   (callers must handle undefined gracefully)
   */
  private formatTicker(t: Ticker): TickerResult {
    // Sanitize: some exchanges return empty strings or 0 for missing fields
    const num = (v: unknown): number | undefined => {
      if (v == null || v === '' || v === 0) return undefined;
      const n = typeof v === 'string' ? parseFloat(v) : v;
      return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : undefined;
    };

    const bid = num(t.bid);
    const ask = num(t.ask);
    const last = num(t.last) ?? (bid != null && ask != null ? (bid + ask) / 2 : undefined);

    return {
      symbol: str(t.symbol),
      last,
      bid,
      ask,
      high: num(t.high),
      low: num(t.low),
      open: num(t.open),
      close: num(t.close),
      volume: num(t.baseVolume),
      quoteVolume: num(t.quoteVolume),
      change: t.change != null && t.change !== 0 ? t.change : undefined,
      percentage: t.percentage != null && t.percentage !== 0 ? t.percentage : undefined,
      timestamp: t.timestamp,
    };
  }

  private formatOrder(o: Order): OrderResult {
    return {
      id: o.id,
      clientOrderId: o.clientOrderId,
      symbol: str(o.symbol),
      side: str(o.side),
      type: str(o.type),
      amount: o.amount,
      filled: o.filled,
      remaining: o.remaining,
      price: o.price,
      average: o.average,
      status: o.status,
      timestamp: o.timestamp,
      datetime: o.datetime,
    };
  }
}
