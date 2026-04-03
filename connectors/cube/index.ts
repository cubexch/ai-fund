/**
 * Cube Exchange connector — wraps the existing IridiumClient behind ExchangeConnector.
 *
 * The Cube MCP server (mcp-server/) stays standalone with its full tool surface.
 * This connector lets the gateway route to Cube alongside Alpaca/Hyperliquid/CCXT
 * using the same normalized interface.
 */

import type {
  ExchangeConnector,
  ConnectorMeta,
  Account,
  Position,
  Order,
  OrderParams,
  Quote,
  Bar,
  PortfolioHistory,
} from '../../lib/connector-interface.js';
import { defineConnectorCapabilities } from '../../lib/connector-interface.js';
import { IridiumClient } from './mcp-server/src/client/iridium.js';
import { resolveAuth } from './mcp-server/src/client/auth.js';
import { toLots, fromLots, SIDE_MAP, ORDER_TYPE_MAP, TIF_MAP } from './mcp-server/src/tools/orders.js';

// ── Status Normalization ────────────────────────────────────

function normalizeOrderStatus(status: string): Order['status'] {
  const s = status.toLowerCase();
  if (s === 'open' || s === 'new' || s === 'resting' || s === 'accepted') return 'open';
  if (s === 'filled') return 'filled';
  if (s === 'cancelled' || s === 'canceled' || s === 'expired') return 'cancelled';
  if (s === 'rejected') return 'rejected';
  return 'pending';
}

function normalizeOrderType(type: string): Order['type'] {
  const t = type.toLowerCase();
  if (t === 'limit') return 'limit';
  if (t.includes('market')) return 'market';
  if (t === 'stop_limit') return 'stop_limit';
  if (t === 'stop_loss' || t === 'stop') return 'stop';
  return 'market';
}

function normalizeSide(side: string): 'buy' | 'sell' {
  const s = side.toLowerCase();
  return (s === 'bid' || s === 'buy' || s === '0') ? 'buy' : 'sell';
}

// ── Connector ───────────────────────────────────────────────

export class CubeConnector implements ExchangeConnector {
  private iridium: IridiumClient;
  private _marketsCache: any[] | null = null;
  private _marketsCacheTime = 0;

  readonly meta: ConnectorMeta;

  constructor(private isPaperMode: boolean) {
    this.iridium = new IridiumClient();
    this.meta = {
      name: 'cube',
      displayName: 'Cube Exchange',
      assetClasses: ['crypto'],
      status: 'ready',
      isPaper: isPaperMode,
      supportsShorts: false,
      supportsOptions: false,
      marketHours: '24/7',
      capabilities: defineConnectorCapabilities(),
    };
  }

  private async getMarkets() {
    const now = Date.now();
    if (!this._marketsCache || now - this._marketsCacheTime > 300_000) {
      this._marketsCache = await this.iridium.getMarkets();
      this._marketsCacheTime = now;
    }
    return this._marketsCache;
  }

  private async resolveMarket(symbol: string) {
    const markets = await this.getMarkets();
    // Try exact match first (e.g. "BTCUSDC")
    let market = markets.find(m => m.symbol.toUpperCase() === symbol.toUpperCase());
    // Try adding USDC suffix (e.g. "BTC" → "BTCUSDC")
    if (!market) {
      market = markets.find(m => m.symbol.toUpperCase() === `${symbol.toUpperCase()}USDC`);
    }
    if (!market) throw new Error(`Market not found: ${symbol}`);
    return market;
  }

  // ── Account ─────────────────────────────────────────────

