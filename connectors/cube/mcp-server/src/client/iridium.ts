import { getCredentials, getEnvironment } from './auth.js';

/**
 * Iridium REST client for Cube Exchange.
 * Handles: markets, positions, balances, order history, fees.
 */
export class IridiumClient {
  private baseUrl: string;
  private apiKey: string;
  private secretKey: string;

  constructor() {
    const env = getEnvironment(process.env.CUBE_ENV);
    const creds = getCredentials();
    this.baseUrl = env.restUrl;
    this.apiKey = creds.apiKey;
    this.secretKey = creds.secretKey;
  }

  private async request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-api-key': this.apiKey,
    };

    const response = await fetch(url, {
      ...options,
      headers: { ...headers, ...(options.headers as Record<string, string>) },
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Iridium ${response.status}: ${body}`);
    }

    const json = await response.json();
    return json.result ?? json;
  }

  // ── Markets ──────────────────────────────────────────────

  async getMarkets(): Promise<Market[]> {
    return this.request<Market[]>('/markets');
  }

  async getMarket(marketId: number): Promise<Market> {
    return this.request<Market>(`/markets/${marketId}`);
  }

  // ── Tickers / Prices ─────────────────────────────────────

  async getTickers(): Promise<Ticker[]> {
    return this.request<Ticker[]>('/tickers');
  }

  async getPriceHistory(marketId: number, interval: string = '1h', limit: number = 100): Promise<Kline[]> {
    return this.request<Kline[]>(`/history/prices?marketId=${marketId}&interval=${interval}&limit=${limit}`);
  }

  // ── Account ──────────────────────────────────────────────

  async getSubaccounts(): Promise<Subaccount[]> {
    return this.request<Subaccount[]>('/users/subaccounts');
  }

  async getPositions(subaccountId: number): Promise<Position[]> {
    return this.request<Position[]>(`/users/subaccount/${subaccountId}/positions`);
  }

  async getBalances(subaccountId: number): Promise<Balance[]> {
    return this.request<Balance[]>(`/users/subaccount/${subaccountId}/balances`);
  }

  // ── Order History ────────────────────────────────────────

  async getOrderHistory(
    subaccountId: number,
    params: { marketId?: number; limit?: number } = {}
  ): Promise<HistoricalOrder[]> {
    const qs = new URLSearchParams();
    if (params.marketId) qs.set('marketId', String(params.marketId));
    if (params.limit) qs.set('limit', String(params.limit));
    const query = qs.toString() ? `?${qs}` : '';
    return this.request<HistoricalOrder[]>(`/users/subaccount/${subaccountId}/orders${query}`);
  }

  async getFills(subaccountId: number, params: { marketId?: number; limit?: number } = {}): Promise<Fill[]> {
    const qs = new URLSearchParams();
    if (params.marketId) qs.set('marketId', String(params.marketId));
    if (params.limit) qs.set('limit', String(params.limit));
    const query = qs.toString() ? `?${qs}` : '';
    return this.request<Fill[]>(`/users/subaccount/${subaccountId}/fills${query}`);
  }

  // ── Fees ─────────────────────────────────────────────────

  async getEstimatedFees(marketId: number, side: string, quantity: string): Promise<FeeEstimate> {
    return this.request<FeeEstimate>(`/fees/estimate?marketId=${marketId}&side=${side}&quantity=${quantity}`);
  }
}

// ── Types ──────────────────────────────────────────────────

export interface Market {
  marketId: number;
  symbol: string;
  baseAssetId: number;
  quoteAssetId: number;
  baseSymbol: string;
  quoteSymbol: string;
  pricePrecision: number;
  quantityPrecision: number;
  minQuantity: string;
  maxQuantity: string;
  status: string;
}

export interface Ticker {
  marketId: number;
  symbol: string;
  lastPrice: string;
  bidPrice: string;
  askPrice: string;
  volume24h: string;
  high24h: string;
  low24h: string;
  change24h: string;
}

export interface Kline {
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  startTime: number;
  interval: string;
}

export interface Subaccount {
  subaccountId: number;
  name: string;
}

export interface Position {
  assetId: number;
  symbol: string;
  total: string;
  available: string;
}

export interface Balance {
  assetId: number;
  symbol: string;
  total: string;
  available: string;
}

export interface HistoricalOrder {
  orderId: string;
  clientOrderId: string;
  marketId: number;
  symbol: string;
  side: string;
  orderType: string;
  price: string;
  quantity: string;
  filledQuantity: string;
  status: string;
  createdAt: string;
}

export interface Fill {
  tradeId: string;
  orderId: string;
  marketId: number;
  symbol: string;
  side: string;
  price: string;
  quantity: string;
  fee: string;
  feeAsset: string;
  timestamp: string;
}

export interface FeeEstimate {
  makerFee: string;
  takerFee: string;
  estimatedFee: string;
}
