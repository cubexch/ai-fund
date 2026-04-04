import { buildAuthHeaders, getEnvironment, resetAuth } from './auth';
import { ASSET_ICONS } from '@ai-fund/lib/format';

// ── Interval helpers ─────────────────────────────────────

const INTERVAL_SECONDS: Record<string, number> = {
  '1s': 1, '1m': 60, '3m': 180, '5m': 300, '15m': 900, '30m': 1800,
  '1h': 3600, '2h': 7200, '4h': 14400, '6h': 21600, '8h': 28800, '12h': 43200,
  '1d': 86400, '3d': 259200, '1w': 604800, '1M': 2592000,
};

// ── Asset Registry ────────────────────────────────────────

export interface AssetInfo {
  assetId: number;
  symbol: string;
  icon: string;
}

/**
 * Maps assetId → symbol. Built from markets data on first access.
 * Also supports symbol → assetId lookups.
 */
export class AssetRegistry {
  private byId = new Map<number, AssetInfo>();
  private bySymbol = new Map<string, AssetInfo>();

  buildFromMarkets(markets: Market[]): void {
    for (const m of markets) {
      const symbol = m.symbol;
      const quoteAssets = ['USDC', 'USDT'];
      let base = symbol;
      let quote = '';
      for (const q of quoteAssets) {
        if (symbol.endsWith(q) && symbol.length > q.length) {
          base = symbol.slice(0, -q.length);
          quote = q;
          break;
        }
      }

      if (base && !this.byId.has(m.baseAssetId)) {
        const info: AssetInfo = {
          assetId: m.baseAssetId,
          symbol: base,
          icon: ASSET_ICONS[base] ?? '',
        };
        this.byId.set(m.baseAssetId, info);
        this.bySymbol.set(base, info);
      }
      if (quote && !this.byId.has(m.quoteAssetId)) {
        const info: AssetInfo = {
          assetId: m.quoteAssetId,
          symbol: quote,
          icon: ASSET_ICONS[quote] ?? '',
        };
        this.byId.set(m.quoteAssetId, info);
        this.bySymbol.set(quote, info);
      }
    }
  }

  getById(assetId: number): AssetInfo | undefined {
    return this.byId.get(assetId);
  }

  getBySymbol(symbol: string): AssetInfo | undefined {
    return this.bySymbol.get(symbol.toUpperCase());
  }

  getSymbol(assetId: number): string {
    return this.byId.get(assetId)?.symbol ?? `ASSET-${assetId}`;
  }

  allAssets(): AssetInfo[] {
    return [...this.byId.values()];
  }
}

/**
 * Iridium REST client for Cube Exchange.
 *
 * Three base URLs:
 * - restUrl (/ir/v0): markets, klines, authenticated account endpoints
 * - mdRestUrl (/md): parsed tickers, order book snapshots, recent trades
 * - osRestUrl (/os/v0): order placement, cancellation, modification
 *
 * Auth requirements:
 * - PUBLIC (no auth): markets, tickers, order book, recent trades, klines, token search
 * - AUTHENTICATED (verification key): positions, orders, fills, fees, subaccounts
 * - AUTHENTICATED (verification key): place/cancel/modify orders via Osmium REST
 */
export class IridiumClient {
  private baseUrl: string;
  private mdBaseUrl: string;
  private osBaseUrl: string;
  private _subaccountId: number | null = null;
  private _subaccountPromise: Promise<number> | null = null;
  private _assetRegistry: AssetRegistry | null = null;
  private _assetRegistryPromise: Promise<AssetRegistry> | null = null;
  private _sources: Map<number, Source> | null = null;
  private _sourcesPromise: Promise<Map<number, Source>> | null = null;

  constructor() {
    const env = getEnvironment(process.env.CUBE_ENV);
    this.baseUrl = env.restUrl;
    this.mdBaseUrl = env.mdRestUrl;
    this.osBaseUrl = env.osRestUrl;
    resetAuth();
  }

  /** Whether this client is connected to staging (testnet) environment. */
  isStaging(): boolean {
    return this.baseUrl.includes('staging');
  }

  /**
   * Get or build the asset registry from markets data.
   * Fetches once on first call, then caches.
   */
  async getAssetRegistry(): Promise<AssetRegistry> {
    if (this._assetRegistry) return this._assetRegistry;

    if (!this._assetRegistryPromise) {
      this._assetRegistryPromise = this.getActiveMarkets().then(markets => {
        const registry = new AssetRegistry();
        registry.buildFromMarkets(markets);
        this._assetRegistry = registry;
        return registry;
      });
    }

    return this._assetRegistryPromise;
  }

