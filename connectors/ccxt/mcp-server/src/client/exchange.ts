/**
 * Universal CCXT exchange client wrapper.
 *
 * Wraps any CCXT exchange instance behind a typed interface that maps
 * to the ai-fund unified tool API. Public methods (market data) work
 * without credentials. Private methods (trading, account) require
 * API key + secret.
 */

import ccxt, { type Exchange, type Ticker, type Order } from 'ccxt';

// ── Types ────────────────────────────────────────────────────

export interface ExchangeClientOpts {
  exchangeId: string;
  apiKey?: string;
  secret?: string;
  password?: string;
  sandbox?: boolean;
  exchangeInstance?: Exchange;
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
  private exchange: Exchange;
  private _sandbox: boolean;
  readonly exchangeId: string;

  constructor(opts: ExchangeClientOpts) {
    this.exchangeId = opts.exchangeId;
    this._sandbox = opts.sandbox ?? false;

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

  // ── Public: Market Data ──────────────────────────────────

  async loadMarkets(): Promise<MarketResult[]> {
    const markets = await this.exchange.loadMarkets();
    return Object.values(markets)
      .filter((m): m is NonNullable<typeof m> => m != null)
      .map(formatMarket);
  }

  async getTicker(symbol: string): Promise<TickerResult> {
    const t = await this.exchange.fetchTicker(symbol);
    return this.formatTicker(t);
  }

  async getTickers(symbols?: string[]): Promise<TickerResult[]> {
    const tickers = await this.exchange.fetchTickers(symbols);
    return Object.values(tickers).map(t => this.formatTicker(t));
  }

  async getBars(symbol: string, timeframe: string, since?: number, limit?: number): Promise<BarResult[]> {
    const ohlcv = await this.exchange.fetchOHLCV(symbol, timeframe, since, limit);
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
    const ob = await this.exchange.fetchOrderBook(symbol, limit);
    return {
      symbol,
      bids: ob.bids as [number, number][],
      asks: ob.asks as [number, number][],
      timestamp: ob.timestamp,
    };
  }

  async getTrades(symbol: string, since?: number, limit?: number): Promise<TradeResult[]> {
    const trades = await this.exchange.fetchTrades(symbol, since, limit);
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
    const balance = await this.exchange.fetchBalance();
    const results: BalanceResult[] = [];
    const totals = (balance as any).total ?? {};
    const frees = (balance as any).free ?? {};
    const useds = (balance as any).used ?? {};
    for (const [currency, data] of Object.entries(totals)) {
      const total = data as number;
      if (total > 0) {
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
    const order = await this.exchange.createOrder(symbol, type, side, amount, price);
    return this.formatOrder(order);
  }

  async cancelOrder(orderId: string, symbol?: string): Promise<void> {
    await this.exchange.cancelOrder(orderId, symbol);
  }

  async cancelAllOrders(symbol?: string): Promise<void> {
    if (typeof this.exchange.cancelAllOrders === 'function') {
      await this.exchange.cancelAllOrders(symbol);
    } else {
      const openOrders = await this.exchange.fetchOpenOrders(symbol);
      await Promise.all(
        openOrders.map(order => this.exchange.cancelOrder(order.id, order.symbol))
      );
    }
  }

  async getOpenOrders(symbol?: string): Promise<OrderResult[]> {
    const orders = await this.exchange.fetchOpenOrders(symbol);
    return orders.map(o => this.formatOrder(o));
  }

  async getClosedOrders(symbol?: string, since?: number, limit?: number): Promise<OrderResult[]> {
    const orders = await this.exchange.fetchClosedOrders(symbol, since, limit);
    return orders.map(o => this.formatOrder(o));
  }

  async getOrder(orderId: string, symbol?: string): Promise<OrderResult> {
    const order = await this.exchange.fetchOrder(orderId, symbol);
    return this.formatOrder(order);
  }

  async getMyTrades(symbol?: string, since?: number, limit?: number): Promise<TradeResult[]> {
    const trades = await this.exchange.fetchMyTrades(symbol, since, limit);
    return trades.map(formatTrade);
  }

  // ── Helpers ──────────────────────────────────────────────

  private formatTicker(t: Ticker): TickerResult {
    return {
      symbol: str(t.symbol),
      last: t.last,
      bid: t.bid,
      ask: t.ask,
      high: t.high,
      low: t.low,
      open: t.open,
      close: t.close,
      volume: t.baseVolume,
      quoteVolume: t.quoteVolume,
      change: t.change,
      percentage: t.percentage,
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
