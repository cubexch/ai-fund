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
import { defineConnectorCapabilities } from '../../lib/connector-interface.js';
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
    status: 'beta',
    isPaper: true,
    supportsShorts: true,
    supportsOptions: false,
    marketHours: '24/7',
    capabilities: defineConnectorCapabilities({
      placeOrder: false,
      cancelOrder: false,
      cancelAllOrders: false,
    }),
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
    void params;
    throw new Error(
      'Hyperliquid order entry is disabled. The connector remains read-only beta until EIP-712 signing is implemented and verified.',
    );
  }

  async cancelOrder(orderId: string): Promise<void> {
    void orderId;
    throw new Error(
      'Hyperliquid order cancellation is disabled. The connector remains read-only beta until EIP-712 signing is implemented and verified.',
    );
  }

  async cancelAllOrders(): Promise<void> {
    throw new Error(
      'Hyperliquid order cancellation is disabled. The connector remains read-only beta until EIP-712 signing is implemented and verified.',
    );
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
