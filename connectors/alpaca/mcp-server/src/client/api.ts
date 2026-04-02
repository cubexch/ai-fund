/**
 * Alpaca Trading API v2 client.
 *
 * Supports both paper and live trading. Paper trading is the default
 * (APCA_API_BASE_URL env var or constructor option).
 *
 * Auth: API key + secret via APCA-API-KEY-ID / APCA-API-SECRET-KEY headers.
 * Data: Alpaca Data API v2 for market data (quotes, bars, trades).
 */

// ── Constants ────────────────────────────────────────────────

const PAPER_BASE_URL = 'https://paper-api.alpaca.markets';
const LIVE_BASE_URL = 'https://api.alpaca.markets';
const DATA_BASE_URL = 'https://data.alpaca.markets';

// ── Types ────────────────────────────────────────────────────

export interface AlpacaAccount {
  id: string;
  account_number: string;
  status: string;
  currency: string;
  buying_power: string;
  cash: string;
  portfolio_value: string;
  pattern_day_trader: boolean;
  trading_blocked: boolean;
  transfers_blocked: boolean;
  account_blocked: boolean;
  daytrade_count: number;
  equity: string;
  last_equity: string;
  long_market_value: string;
  short_market_value: string;
}

export interface AlpacaPosition {
  asset_id: string;
  symbol: string;
  exchange: string;
  asset_class: string;
  avg_entry_price: string;
  qty: string;
  side: string;
  market_value: string;
  cost_basis: string;
  unrealized_pl: string;
  unrealized_plpc: string;
  current_price: string;
  lastday_price: string;
  change_today: string;
}

export interface AlpacaOrder {
  id: string;
  client_order_id: string;
  created_at: string;
  updated_at: string;
  submitted_at: string;
  filled_at: string | null;
  expired_at: string | null;
  canceled_at: string | null;
  asset_id: string;
  symbol: string;
  asset_class: string;
  qty: string;
  filled_qty: string;
  filled_avg_price: string | null;
  order_class: string;
  type: string;
  side: string;
  time_in_force: string;
  limit_price: string | null;
  stop_price: string | null;
  status: string;
}

export interface AlpacaBar {
  t: string;   // timestamp ISO
  o: number;   // open
  h: number;   // high
  l: number;   // low
  c: number;   // close
  v: number;   // volume
  n: number;   // trade count
  vw: number;  // vwap
}

export interface AlpacaQuote {
  t: string;
  ax: string;  // ask exchange
  ap: number;  // ask price
  as: number;  // ask size
  bx: string;  // bid exchange
  bp: number;  // bid price
  bs: number;  // bid size
}

export interface AlpacaSnapshot {
  latestTrade: { t: string; p: number; s: number };
  latestQuote: AlpacaQuote;
  minuteBar: AlpacaBar;
  dailyBar: AlpacaBar;
  prevDailyBar: AlpacaBar;
}

export interface AlpacaAsset {
  id: string;
  class: string;
  exchange: string;
  symbol: string;
  name: string;
  status: string;
  tradable: boolean;
  marginable: boolean;
  shortable: boolean;
  fractionable: boolean;
}

export interface AlpacaClock {
  timestamp: string;
  is_open: boolean;
  next_open: string;
  next_close: string;
}

export interface AlpacaActivity {
  id: string;
  activity_type: string;
  symbol: string;
  side: string;
  qty: string;
  price: string;
  cum_qty: string;
  leaves_qty: string;
  order_id: string;
  transaction_time: string;
  type: string;
}

export interface AlpacaTrade {
  t: string;   // timestamp
  x: string;   // exchange
  p: number;   // price
  s: number;   // size
  c: string[];  // conditions
  i: number;   // trade ID
  z: string;   // tape
}

export interface ModifyOrderRequest {
  qty?: string;
  time_in_force?: string;
  limit_price?: string;
  stop_price?: string;
  trail?: string;
}

export interface OrderRequest {
  symbol: string;
  qty?: string;
  notional?: string;
  side: 'buy' | 'sell';
  type: 'market' | 'limit' | 'stop' | 'stop_limit' | 'trailing_stop';
  time_in_force: 'day' | 'gtc' | 'opg' | 'cls' | 'ioc' | 'fok';
  limit_price?: string;
  stop_price?: string;
  trail_price?: string;
  trail_percent?: string;
}

// ── Fetch function type (injectable for testing) ─────────────

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

// ── Client ──────────────────────────────────────────────────

export class AlpacaClient {
  private tradingBaseUrl: string;
  private dataBaseUrl: string;
  private apiKey: string;
  private apiSecret: string;
  private fetchFn: FetchFn;