  async getAccount(): Promise<Account> {
    const subId = await this.iridium.getDefaultSubaccountId();
    const [positionGroups, tickers, registry] = await Promise.all([
      this.iridium.getPositions(subId),
      this.iridium.getTickers(),
      this.iridium.getAssetRegistry(),
    ]);

    const tickerMap = new Map(tickers.map(t => [t.symbol, t]));
    let totalValue = 0;

    for (const group of Object.values(positionGroups)) {
      for (const entry of group.inner) {
        const amt = parseFloat(entry.amount);
        if (amt <= 0) continue;
        const asset = registry.getById(entry.assetId);
        const sym = asset?.symbol ?? '';
        const isStable = ['USDC', 'USDT'].includes(sym);
        const ticker = tickerMap.get(`${sym}USDC`);
        const price = isStable ? 1 : (ticker?.lastPrice ?? 0);
        totalValue += amt * price;
      }
    }

    return {
      id: `cube-${subId}`,
      buyingPower: totalValue,
      cash: totalValue,
      portfolioValue: totalValue,
      currency: 'USD',
    };
  }

  // ── Positions ───────────────────────────────────────────

  async getPositions(): Promise<Position[]> {
    const subId = await this.iridium.getDefaultSubaccountId();
    const [positionGroups, tickers, registry] = await Promise.all([
      this.iridium.getPositions(subId),
      this.iridium.getTickers(),
      this.iridium.getAssetRegistry(),
    ]);

    const tickerMap = new Map(tickers.map(t => [t.symbol, t]));
    const positions: Position[] = [];

    for (const group of Object.values(positionGroups)) {
      for (const entry of group.inner) {
        const qty = parseFloat(entry.amount);
        if (qty <= 0) continue;
        const asset = registry.getById(entry.assetId);
        const sym = asset?.symbol ?? `ASSET-${entry.assetId}`;
        if (['USDC', 'USDT'].includes(sym)) continue;

        const ticker = tickerMap.get(`${sym}USDC`);
        const price = ticker?.lastPrice ?? 0;

        positions.push({
          symbol: sym,
          qty,
          avgEntryPrice: 0, // Cube doesn't expose avg entry via REST
          marketValue: qty * price,
          unrealizedPnl: 0,
          side: 'long',
        });
      }
    }

    return positions;
  }

  // ── Orders ──────────────────────────────────────────────

  async getOrders(status: 'open' | 'closed' | 'all' = 'open'): Promise<Order[]> {
    const subId = await this.iridium.getDefaultSubaccountId();
    const orders = await this.iridium.getOrderHistory(subId);

    const OPEN_STATUSES = new Set(['open', 'Open', 'new', 'New', 'resting', 'Resting', 'accepted', 'Accepted']);

    return orders
      .filter(o => {
        if (status === 'open') return OPEN_STATUSES.has(o.status);
        if (status === 'closed') return !OPEN_STATUSES.has(o.status);
        return true;
      })
      .map(o => ({
        id: o.orderId,
        symbol: o.symbol,
        side: normalizeSide(o.side),
        type: normalizeOrderType(o.orderType),
        qty: parseFloat(o.quantity),
        filledQty: parseFloat(o.filledQuantity),
        limitPrice: parseFloat(o.price) || undefined,
        status: normalizeOrderStatus(o.status),
        createdAt: new Date(o.createdAt).getTime(),
      }));
  }

  async placeOrder(params: OrderParams): Promise<Order> {
    const market = await this.resolveMarket(params.symbol);

    const sideStr = params.side === 'buy' ? 'BID' : 'ASK';
    const quantityLots = toLots(String(params.qty), market.quantityTickSize);

    const orderTypeKey = params.type === 'market' ? 'MARKET_WITH_PROTECTION'
      : params.type === 'stop_limit' ? 'STOP_LIMIT'
      : params.type === 'stop' ? 'STOP_LOSS'
      : 'LIMIT';

    const tifKey = params.timeInForce === 'ioc' ? 'IOC'
      : params.timeInForce === 'fok' ? 'FOK'
      : params.type === 'market' ? 'IOC'
      : 'GFS';

    const result = await this.iridium.placeOrderRest({
      marketId: market.marketId,
      side: SIDE_MAP[sideStr],
      quantity: quantityLots,
      price: params.limitPrice ? toLots(String(params.limitPrice), market.priceTickSize) : undefined,
      orderType: ORDER_TYPE_MAP[orderTypeKey],
      timeInForce: TIF_MAP[tifKey],
      postOnly: 0,
      cancelOnDisconnect: false,
      stopPrice: params.stopPrice ? toLots(String(params.stopPrice), market.priceTickSize) : undefined,
    });

    return {
      id: String(result.exchangeOrderId),
      symbol: market.symbol,
      side: params.side,
      type: params.type,
      qty: params.qty,
      filledQty: 0,
      limitPrice: params.limitPrice,
      stopPrice: params.stopPrice,
      status: 'open',
      createdAt: result.transactTime,
    };
  }