  /**
   * Auto-discover the default subaccount ID from the API.
   * Fetches once on first authenticated call, then caches.
   * REQUIRES AUTH.
   */
  async getDefaultSubaccountId(): Promise<number> {
    if (this._subaccountId !== null) return this._subaccountId;

    if (!this._subaccountPromise) {
      this._subaccountPromise = this.request<SubaccountIds>(
        '/users/subaccounts', {}, { authenticated: 'iridium' }
      ).then(result => {
        if (!result.ids || result.ids.length === 0) {
          throw new Error('No subaccounts found for this API key.');
        }
        this._subaccountId = result.ids[0];
        return this._subaccountId;
      });
    }

    return this._subaccountPromise;
  }

  private async request<T>(
    path: string,
    options: RequestInit = {},
    opts: {
      authenticated?: false | 'iridium' | 'osmium';
      useMd?: boolean;
      useOs?: boolean;
    } = {}
  ): Promise<T> {
    const base = opts.useOs ? this.osBaseUrl : opts.useMd ? this.mdBaseUrl : this.baseUrl;
    const url = `${base}${path}`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (opts.authenticated) {
      const target = opts.authenticated === 'iridium' ? 'iridium' : 'osmium';
      const method = (options.method || 'GET').toUpperCase();
      // Sign only the path (no query string) — Iridium validates against the base path
      const pathOnly = path.split('?')[0];
      const authHeaders = await buildAuthHeaders(target, method, pathOnly);
      if (Object.keys(authHeaders).length === 0) {
        throw new Error(
          'No credentials available. Run `npm run login` to authenticate, ' +
          'or set CUBE_SIGNING_KEY + CUBE_VERIFICATION_KEY_ID.'
        );
      }
      Object.assign(headers, authHeaders);
    }

    const response = await fetch(url, {
      ...options,
      headers: { ...headers, ...(options.headers as Record<string, string>) },
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Cube ${response.status}: ${body}`);
    }

    const json = (await response.json()) as Record<string, unknown>;
    return (json.result ?? json) as T;
  }

  // ── PUBLIC: Markets (/ir/v0, no auth) ──────────────────

  async getMarkets(): Promise<Market[]> {
    const data = await this.request<{ markets: Market[]; sources: Source[] }>('/markets');
    // Cache sources from the same response
    if (data.sources && !this._sources) {
      this._sources = new Map(data.sources.map(s => [s.sourceId, s]));
    }
    return data.markets;
  }

  /** Get only active markets (status === 1). Use this for all trading and market selection. */
  async getActiveMarkets(): Promise<Market[]> {
    const markets = await this.getMarkets();
    return markets.filter(m => m.status === 1);
  }

  /** Get all chain/network sources. Cached from the /markets response. */
  async getSources(): Promise<Map<number, Source>> {
    if (this._sources) return this._sources;
    if (!this._sourcesPromise) {
      this._sourcesPromise = this.getMarkets().then(() => {
        return this._sources!;
      });
    }
    return this._sourcesPromise;
  }

  // ── PUBLIC: Tickers (/md, no auth) ─────────────────────

  async getTickers(): Promise<Ticker[]> {
    const parsed = await this.request<ParsedTicker[]>('/parsed/tickers', {}, { useMd: true });
    return parsed.map(t => ({
      symbol: t.ticker_id,
      baseAsset: t.base_currency,
      baseIcon: ASSET_ICONS[t.base_currency] ?? '',
      quoteAsset: t.quote_currency,
      quoteIcon: ASSET_ICONS[t.quote_currency] ?? '',
      lastPrice: t.last_price,
      bidPrice: t.bid,
      askPrice: t.ask,
      baseVolume24h: t.base_volume,
      quoteVolume24h: t.quote_volume,
      high24h: t.high,
      low24h: t.low,
      open24h: t.open,
      change24h: t.open && t.last_price
        ? (((t.last_price - t.open) / t.open) * 100)
        : null,
      timestamp: t.timestamp,
    }));
  }

  // ── PUBLIC: Order Book (/md, no auth) ──────────────────

  async getOrderBook(marketSymbol: string): Promise<ParsedOrderBook> {
    return this.request<ParsedOrderBook>(
      `/parsed/book/${marketSymbol}/snapshot`, {}, { useMd: true }
    );
  }

  // ── PUBLIC: Recent Trades (/md, no auth) ───────────────

  async getRecentTrades(marketSymbol: string): Promise<ParsedRecentTrades> {
    return this.request<ParsedRecentTrades>(
      `/parsed/book/${marketSymbol}/recent-trades`, {}, { useMd: true }
    );
  }

  // ── PUBLIC: Price History (/ir/v0, no auth) ────────────

  async getPriceHistory(marketId: number, interval: string = '1h', limit: number = 100): Promise<Kline[]> {
    // endTime defaults to current time on the backend (seconds).
    // Round up to interval boundary to match frontend chart behavior.
    const intervalSec = INTERVAL_SECONDS[interval] ?? 3600;
    const endTime = Math.ceil(Date.now() / 1000 / intervalSec) * intervalSec;

    const raw = await this.request<number[][]>(
      `/history/klines?marketId=${marketId}&interval=${interval}&limit=${limit}&endTime=${endTime}&fallback=external`
    );
    return raw.map(k => ({
      open: String(k[1]),
      high: String(k[2]),
      low: String(k[3]),
      close: String(k[4]),
      volume: String(k[5]),
      startTime: k[0],
      interval,
    }));
  }

  // ── AUTHENTICATED: Account (/ir/v0, requires login) ───

  async getSubaccounts(): Promise<SubaccountIds> {
    return this.request<SubaccountIds>('/users/subaccounts', {}, { authenticated: 'iridium' });
  }

  async getSubaccountDetail(subaccountId: number): Promise<SubaccountDetail> {
    const data = await this.request<{ result: SubaccountDetail }>(
      `/users/subaccount/${subaccountId}`, {}, { authenticated: 'iridium' }
    );
    return data.result;
  }

  async getDepositHistory(subaccountId: number, params: { limit?: number; cursor?: string } = {}): Promise<DepositRecord[]> {
    const qs = new URLSearchParams();
    if (params.limit) qs.set('limit', String(params.limit));
    if (params.cursor) qs.set('cursor', params.cursor);
    const query = qs.toString() ? `?${qs}` : '';
    const data = await this.request<{ result: DepositRecord[] }>(
      `/users/subaccount/${subaccountId}/deposits${query}`, {}, { authenticated: 'iridium' }
    );
    return data.result;
  }

  /**
   * Get wallet assets for a subaccount via single /wallet/assets call.
   *
   * The API returns { assets: [...metadata], positions: [...amounts] } as separate arrays
   * (WalletAsset.amount is #[serde(skip)] — see core/iridium/src/web/wallet.rs:1561).
   * This method joins them by assetId and converts raw amounts using decimals.
   */
  async getWalletAssets(subaccountId: number): Promise<WalletAsset[]> {
    const data = await this.request<{
      assets: Array<{ assetId: number; sourceId: number; decimals: number; defaultDisplayDecimals: number; symbol: string; usdRate: number; address?: string }>;
      positions: Array<{ assetId: number; amount: string }>;
    }>(
      `/wallet/assets?subaccountId=${subaccountId}`, {}, { authenticated: 'iridium' }
    );

    // Build position lookup by assetId
    const positionMap = new Map<number, string>();
    for (const pos of (data.positions ?? [])) {
      positionMap.set(pos.assetId, pos.amount);
    }

    // Merge: asset metadata + position amount (converted from raw integer to decimal)
    return (data.assets ?? []).map(asset => {
      const rawAmount = positionMap.get(asset.assetId) ?? '0';
      const amount = (Number(rawAmount) / Math.pow(10, asset.decimals)).toString();
      return {
        ...asset,
        amount,
        availableAmount: amount,
      };
    }).filter(a => a.amount !== '0');
  }

  /**
   * Get positions for a subaccount.
   * Uses /wallet/assets (supports verification key auth).
   */
  async getPositions(subaccountId: number): Promise<Record<string, PositionGroup>> {
    const assets = await this.getWalletAssets(subaccountId);
    const groups: Record<string, PositionGroup> = {};
    for (const asset of assets) {
      const amount = asset.amount ?? asset.availableAmount ?? '0';
      if (amount === '0') continue;
      const key = asset.symbol;
      if (!groups[key]) {
        groups[key] = { name: key, inner: [] };
      }
      groups[key].inner.push({
        assetId: asset.assetId,
        accountingType: 'available',
        amount,
        receivedAmount: amount,
        pendingDeposits: asset.pendingAmount ?? '0',
        symbol: asset.symbol,
        usdRate: asset.usdRate,
        decimals: asset.decimals,
      });
    }
    return groups;
  }

  // ── AUTHENTICATED: Order History (/ir/v0, requires login)

  async getOrderHistory(
    subaccountId: number,
    params: { marketId?: number; limit?: number } = {}
  ): Promise<HistoricalOrder[]> {
    const qs = new URLSearchParams();
    if (params.marketId) qs.set('marketId', String(params.marketId));
    if (params.limit) qs.set('limit', String(params.limit));
    const query = qs.toString() ? `?${qs}` : '';
    const raw = await this.request<any>(
      `/users/subaccount/${subaccountId}/orders${query}`, {}, { authenticated: 'iridium' }
    );
    if (Array.isArray(raw)) return raw;
    if (raw?.orders && Array.isArray(raw.orders)) return raw.orders;
    return [];
  }

  async getFills(subaccountId: number, params: { marketId?: number; limit?: number } = {}): Promise<Fill[]> {
    const qs = new URLSearchParams();
    if (params.marketId) qs.set('marketId', String(params.marketId));
    if (params.limit) qs.set('limit', String(params.limit));
    const query = qs.toString() ? `?${qs}` : '';
    const raw = await this.request<any>(
      `/users/subaccount/${subaccountId}/fills${query}`, {}, { authenticated: 'iridium' }
    );
    if (Array.isArray(raw)) return raw;
    if (raw?.fills && Array.isArray(raw.fills)) return raw.fills;
    return [];
  }

  // ── AUTHENTICATED: Fees (/ir/v0, requires login) ──────

  async getEstimatedFees(
    subaccountId: number,
    marketId: number,
    side: string,
    price: number,
    postOnly: string = 'Disabled',
    quantity?: number,
    quoteQuantity?: number
  ): Promise<FeeEstimate> {
    const body: Record<string, unknown> = {
      subaccountId,
      marketId,
      side,
      price,
      postOnly,
    };
    if (quantity != null) body.quantity = quantity;
    if (quoteQuantity != null) body.quoteQuantity = quoteQuantity;

    return this.request<FeeEstimate>(
      '/users/fee-estimates',
      { method: 'POST', body: JSON.stringify(body) },
      { authenticated: 'iridium' }
    );
  }

  // ── AUTHENTICATED: Orders (/os/v0, requires login) ────

  async placeOrderRest(params: RestOrderParams): Promise<RestOrderResponse> {
    const subaccountId = params.subaccountId ?? await this.getDefaultSubaccountId();
    const body = {
      clientOrderId: params.clientOrderId ?? Date.now(),
      requestId: params.requestId ?? Date.now() + 1,
      marketId: params.marketId,
      subaccountId,
      side: params.side,
      orderType: params.orderType ?? 0,
      price: params.price,
      quantity: params.quantity,
      timeInForce: params.timeInForce ?? 1,
      postOnly: params.postOnly ?? 0,
      cancelOnDisconnect: params.cancelOnDisconnect ?? false,
      ...(params.quoteQuantity !== undefined && { quoteQuantity: params.quoteQuantity }),
      ...(params.stopPrice !== undefined && { stopPrice: params.stopPrice }),
    };

    return this.request<RestOrderResponse>(
      '/order',
      { method: 'POST', body: JSON.stringify(body) },
      { authenticated: 'osmium', useOs: true }
    );
  }

  async cancelOrderRest(params: { marketId: number; clientOrderId: number; subaccountId?: number }): Promise<unknown> {
    const subaccountId = params.subaccountId ?? await this.getDefaultSubaccountId();
    return this.request(
      '/order',
      {
        method: 'DELETE',
        body: JSON.stringify({
          marketId: params.marketId,
          clientOrderId: params.clientOrderId,
          subaccountId,
          requestId: Date.now(),
        }),
      },
      { authenticated: 'osmium', useOs: true }
    );
  }

  async modifyOrderRest(params: {
    marketId: number;
    clientOrderId: number;
    newPrice?: number;
    newQuantity: number;
    subaccountId?: number;
    postOnly?: number;
  }): Promise<unknown> {
    const subaccountId = params.subaccountId ?? await this.getDefaultSubaccountId();
    return this.request(
      '/order',
      {
        method: 'PATCH',
        body: JSON.stringify({
          marketId: params.marketId,
          clientOrderId: params.clientOrderId,
          subaccountId,
          requestId: Date.now(),
          newPrice: params.newPrice,
          newQuantity: params.newQuantity,
          postOnly: params.postOnly ?? 0,
        }),
      },
      { authenticated: 'osmium', useOs: true }
    );
  }

  async massCancelRest(params: { subaccountId?: number; marketId?: number; side?: number }): Promise<unknown> {
    const subaccountId = params.subaccountId ?? await this.getDefaultSubaccountId();
    return this.request(
      '/orders',
      {
        method: 'DELETE',
        body: JSON.stringify({
          subaccountId,
          requestId: Date.now(),
          ...(params.marketId !== undefined && { marketId: params.marketId }),
          ...(params.side !== undefined && { side: params.side }),
        }),
      },
      { authenticated: 'osmium', useOs: true }
    );
  }

  // ── AUTHENTICATED: DeFi Swap (/ir/v0, requires login) ─

  async getSwapEstimate(params: {
    tokenIn: string;
    tokenOut: string;
    direction: 'in' | 'out';
    amountIn?: string;
    amountOut?: string;
    sourceId?: number;
  }): Promise<SwapEstimateResponse> {
    const body: Record<string, unknown> = {
      tokenIn: params.tokenIn,
      tokenOut: params.tokenOut,
      direction: params.direction,
      sourceId: params.sourceId ?? 1,
    };
    if (params.amountIn != null) body.amountIn = params.amountIn;
    if (params.amountOut != null) body.amountOut = params.amountOut;

    return this.request<SwapEstimateResponse>(
      '/wallet/solana/swap/estimate',
      { method: 'POST', body: JSON.stringify(body) },
      { authenticated: 'iridium' }
    );
  }

  /**
   * Submit a signed intent via REST POST /wallet/submit.
   * REQUIRES AUTH (Iridium verification key + Ed25519 signature).
   */
  async submitIntent(params: SubmitIntentRequest): Promise<IntentSubmitResponse> {
    return this.request<IntentSubmitResponse>(
      '/wallet/submit',
      {
        method: 'POST',
        body: JSON.stringify({
          subaccountId: params.subaccountId,
          sourceId: params.sourceId,
          intentType: params.intentType,
          intentBytes: params.intentBytes,
          clientOrderId: params.clientOrderId,
          dryRun: params.dryRun ?? false,
          signatureInfo: params.signatureInfo,
        }),
      },
      { authenticated: 'iridium' }
    );
  }

  /**
   * Execute a DeFi swap. Uses /wallet/solana/swap/execute REST endpoint.
   * REQUIRES AUTH.
   */
  async executeSwap(params: {
    tokenIn: string;
    tokenOut: string;
    direction: 'in' | 'out';
    amountIn?: string;
    amountOut?: string;
    slippageBps?: number;
  }): Promise<unknown> {
    const body: Record<string, unknown> = {
      tokenIn: params.tokenIn,
      tokenOut: params.tokenOut,
      direction: params.direction,
      ...(params.slippageBps !== undefined && { slippageBps: params.slippageBps }),
    };
    if (params.amountIn != null) body.amountIn = params.amountIn;
    if (params.amountOut != null) body.amountOut = params.amountOut;

    return this.request(
      '/wallet/solana/swap/execute',
      { method: 'POST', body: JSON.stringify(body) },
      { authenticated: 'iridium' }
    );
  }

  // ── PUBLIC: Token Search (cube.exchange, no auth) ─────

  async searchTokens(query: string, limit: number = 10): Promise<TokenSearchResult[]> {
    const url = `https://www.cube.exchange/api/markets/search?query=${encodeURIComponent(query)}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Token search failed: ${response.status}`);
    const results = (await response.json()) as TokenSearchResult[];
    return results.slice(0, limit);
  }

  async getTrendingTokens(): Promise<TokenSearchResult[]> {
    const url = 'https://www.cube.exchange/api/solana/token/trending';
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Trending tokens failed: ${response.status}`);
    return (await response.json()) as TokenSearchResult[];
  }
}

// ── Types ──────────────────────────────────────────────────

export interface Source {
  sourceId: number;
  name: string;
  transactionExplorer?: string;
}

export interface Market {
  marketId: number;
  symbol: string;
  baseAssetId: number;
  quoteAssetId: number;
  baseLotSize: string;
  quoteLotSize: string;
  priceDisplayDecimals: number;
  priceTickSize: string;
  quantityTickSize: string;
  status: number;
}

export interface ParsedTicker {
  ticker_id: string;
  base_currency: string;
  quote_currency: string;
  timestamp: number;
  last_price: number | null;
  base_volume: number;
  quote_volume: number;
  bid: number | null;
  ask: number | null;
  high: number | null;
  low: number | null;
  open: number | null;
}

export interface Ticker {
  symbol: string;
  baseAsset: string;
  baseIcon: string;
  quoteAsset: string;
  quoteIcon: string;
  lastPrice: number | null;
  bidPrice: number | null;
  askPrice: number | null;
  baseVolume24h: number;
  quoteVolume24h: number;
  high24h: number | null;
  low24h: number | null;
  open24h: number | null;
  change24h: number | null;
  timestamp: number;
}

export interface ParsedOrderBook {
  ticker_id: string;
  timestamp: number;
  bids: [number, number][];
  asks: [number, number][];
}

export interface ParsedRecentTrades {
  ticker_id: string;
  trades: ParsedTrade[];
}

export interface ParsedTrade {
  id: number;
  p: number;
  q: number;
  side: string;
  ts: number;
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

export interface SubaccountIds {
  ids: number[];
}

export interface SubaccountDetail {
  id: number;
  name: string;
  addresses: Record<string, string>; // sourceId → deposit address
  accountType: string;
  hasOrderHistory: boolean;
}

export interface DepositRecord {
  assetId: number;
  amount: string;
  marketValueUsd?: string;
  txnHash?: string;
  txnState: string;
  address?: string;
  createdAt: string;
  updatedAt: string;
}

export interface PositionEntry {
  assetId: number;
  accountingType: string;
  amount: string;
  receivedAmount: string;
  pendingDeposits: string;
  symbol?: string;
  usdRate?: number;
  decimals?: number;
}

export interface PositionGroup {
  name: string;
  inner: PositionEntry[];
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

export interface WalletAsset {
  assetId: number;
  sourceId: number;
  decimals: number;
  defaultDisplayDecimals: number;
  symbol: string;
  usdRate: number;
  address?: string;
  amount?: string;
  availableAmount?: string;
  pendingAmount?: string;
}

export interface FeeEstimate {
  makerFee: string;
  takerFee: string;
  estimatedFee: string;
}

export interface TokenSearchResult {
  assetId: number;
  symbol: string;
  decimals: number;
  sourceId: number;
  metadata: {
    currencyName?: string;
    mint?: string;
    route?: 'cube' | 'defi';
    liquidity?: number;
    marketCapRank?: number;
    snapshotPrice?: number;
    logoURI?: string;
    volume24hUSD?: number;
    price24hChangePercent?: number;
    [key: string]: unknown;
  };
}

export interface SwapRouteStep {
  programId: string;
  pool: string;
  amount: string;
  price: string;
  direction: string;
}

export interface SwapEstimateResponse {
  fee?: { bps: number };
  route?: {
    amount: string;
    steps: SwapRouteStep[];
    allocations: Array<{ aIndex: number; bIndex: number; bps: string }>;
    mints: Record<string, { owner: string; decimals: number }>;
  };
  metadata?: Array<{
    address: string;
    assetId: number;
    currencyName: string;
    defaultDisplayDecimals: number;
    decimals: number;
    metadataUri: string;
    sourceId: number;
    symbol: string;
    usdRate: string;
  }>;
  error?: string;
}

// ── REST Order Types ────────────────────────────────────────

export interface RestOrderParams {
  marketId: number;
  side: number;
  price?: number;
  quantity?: number;
  orderType?: number;
  timeInForce?: number;
  postOnly?: number;
  cancelOnDisconnect?: boolean;
  subaccountId?: number;
  clientOrderId?: number;
  requestId?: number;
  quoteQuantity?: number;
  stopPrice?: number;
}

export interface RestOrderResponse {
  clientOrderId: number;
  exchangeOrderId: number;
  marketId: number;
  price: number;
  quantity: number;
  side: number;
  timeInForce: number;
  orderType: number;
  subaccountId: number;
  requestId: number;
  transactTime: number;
  msgSeqNum: number;
}

// ── Intent / DeFi Types ────────────────────────────────────

export const IntentType = {
  SolanaSwapIn: 12,
  SolanaSwapOut: 13,
  SolanaTransfer: 16,
} as const;

export const SourceId = {
  Solana: 203,
} as const;

export interface IntentSignatureInfo {
  timestamp: number;
  verificationKey: string;
  signature: string;
}

export interface SubmitIntentRequest {
  subaccountId: number;
  sourceId: number;
  intentType: number;
  intentBytes: string;
  clientOrderId: number;
  signatureInfo: IntentSignatureInfo;
  dryRun?: boolean;
}

export interface IntentSubmitResponse {
  state: 'Initiated' | 'NeedsMfa';
  intentId?: number;
  [key: string]: unknown;
}
