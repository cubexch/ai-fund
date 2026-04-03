/**
 * CCXT connector — wraps CCXT behind ExchangeConnector.
 *
 * Agents never see CCXT internals — only the normalized interface.
 * CCXT is an internal dependency, not an exposed tool surface.
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

// ── Credential Shape ────────────────────────────────────────

interface CcxtCredentials {
  exchange: string;
  apiKey: string;
  secret: string;
  password?: string;
  sandbox: boolean;
}

// ── Status Normalization ────────────────────────────────────

function normalizeOrderStatus(status: string): Order['status'] {
  switch (status) {
    case 'open': return 'open';
    case 'closed': return 'filled';
    case 'canceled': return 'cancelled';
    case 'expired': return 'cancelled';
    case 'rejected': return 'rejected';
    default: return 'pending';
  }
}

function normalizeOrderType(type: string): Order['type'] {
  switch (type) {
    case 'market': return 'market';
    case 'limit': return 'limit';
    case 'stop': return 'stop';
    case 'stop_limit': return 'stop_limit';
    default: return 'market';
  }
}

// ── Connector ───────────────────────────────────────────────

export class CcxtConnector implements ExchangeConnector {
  private exchange: any; // CCXT exchange instance — intentionally `any` to avoid leaking types

  readonly meta: ConnectorMeta;

  constructor(
    private readonly exchangeName: string,
    private readonly config: {
      apiKey: string;
      secret: string;
      password?: string;
      sandbox?: boolean;
    },
  ) {
    const sandbox = config.sandbox ?? true;
    this.meta = {
      name: `ccxt-${exchangeName}`,
      displayName: `${capitalize(exchangeName)} (via CCXT)`,
      assetClasses: ['crypto'],
      status: 'ready',
      isPaper: sandbox,
      supportsShorts: false,
      supportsOptions: false,
      marketHours: '24/7',
      capabilities: defineConnectorCapabilities(),
    };
  }

  private async getExchange(): Promise<any> {
    if (this.exchange) return this.exchange;

    // Dynamic import — CCXT is an optional peer dependency
    const ccxt = await import('ccxt');
    const ExchangeClass = (ccxt as any)[this.exchangeName];
    if (!ExchangeClass) {
      throw new Error(
        `Exchange "${this.exchangeName}" not found in CCXT. ` +
        `Available: binance, coinbase, bybit, gate, kucoin, bitfinex, mexc, huobi, ...`,
      );
    }

    this.exchange = new ExchangeClass({
      apiKey: this.config.apiKey,
      secret: this.config.secret,
      password: this.config.password,
      enableRateLimit: true,
    });

    if (this.config.sandbox) {
      this.exchange.setSandboxMode(true);
    }

    return this.exchange;
  }

  // ── Account ─────────────────────────────────────────────

  async getAccount(): Promise<Account> {
    const ex = await this.getExchange();
    const balance = await ex.fetchBalance();
    return {
      id: this.exchangeName,
      buyingPower: balance.free?.USDT ?? balance.free?.USD ?? 0,
      cash: balance.total?.USDT ?? balance.total?.USD ?? 0,
      portfolioValue: balance.total?.USDT ?? balance.total?.USD ?? 0,
      currency: 'USD',
    };
  }

  // ── Positions ───────────────────────────────────────────

  async getPositions(): Promise<Position[]> {
    const ex = await this.getExchange();

    // Not all CCXT exchanges support fetchPositions
    if (!ex.has.fetchPositions) {
      // Fall back to balance-based positions
      const balance = await ex.fetchBalance();
      const positions: Position[] = [];
      for (const [currency, total] of Object.entries(balance.total ?? {})) {
        const qty = total as number;
        if (qty > 0 && currency !== 'USDT' && currency !== 'USD') {
          positions.push({
            symbol: `${currency}/USDT`,
            qty,
            avgEntryPrice: 0, // Not available from balance
            marketValue: 0,
            unrealizedPnl: 0,
            side: 'long',
          });
        }
      }
      return positions;
    }

    const raw = await ex.fetchPositions();
    return raw
      .filter((p: any) => p.contracts > 0 || Math.abs(p.notional ?? 0) > 0)
      .map((p: any) => ({
        symbol: p.symbol,
        qty: Math.abs(p.contracts ?? p.contractSize ?? 0),
        avgEntryPrice: p.entryPrice ?? 0,
        marketValue: Math.abs(p.notional ?? 0),
        unrealizedPnl: p.unrealizedPnl ?? 0,
        side: p.side === 'short' ? 'short' as const : 'long' as const,
      }));
  }

  // ── Orders ──────────────────────────────────────────────

  async getOrders(status: 'open' | 'closed' | 'all' = 'open'): Promise<Order[]> {
    const ex = await this.getExchange();
    let raw: any[];

    if (status === 'open') {
      raw = await ex.fetchOpenOrders();
    } else if (status === 'closed') {
      raw = await ex.fetchClosedOrders();
    } else {
      const open = await ex.fetchOpenOrders();
      const closed = await ex.fetchClosedOrders();
      raw = [...open, ...closed];
    }

    return raw.map((o: any) => ({
      id: o.id,
      symbol: o.symbol,
      side: o.side as 'buy' | 'sell',
      type: normalizeOrderType(o.type),
      qty: o.amount,
      filledQty: o.filled ?? 0,
      limitPrice: o.price ?? undefined,
      stopPrice: o.stopPrice ?? undefined,
      status: normalizeOrderStatus(o.status),
      createdAt: o.timestamp ?? Date.now(),
    }));
  }

  async placeOrder(params: OrderParams): Promise<Order> {
    if (!this.meta.isPaper) {
      throw new Error(
        'Live trading requires CCXT_SANDBOX=false explicitly set. ' +
        'This is a safety guard to prevent accidental live trades.',
      );
    }

    const ex = await this.getExchange();
    const raw = await ex.createOrder(
      params.symbol,
      params.type,
      params.side,
      params.qty,
      params.limitPrice,
      params.stopPrice ? { stopPrice: params.stopPrice } : undefined,
    );

    return {
      id: raw.id,
      symbol: raw.symbol ?? params.symbol,
      side: raw.side ?? params.side,
      type: normalizeOrderType(raw.type ?? params.type),
      qty: raw.amount ?? params.qty,
      filledQty: raw.filled ?? 0,
      limitPrice: raw.price ?? params.limitPrice,
      stopPrice: params.stopPrice,
      status: normalizeOrderStatus(raw.status ?? 'open'),
      createdAt: raw.timestamp ?? Date.now(),
    };
  }

  async cancelOrder(orderId: string): Promise<void> {
    const ex = await this.getExchange();
    await ex.cancelOrder(orderId);
  }

  async cancelAllOrders(): Promise<void> {
    const ex = await this.getExchange();
    if (ex.has.cancelAllOrders) {
      await ex.cancelAllOrders();
    } else {
      const open = await ex.fetchOpenOrders();
      for (const o of open) {
        await ex.cancelOrder(o.id, o.symbol);
      }
    }
  }

  // ── Market Data ─────────────────────────────────────────

  async getQuote(symbol: string): Promise<Quote> {
    const ex = await this.getExchange();
    const ticker = await ex.fetchTicker(symbol);
    return {
      symbol,
      bid: ticker.bid ?? 0,
      ask: ticker.ask ?? 0,
      last: ticker.last ?? 0,
      timestamp: ticker.timestamp ?? Date.now(),
    };
  }

  async getBars(symbol: string, timeframe: string, limit: number): Promise<Bar[]> {
    const ex = await this.getExchange();
    // CCXT returns: [[timestamp, open, high, low, close, volume], ...]
    const raw = await ex.fetchOHLCV(symbol, timeframe, undefined, limit);
    return raw.map((candle: number[]) => ({
      timestamp: candle[0],
      open: candle[1],
      high: candle[2],
      low: candle[3],
      close: candle[4],
      volume: candle[5],
    }));
  }

  async getPortfolioHistory(_period?: string): Promise<PortfolioHistory> {
    // CCXT doesn't have a unified portfolio history endpoint
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

// ── Helpers ─────────────────────────────────────────────────

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ── Credential Management ───────────────────────────────────

export async function saveCcxtCredentials(exchange: string, creds: Omit<CcxtCredentials, 'exchange'>): Promise<void> {
  await saveCredentials(`ccxt-${exchange}`, { ...creds, exchange });
}

// ── Factory ─────────────────────────────────────────────────

export async function createCcxtConnector(
  config?: { exchange: string; apiKey: string; secret: string; password?: string; sandbox?: boolean },
): Promise<CcxtConnector> {
  if (config) {
    return new CcxtConnector(config.exchange, config);
  }

  // Try credential store — need to know which exchange first
  const exchangeName = process.env.CCXT_EXCHANGE;
  if (exchangeName) {
    const stored = await loadCredentials<CcxtCredentials>(`ccxt-${exchangeName}`);
    if (stored) {
      return new CcxtConnector(stored.exchange, {
        apiKey: stored.apiKey,
        secret: stored.secret,
        password: stored.password,
        sandbox: stored.sandbox,
      });
    }
  }

  // Fallback to env vars
  const apiKey = process.env.CCXT_API_KEY;
  const secret = process.env.CCXT_SECRET;

  if (!exchangeName || !apiKey || !secret) {
    throw new Error(
      'No CCXT credentials found. Run /setup to configure, ' +
      'or see connectors/ccxt/config.example.env for env var fallback.',
    );
  }

  const sandbox = process.env.CCXT_SANDBOX !== 'false';
  return new CcxtConnector(exchangeName, { apiKey, secret, sandbox });
}