  constructor(opts?: {
    apiKey?: string;
    apiSecret?: string;
    paper?: boolean;
    tradingBaseUrl?: string;
    dataBaseUrl?: string;
    fetchFn?: FetchFn;
  }) {
    this.apiKey = opts?.apiKey ?? process.env.APCA_API_KEY_ID ?? '';
    this.apiSecret = opts?.apiSecret ?? process.env.APCA_API_SECRET_KEY ?? '';

    const paper = opts?.paper ?? (process.env.APCA_PAPER !== 'false');
    this.tradingBaseUrl = opts?.tradingBaseUrl ?? (paper ? PAPER_BASE_URL : LIVE_BASE_URL);
    this.dataBaseUrl = opts?.dataBaseUrl ?? DATA_BASE_URL;
    this.fetchFn = opts?.fetchFn ?? globalThis.fetch;
  }

  get isPaper(): boolean {
    return this.tradingBaseUrl.includes('paper');
  }

  get hasCredentials(): boolean {
    return this.apiKey !== '' && this.apiSecret !== '';
  }

  // ── Account ──────────────────────────────────────────────

  async getAccount(): Promise<AlpacaAccount> {
    return this.tradingRequest<AlpacaAccount>('GET', '/v2/account');
  }

  // ── Positions ────────────────────────────────────────────

  async getPositions(): Promise<AlpacaPosition[]> {
    return this.tradingRequest<AlpacaPosition[]>('GET', '/v2/positions');
  }

  async getPosition(symbol: string): Promise<AlpacaPosition> {
    return this.tradingRequest<AlpacaPosition>('GET', `/v2/positions/${encodeURIComponent(symbol)}`);
  }

  async closePosition(symbol: string, opts?: { qty?: string; percentage?: string }): Promise<AlpacaOrder> {
    const params = new URLSearchParams();
    if (opts?.qty) params.set('qty', opts.qty);
    if (opts?.percentage) params.set('percentage', opts.percentage);
    const qs = params.toString();
    const path = `/v2/positions/${encodeURIComponent(symbol)}${qs ? '?' + qs : ''}`;
    return this.tradingRequest<AlpacaOrder>('DELETE', path);
  }

  async closeAllPositions(cancelOrders?: boolean): Promise<AlpacaOrder[]> {
    const params = cancelOrders ? '?cancel_orders=true' : '';
    return this.tradingRequest<AlpacaOrder[]>('DELETE', `/v2/positions${params}`);
  }

  // ── Orders ───────────────────────────────────────────────

  async getOrders(opts?: {
    status?: 'open' | 'closed' | 'all';
    limit?: number;
    after?: string;
    until?: string;
    direction?: 'asc' | 'desc';
    symbols?: string[];
  }): Promise<AlpacaOrder[]> {
    const params = new URLSearchParams();
    if (opts?.status) params.set('status', opts.status);
    if (opts?.limit) params.set('limit', String(opts.limit));
    if (opts?.after) params.set('after', opts.after);
    if (opts?.until) params.set('until', opts.until);
    if (opts?.direction) params.set('direction', opts.direction);
    if (opts?.symbols) params.set('symbols', opts.symbols.join(','));
    const qs = params.toString();
    return this.tradingRequest<AlpacaOrder[]>('GET', `/v2/orders${qs ? '?' + qs : ''}`);
  }

  async getOrder(orderId: string): Promise<AlpacaOrder> {
    return this.tradingRequest<AlpacaOrder>('GET', `/v2/orders/${orderId}`);
  }

  async placeOrder(order: OrderRequest): Promise<AlpacaOrder> {
    return this.tradingRequest<AlpacaOrder>('POST', '/v2/orders', order);
  }

  async cancelOrder(orderId: string): Promise<void> {
    await this.tradingRequest<void>('DELETE', `/v2/orders/${orderId}`);
  }

  async cancelAllOrders(): Promise<{ id: string; status: number; body: unknown }[]> {
    return this.tradingRequest('DELETE', '/v2/orders');
  }

  async modifyOrder(orderId: string, changes: ModifyOrderRequest): Promise<AlpacaOrder> {
    return this.tradingRequest<AlpacaOrder>('PATCH', `/v2/orders/${orderId}`, changes);
  }

  // ── Account Activities (fills, order updates) ────────────

