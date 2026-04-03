/**
 * Normalized exchange connector interface.
 *
 * All connectors implement ExchangeConnector so that skills
 * remain exchange-agnostic. Add an exchange — no skill files change.
 * Write a skill — no connector files change.
 */

// ── Market Data ─────────────────────────────────────────────

export interface Bar {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface Quote {
  symbol: string;
  bid: number;
  ask: number;
  last: number;
  timestamp: number;
}

// ── Account & Positions ─────────────────────────────────────

export interface Position {
  symbol: string;
  qty: number;
  avgEntryPrice: number;
  marketValue: number;
  unrealizedPnl: number;
  side: 'long' | 'short';
}

export interface Account {
  id: string;
  buyingPower: number;
  cash: number;
  portfolioValue: number;
  currency: string;
}

export interface PortfolioHistory {
  timestamps: number[];
  equity: number[];
  profitLoss: number[];
  profitLossPct: number[];
}

// ── Orders ──────────────────────────────────────────────────

export interface Order {
  id: string;
  symbol: string;
  side: 'buy' | 'sell';
  type: 'market' | 'limit' | 'stop' | 'stop_limit';
  qty: number;
  filledQty: number;
  limitPrice?: number;
  stopPrice?: number;
  status: 'pending' | 'open' | 'filled' | 'cancelled' | 'rejected';
  createdAt: number;
}

export interface OrderParams {
  symbol: string;
  side: 'buy' | 'sell';
  type: 'market' | 'limit' | 'stop' | 'stop_limit';
  qty: number;
  limitPrice?: number;
  stopPrice?: number;
  timeInForce?: 'day' | 'gtc' | 'ioc' | 'fok';
}

// ── Connector Metadata ──────────────────────────────────────

export type ConnectorStatus = 'ready' | 'beta' | 'experimental';

export interface ConnectorCapabilities {
  account: boolean;
  positions: boolean;
  orders: boolean;
  placeOrder: boolean;
  cancelOrder: boolean;
  cancelAllOrders: boolean;
  quote: boolean;
  bars: boolean;
  portfolioHistory: boolean;
}

export const DEFAULT_CONNECTOR_CAPABILITIES: ConnectorCapabilities = {
  account: true,
  positions: true,
  orders: true,
  placeOrder: true,
  cancelOrder: true,
  cancelAllOrders: true,
  quote: true,
  bars: true,
  portfolioHistory: true,
};

export function defineConnectorCapabilities(
  overrides: Partial<ConnectorCapabilities> = {},
): ConnectorCapabilities {
  return { ...DEFAULT_CONNECTOR_CAPABILITIES, ...overrides };
}

export interface ConnectorMeta {
  name: string;
  displayName: string;
  assetClasses: ('crypto' | 'equities' | 'futures' | 'options' | 'perps')[];
  status: ConnectorStatus;
  isPaper: boolean;
  supportsShorts: boolean;
  supportsOptions: boolean;
  marketHours: '24/7' | 'weekdays-only' | 'custom';
  capabilities: ConnectorCapabilities;
}

// ── Connector Interface ─────────────────────────────────────

export interface ExchangeConnector {
  meta: ConnectorMeta;

  // Account
  getAccount(): Promise<Account>;

  // Positions and orders
  getPositions(): Promise<Position[]>;
  getOrders(status?: 'open' | 'closed' | 'all'): Promise<Order[]>;
  placeOrder(params: OrderParams): Promise<Order>;
  cancelOrder(orderId: string): Promise<void>;
  cancelAllOrders(): Promise<void>;

  // Market data
  getQuote(symbol: string): Promise<Quote>;
  getBars(symbol: string, timeframe: string, limit: number): Promise<Bar[]>;
  getPortfolioHistory(period?: string): Promise<PortfolioHistory>;

  // State
  isMarketOpen(): Promise<boolean>;
  isPaper(): boolean;
}