  async cancelOrder(orderId: string): Promise<void> {
    // orderId from getOrders is the exchangeOrderId, but cancelOrderRest needs clientOrderId + marketId
    // This is a limitation — the gateway cancel needs both. For now, cancel all by finding the order.
    const subId = await this.iridium.getDefaultSubaccountId();
    const orders = await this.iridium.getOrderHistory(subId);
    const order = orders.find(o => o.orderId === orderId);
    if (!order) throw new Error(`Order ${orderId} not found`);

    await this.iridium.cancelOrderRest({
      marketId: order.marketId,
      clientOrderId: parseInt(order.clientOrderId),
    });
  }

  async cancelAllOrders(): Promise<void> {
    await this.iridium.massCancelRest({});
  }

  // ── Market Data ─────────────────────────────────────────

  async getQuote(symbol: string): Promise<Quote> {
    const tickers = await this.iridium.getTickers();
    // Try exact match, then with USDC suffix
    let ticker = tickers.find(t => t.symbol.toUpperCase() === symbol.toUpperCase());
    if (!ticker) {
      ticker = tickers.find(t => t.symbol.toUpperCase() === `${symbol.toUpperCase()}USDC`);
    }
    if (!ticker) throw new Error(`No quote for ${symbol}`);

    return {
      symbol: ticker.symbol,
      bid: ticker.bidPrice ?? 0,
      ask: ticker.askPrice ?? 0,
      last: ticker.lastPrice ?? 0,
      timestamp: ticker.timestamp,
    };
  }

  async getBars(symbol: string, timeframe: string, limit: number): Promise<Bar[]> {
    const market = await this.resolveMarket(symbol);

    // Map common timeframe strings to Cube intervals
    const intervalMap: Record<string, string> = {
      '1Min': '1m', '5Min': '15m', '15Min': '15m',
      '1Hour': '1h', '4Hour': '4h', '1Day': '1d',
      '1m': '1m', '15m': '15m', '1h': '1h', '4h': '4h', '1d': '1d',
    };
    const interval = intervalMap[timeframe] ?? '1h';

    const candles = await this.iridium.getPriceHistory(market.marketId, interval, limit);
    return candles.map(k => ({
      timestamp: k.startTime,
      open: parseFloat(k.open),
      high: parseFloat(k.high),
      low: parseFloat(k.low),
      close: parseFloat(k.close),
      volume: parseFloat(k.volume),
    }));
  }

  async getPortfolioHistory(_period?: string): Promise<PortfolioHistory> {
    // Cube doesn't have a unified portfolio history endpoint
    const account = await this.getAccount();
    const now = Date.now();
    return {
      timestamps: [now],
      equity: [account.portfolioValue],
      profitLoss: [0],
      profitLossPct: [0],
    };
  }

  // ── State ───────────────────────────────────────────────

  async isMarketOpen(): Promise<boolean> {
    return true; // Crypto is 24/7
  }

  isPaper(): boolean {
    return this.meta.isPaper;
  }
}

// ── Factory ─────────────────────────────────────────────────

export async function createCubeConnector(): Promise<CubeConnector> {
  // Check if auth is available (not required — public endpoints work without)
  const auth = await resolveAuth().catch(() => null);
  const isPaper = (process.env.CUBE_ENV ?? 'staging') === 'staging';

  if (!auth) {
    // Connector works for market data; trading methods will fail at call time
    process.stderr.write('[cube] Connector loaded (no auth — market data only)\n');
  }

  return new CubeConnector(isPaper);
}