  async getActivities(activityType?: string, opts?: {
    date?: string;
    after?: string;
    until?: string;
    direction?: 'asc' | 'desc';
    pageSize?: number;
    symbols?: string[];
  }): Promise<AlpacaActivity[]> {
    const params = new URLSearchParams();
    if (opts?.date) params.set('date', opts.date);
    if (opts?.after) params.set('after', opts.after);
    if (opts?.until) params.set('until', opts.until);
    if (opts?.direction) params.set('direction', opts.direction);
    if (opts?.pageSize) params.set('page_size', String(opts.pageSize));
    if (opts?.symbols) params.set('symbols', opts.symbols.join(','));
    const qs = params.toString();
    const path = activityType
      ? `/v2/account/activities/${activityType}${qs ? '?' + qs : ''}`
      : `/v2/account/activities${qs ? '?' + qs : ''}`;
    return this.tradingRequest<AlpacaActivity[]>('GET', path);
  }

  // ── Market Data ──────────────────────────────────────────

  async getBars(symbol: string, opts: {
    timeframe: string;
    start?: string;
    end?: string;
    limit?: number;
  }): Promise<AlpacaBar[]> {
    const params = new URLSearchParams();
    params.set('timeframe', opts.timeframe);
    if (opts.start) params.set('start', opts.start);
    if (opts.end) params.set('end', opts.end);
    if (opts.limit) params.set('limit', String(opts.limit));

    const res = await this.dataRequest<{ bars: AlpacaBar[]; next_page_token: string | null }>(
      'GET',
      `/v2/stocks/${encodeURIComponent(symbol)}/bars?${params.toString()}`,
    );
    return res.bars;
  }

  async getLatestQuote(symbol: string): Promise<AlpacaQuote> {
    const res = await this.dataRequest<{ quote: AlpacaQuote }>(
      'GET',
      `/v2/stocks/${encodeURIComponent(symbol)}/quotes/latest`,
    );
    return res.quote;
  }

  async getTrades(symbol: string, opts?: {
    start?: string;
    end?: string;
    limit?: number;
  }): Promise<AlpacaTrade[]> {
    const params = new URLSearchParams();
    if (opts?.start) params.set('start', opts.start);
    if (opts?.end) params.set('end', opts.end);
    if (opts?.limit) params.set('limit', String(opts.limit));
    const qs = params.toString();
    const res = await this.dataRequest<{ trades: AlpacaTrade[]; next_page_token: string | null }>(
      'GET',
      `/v2/stocks/${encodeURIComponent(symbol)}/trades${qs ? '?' + qs : ''}`,
    );
    return res.trades;
  }

  async getSnapshots(symbols: string[]): Promise<Record<string, AlpacaSnapshot>> {
    const params = new URLSearchParams();
    params.set('symbols', symbols.join(','));
    return this.dataRequest<Record<string, AlpacaSnapshot>>(
      'GET',
      `/v2/stocks/snapshots?${params.toString()}`,
    );
  }

  // ── Assets ───────────────────────────────────────────────

  async getAssets(opts?: { status?: string; asset_class?: string }): Promise<AlpacaAsset[]> {
    const params = new URLSearchParams();
    if (opts?.status) params.set('status', opts.status);
    if (opts?.asset_class) params.set('asset_class', opts.asset_class);
    const qs = params.toString();
    return this.tradingRequest<AlpacaAsset[]>('GET', `/v2/assets${qs ? '?' + qs : ''}`);
  }

  async getAsset(symbolOrId: string): Promise<AlpacaAsset> {
    return this.tradingRequest<AlpacaAsset>('GET', `/v2/assets/${encodeURIComponent(symbolOrId)}`);
  }

  // ── Clock ────────────────────────────────────────────────

  async getClock(): Promise<AlpacaClock> {
    return this.tradingRequest<AlpacaClock>('GET', '/v2/clock');
  }

  // ── Internal ─────────────────────────────────────────────

  private async tradingRequest<T>(method: string, path: string, body?: unknown): Promise<T> {
    return this.request<T>(this.tradingBaseUrl, method, path, body);
  }

  private async dataRequest<T>(method: string, path: string): Promise<T> {
    return this.request<T>(this.dataBaseUrl, method, path);
  }

  private async request<T>(baseUrl: string, method: string, path: string, body?: unknown): Promise<T> {
    const url = `${baseUrl}${path}`;
    const headers: Record<string, string> = {
      'APCA-API-KEY-ID': this.apiKey,
      'APCA-API-SECRET-KEY': this.apiSecret,
      'Accept': 'application/json',
    };

    const init: RequestInit = { method, headers };
    if (body) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }

    const res = await this.fetchFn(url, init);

    // DELETE with 204 returns no body
    if (res.status === 204) {
      return undefined as T;
    }

    const text = await res.text();

    if (!res.ok) {
      let message = `Alpaca API error (${res.status})`;
      try {
        const err = JSON.parse(text);
        if (err.message) message += `: ${err.message}`;
      } catch {
        if (text) message += `: ${text}`;
      }
      throw new Error(message);
    }

    if (!text) return undefined as T;
    return JSON.parse(text) as T;
  }
}
