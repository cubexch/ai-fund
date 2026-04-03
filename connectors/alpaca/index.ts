/**
 * Alpaca connector — implements ExchangeConnector via direct REST API calls.
 *
 * No MCP server, no SDK, no CCXT. Just fetch().
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
import { AlpacaAdapter, AlpacaError } from './adapter.js';
import type { AlpacaAccount, AlpacaOrder } from './types.js';

// ── Credential Shape ────────────────────────────────────────

interface AlpacaCredentials {
  apiKey: string;
  secretKey: string;
  paper: boolean;
}

// ── Status Normalization ────────────────────────────────────

function normalizeOrderStatus(status: string): Order['status'] {
  switch (status) {
    case 'new':
    case 'accepted':
    case 'pending_new':
    case 'accepted_for_bidding':
      return 'open';
    case 'partially_filled':
      return 'open';
    case 'filled':
      return 'filled';
    case 'done_for_day':
    case 'canceled':
    case 'expired':
    case 'replaced':
      return 'cancelled';
    case 'rejected':
    case 'suspended':
    case 'stopped':
      return 'rejected';
    case 'pending_cancel':
    case 'pending_replace':
      return 'pending';
    default:
      return 'pending';
  }
}

function normalizeOrder(o: AlpacaOrder): Order {
  return {
    id: o.id,
    symbol: o.symbol,
    side: o.side,
    type: o.order_type ?? o.type,
    qty: parseFloat(o.qty),
    filledQty: parseFloat(o.filled_qty),
    limitPrice: o.limit_price ? parseFloat(o.limit_price) : undefined,
    stopPrice: o.stop_price ? parseFloat(o.stop_price) : undefined,
    status: normalizeOrderStatus(o.status),
    createdAt: new Date(o.created_at).getTime(),
  };
}

// ── PDT Check ───────────────────────────────────────────────

function checkPDT(account: AlpacaAccount, side: 'buy' | 'sell'): string | null {
  const equity = parseFloat(account.equity);
  if (equity >= 25000 || account.pattern_day_trader) return null;
  if (side !== 'sell') return null;

  const remaining = 3 - account.daytrade_count;
  if (remaining <= 0) {
    return `PDT restriction: account equity $${equity.toFixed(2)} is under $25k and you have used all 3 day trades this rolling 5-day period.`;
  }
  if (remaining <= 1) {
    return `PDT warning: account under $25k. You have used ${account.daytrade_count} of 3 day trades this rolling 5-day period.`;
  }
  return null;
}

// ── Connector ───────────────────────────────────────────────

export class AlpacaConnector implements ExchangeConnector {
  private readonly adapter: AlpacaAdapter;
  private cachedAccount: AlpacaAccount | null = null;

  readonly meta: ConnectorMeta = {
    name: 'alpaca',
    displayName: 'Alpaca',
    assetClasses: ['equities'],
    status: 'ready',
    isPaper: true,
    supportsShorts: false,
    supportsOptions: false,
    marketHours: 'weekdays-only',
    capabilities: defineConnectorCapabilities(),
  };

  constructor(config: {
    apiKey: string;
    secretKey: string;
    paper?: boolean;
  }) {
    const paper = config.paper ?? true;
    this.meta.isPaper = paper;
    this.adapter = new AlpacaAdapter({
      apiKey: config.apiKey,
      secretKey: config.secretKey,
      paper,
    });
  }

  // ── Account ─────────────────────────────────────────────

  async getAccount(): Promise<Account> {
    const a = await this.adapter.getAccount();
    this.cachedAccount = a;
    return {
      id: a.account_number,
      buyingPower: parseFloat(a.buying_power),
      cash: parseFloat(a.cash),
      portfolioValue: parseFloat(a.portfolio_value),
      currency: a.currency,
    };
  }

  // ── Positions ───────────────────────────────────────────

  async getPositions(): Promise<Position[]> {
    const positions = await this.adapter.getPositions();
    return positions.map(p => ({
      symbol: p.symbol,
      qty: parseFloat(p.qty),
      avgEntryPrice: parseFloat(p.avg_entry_price),
      marketValue: parseFloat(p.market_value),
      unrealizedPnl: parseFloat(p.unrealized_pl),
      side: p.side,
    }));
  }

  // ── Orders ──────────────────────────────────────────────

  async getOrders(status: 'open' | 'closed' | 'all' = 'open'): Promise<Order[]> {
    const orders = await this.adapter.getOrders(status);
    return orders.map(normalizeOrder);
  }

  async placeOrder(params: OrderParams): Promise<Order> {
    // Live guard
    if (!this.meta.isPaper) {
      throw new Error(
        'Live trading requires ALPACA_PAPER_TRADE=false explicitly set. ' +
        'This is a safety guard to prevent accidental live trades.',
      );
    }

    // Market hours check
    const clock = await this.adapter.getClock();
    if (!clock.is_open && params.timeInForce !== 'gtc') {
      throw new Error(
        'Market is closed. NYSE/NASDAQ trade Mon-Fri 9:30-16:00 ET. ' +
        "Use timeInForce: 'gtc' to queue for next open.",
      );
    }

    // PDT check
    if (!this.cachedAccount) {
      const a = await this.adapter.getAccount();
      this.cachedAccount = a;
    }
    const pdtWarning = checkPDT(this.cachedAccount, params.side);
    if (pdtWarning && pdtWarning.startsWith('PDT restriction')) {
      throw new Error(pdtWarning);
    }

    // Buying power check
    const buyingPower = parseFloat(this.cachedAccount.buying_power);
    if (buyingPower <= 0 && params.side === 'buy') {
      throw new Error(`Insufficient buying power: $${buyingPower.toFixed(2)} available.`);
    }

    const order = await this.adapter.placeOrder({
      symbol: params.symbol,
      qty: params.qty,
      side: params.side,
      type: params.type,
      time_in_force: mapTimeInForce(params.timeInForce),
      limit_price: params.limitPrice,
      stop_price: params.stopPrice,
    });

    // Invalidate cached account after order
    this.cachedAccount = null;

    return normalizeOrder(order);
  }

  async cancelOrder(orderId: string): Promise<void> {
    await this.adapter.cancelOrder(orderId);
  }

  async cancelAllOrders(): Promise<void> {
    await this.adapter.cancelAllOrders();
  }

  // ── Market Data ─────────────────────────────────────────

  async getQuote(symbol: string): Promise<Quote> {
    try {
      const q = await this.adapter.getQuote(symbol);
      return {
        symbol,
        bid: q.bp,
        ask: q.ap,
        last: (q.bp + q.ap) / 2, // midpoint as last
        timestamp: new Date(q.t).getTime(),
      };
    } catch (err) {
      if (err instanceof AlpacaError && err.status === 404) {
        throw new Error(
          `Symbol not found: ${symbol}. Check format: AAPL not AAPL.US. Crypto: BTC/USD`,
        );
      }
      throw err;
    }
  }

  async getBars(symbol: string, timeframe: string, limit: number): Promise<Bar[]> {
    const bars = await this.adapter.getBars(symbol, timeframe, limit);
    return bars.map(b => ({
      timestamp: new Date(b.t).getTime(),
      open: b.o,
      high: b.h,
      low: b.l,
      close: b.c,
      volume: b.v,
    }));
  }

  async getPortfolioHistory(period?: string): Promise<PortfolioHistory> {
    const h = await this.adapter.getPortfolioHistory(period);
    return {
      timestamps: h.timestamp,
      equity: h.equity,
      profitLoss: h.profit_loss,
      profitLossPct: h.profit_loss_pct,
    };
  }

  // ── State ───────────────────────────────────────────────

  async isMarketOpen(): Promise<boolean> {
    const clock = await this.adapter.getClock();
    return clock.is_open;
  }

  isPaper(): boolean {
    return this.meta.isPaper;
  }
}

// ── Helpers ─────────────────────────────────────────────────

function mapTimeInForce(tif?: 'day' | 'gtc' | 'ioc' | 'fok'): 'day' | 'gtc' | 'ioc' | 'fok' {
  return tif ?? 'day';
}

// ── Credential Management ───────────────────────────────────

/**
 * Save Alpaca credentials to the shared credential store
 * (keychain on macOS, libsecret on Linux, file fallback).
 */
