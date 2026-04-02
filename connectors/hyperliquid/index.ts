/**
 * Hyperliquid connector — implements ExchangeConnector via direct REST.
 *
 * No SDK, no MCP. Read operations work immediately.
 * Write operations require EIP-712 signing (implementation in adapter.ts).
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
import { loadCredentials, saveCredentials } from '../../lib/credential-store.js';
import { HyperliquidAdapter } from './adapter.js';

// ── Credential Shape ────────────────────────────────────────

interface HyperliquidCredentials {
  walletAddress: string;
  privateKey: string;
  testnet: boolean;
}

// ── Connector ───────────────────────────────────────────────

export class HyperliquidConnector implements ExchangeConnector {
  private readonly adapter: HyperliquidAdapter;

  readonly meta: ConnectorMeta = {
    name: 'hyperliquid',
    displayName: 'Hyperliquid',
    assetClasses: ['perps', 'crypto'],
    isPaper: true,
    supportsShorts: true,
    supportsOptions: false,
    marketHours: '24/7',
  };

  constructor(config: {
    walletAddress: string;
    privateKey: string;
    testnet?: boolean;
  }) {
    const testnet = config.testnet ?? true;
    this.meta.isPaper = testnet;
    this.adapter = new HyperliquidAdapter({
      walletAddress: config.walletAddress,
      privateKey: config.privateKey,
      testnet,
    });
  }

  // ── Account ─────────────────────────────────────────────

  async getAccount(): Promise<Account> {
    const state = await this.adapter.getUserState();
    const summary = state.crossMarginSummary;
    return {
      id: 'hyperliquid',
      buyingPower: parseFloat(summary.totalRawUsd) - parseFloat(summary.totalMarginUsed),
      cash: parseFloat(summary.totalRawUsd),
      portfolioValue: parseFloat(summary.accountValue),
      currency: 'USD',
    };
  }

  // ── Positions ───────────────────────────────────────────

  async getPositions(): Promise<Position[]> {
    const state = await this.adapter.getUserState();
    return state.assetPositions
      .filter(p => parseFloat(p.position.szi) !== 0)
      .map(p => {
        const szi = parseFloat(p.position.szi);
        return {
          symbol: p.position.coin,
          qty: Math.abs(szi),
          avgEntryPrice: parseFloat(p.position.entryPx),
          marketValue: parseFloat(p.position.positionValue),
          unrealizedPnl: parseFloat(p.position.unrealizedPnl),
          side: szi >= 0 ? 'long' as const : 'short' as const,
        };
      });
  }

  // ── Orders ──────────────────────────────────────────────

  async getOrders(status: 'open' | 'closed' | 'all' = 'open'): Promise<Order[]> {
    if (status === 'open' || status === 'all') {
      const orders = await this.adapter.getOpenOrders();
      return orders.map(o => ({
        id: o.oid.toString(),
        symbol: o.coin,
        side: o.side === 'B' ? 'buy' as const : 'sell' as const,
        type: 'limit' as const,
        qty: parseFloat(o.origSz),
        filledQty: parseFloat(o.origSz) - parseFloat(o.sz),
        limitPrice: parseFloat(o.limitPx),
        status: 'open' as const,
        createdAt: o.timestamp,
      }));
    }
    // Closed orders not directly available via info endpoint
    return [];
  }

  async placeOrder(params: OrderParams): Promise<Order> {
    // Testnet guard
    if (!this.meta.isPaper) {
      throw new Error(
        'Live trading requires HYPERLIQUID_TESTNET=false explicitly set. ' +
        'This is a safety guard to prevent accidental mainnet trades.',
      );
    }

    // Get mid price for market orders
    let limitPx = params.limitPrice ?? 0;
    if (params.type === 'market' && !params.limitPrice) {
      const mids = await this.adapter.getAllMids();
      const mid = mids[params.symbol];
      if (!mid) throw new Error(`No price found for ${params.symbol}`);
      // Market orders use aggressive limit: 5% slippage tolerance
      const midPrice = parseFloat(mid);
      limitPx = params.side === 'buy'
        ? midPrice * 1.05
        : midPrice * 0.95;
    }

    const orderType = params.type === 'market'
      ? { limit: { tif: 'Ioc' as const } }
      : { limit: { tif: mapTimeInForce(params.timeInForce) } };

    const result = await this.adapter.placeOrder({
      coin: params.symbol,
      isBuy: params.side === 'buy',
      sz: params.qty,
      limitPx,
      orderType,
    });

    if (result.status === 'err') {
      throw new Error(`Order failed: ${result.error ?? 'unknown error'}`);
    }

    const statuses = result.response?.data?.statuses ?? [];
    const first = statuses[0];
    const oid = first?.resting?.oid ?? first?.filled?.oid ?? 0;

    return {
      id: oid.toString(),
      symbol: params.symbol,
      side: params.side,
      type: params.type,
      qty: params.qty,
      filledQty: first?.filled ? parseFloat(first.filled.totalSz) : 0,
      limitPrice: params.limitPrice,
      stopPrice: params.stopPrice,
      status: first?.filled ? 'filled' : first?.resting ? 'open' : 'pending',
      createdAt: Date.now(),
    };
  }

  async cancelOrder(orderId: string): Promise<void> {
    // Need the coin for the cancel — get from open orders
    const orders = await this.adapter.getOpenOrders();
    const order = orders.find(o => o.oid.toString() === orderId);
    if (!order) throw new Error(`Order ${orderId} not found in open orders`);

    const result = await this.adapter.cancelOrder(order.coin, order.oid);
    if (result.status === 'err') {
      throw new Error(`Cancel failed: ${result.error ?? 'unknown error'}`);
    }
  }

  async cancelAllOrders(): Promise<void> {
    const orders = await this.adapter.getOpenOrders();
    for (const order of orders) {
      await this.adapter.cancelOrder(order.coin, order.oid);
    }
  }

  // ── Market Data ─────────────────────────────────────────

  async getQuote(symbol: string): Promise<Quote> {
    const book = await this.adapter.getL2Book(symbol);
    const [bids, asks] = book.levels;
    const bestBid = bids[0];
    const bestAsk = asks[0];

    if (!bestBid || !bestAsk) {
      throw new Error(`No liquidity for ${symbol}`);
    }

    const bid = parseFloat(bestBid.px);
    const ask = parseFloat(bestAsk.px);

    return {
      symbol,
      bid,
      ask,
      last: (bid + ask) / 2,
      timestamp: Date.now(),
    };
  }

  async getBars(symbol: string, timeframe: string, limit: number): Promise<Bar[]> {
    // Map common timeframes to Hyperliquid intervals
    const interval = mapInterval(timeframe);
    const endTime = Date.now();
    // Estimate start time from limit and interval
    const intervalMs = intervalToMs(interval);
    const startTime = endTime - (limit * intervalMs);

    const candles = await this.adapter.getCandles(symbol, interval, startTime, endTime);

    return candles.slice(-limit).map(c => ({
      timestamp: c.t,
      open: parseFloat(c.o),
      high: parseFloat(c.h),
      low: parseFloat(c.l),
      close: parseFloat(c.c),
      volume: parseFloat(c.v),
    }));
  }

  async getPortfolioHistory(_period?: string): Promise<PortfolioHistory> {
    // Hyperliquid doesn't have a native portfolio history endpoint
    // Return current state as single-point history
    const state = await this.adapter.getUserState();
    const now = Date.now();
    const equity = parseFloat(state.crossMarginSummary.accountValue);

    return {
      timestamps: [now],
      equity: [equity],
      profitLoss: [0],
      profitLossPct: [0],
    };
  }

  // ── State ───────────────────────────────────────────────

  async isMarketOpen(): Promise<boolean> {
    return true; // 24/7
  }

  isPaper(): boolean {
    return this.meta.isPaper;
  }

  // ── Hyperliquid-specific extensions ─────────────────────

  async getFundingRates(): Promise<Record<string, string>> {
    const mids = await this.adapter.getAllMids();
    return mids;
  }

  async updateLeverage(coin: string, leverage: number, isCross: boolean): Promise<void> {
    const result = await this.adapter.updateLeverage(coin, leverage, isCross);
    if (result.status === 'err') {
      throw new Error(`Leverage update failed: ${result.error ?? 'unknown error'}`);
    }
  }
}

// ── Helpers ─────────────────────────────────────────────────

function mapTimeInForce(tif?: 'day' | 'gtc' | 'ioc' | 'fok'): 'Gtc' | 'Ioc' | 'Alo' {
  switch (tif) {
    case 'ioc': return 'Ioc';
    case 'gtc': return 'Gtc';
    default: return 'Gtc';
  }
}

function mapInterval(tf: string): string {
  const map: Record<string, string> = {
    '1m': '1m', '5m': '5m', '15m': '15m', '30m': '30m',
    '1h': '1h', '4h': '4h', '1d': '1d', '1D': '1d',
    '1Day': '1d', '1Hour': '1h', '5Min': '5m', '15Min': '15m',
  };
  return map[tf] ?? tf;
}

function intervalToMs(interval: string): number {
  const map: Record<string, number> = {
    '1m': 60_000, '5m': 300_000, '15m': 900_000, '30m': 1_800_000,
    '1h': 3_600_000, '4h': 14_400_000, '1d': 86_400_000,
  };
  return map[interval] ?? 3_600_000;
}

// ── Credential Management ───────────────────────────────────

export async function saveHyperliquidCredentials(creds: HyperliquidCredentials): Promise<void> {
  await saveCredentials('hyperliquid', creds);
}

// ── Factory ─────────────────────────────────────────────────

export async function createHyperliquidConnector(
  config?: { walletAddress: string; privateKey: string; testnet?: boolean },
): Promise<HyperliquidConnector> {
  if (config) {
    return new HyperliquidConnector(config);
  }

  // Try credential store
  const stored = await loadCredentials<HyperliquidCredentials>('hyperliquid');
  if (stored) {
    return new HyperliquidConnector(stored);
  }

  // Fallback to env vars
  const walletAddress = process.env.HYPERLIQUID_WALLET_ADDRESS;
  const privateKey = process.env.HYPERLIQUID_PRIVATE_KEY;

  if (!walletAddress || !privateKey) {
    throw new Error(
      'No Hyperliquid credentials found. Run /setup to configure, ' +
      'or see connectors/hyperliquid/config.example.env for env var fallback.',
    );
  }

  const testnet = process.env.HYPERLIQUID_TESTNET !== 'false';
  return new HyperliquidConnector({ walletAddress, privateKey, testnet });
}