export async function saveAlpacaCredentials(creds: AlpacaCredentials): Promise<void> {
  await saveCredentials('alpaca', creds);
}

// ── Factory ─────────────────────────────────────────────────

/**
 * Create an Alpaca connector.
 *
 * Credential resolution order:
 *   1. Explicit config passed as argument
 *   2. Shared credential store (~/.ai-fund/alpaca/credentials.json or keychain)
 *   3. Environment variables (fallback for CI/testing)
 */
export async function createAlpacaConnector(
  config?: { apiKey: string; secretKey: string; paper?: boolean },
): Promise<AlpacaConnector> {
  if (config) {
    return new AlpacaConnector({
      apiKey: config.apiKey,
      secretKey: config.secretKey,
      paper: config.paper,
    });
  }

  // Try credential store
  const stored = await loadCredentials<AlpacaCredentials>('alpaca');
  if (stored) {
    return new AlpacaConnector({
      apiKey: stored.apiKey,
      secretKey: stored.secretKey,
      paper: stored.paper,
    });
  }

  // Fallback to env vars (for CI/testing only)
  const apiKey = process.env.ALPACA_API_KEY;
  const secretKey = process.env.ALPACA_SECRET_KEY;

  if (!apiKey || !secretKey) {
    throw new Error(
      'No Alpaca credentials found. Run /setup to configure, ' +
      'or see connectors/alpaca/config.example.env for env var fallback.',
    );
  }

  const paper = process.env.ALPACA_PAPER_TRADE !== 'false';
  return new AlpacaConnector({ apiKey, secretKey, paper });
}
