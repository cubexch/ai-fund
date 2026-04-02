/**
 * Alpaca REST API v2 adapter.
 *
 * Thin wrapper over fetch — no SDK, no MCP dependencies.
 * Paper: https://paper-api.alpaca.markets
 * Live:  https://api.alpaca.markets
 * Data:  https://data.alpaca.markets
 */

import type {
  AlpacaAccount,
  AlpacaPosition,
  AlpacaOrder,
  AlpacaQuote,
  AlpacaBar,
  AlpacaClock,
  AlpacaPortfolioHistory,
} from './types.js';

// ── Config ──────────────────────────────────────────────────

export interface AlpacaConfig {
  apiKey: string;
  secretKey: string;
  paper: boolean;
}

function tradingBaseUrl(paper: boolean): string {
  return paper
    ? 'https://paper-api.alpaca.markets'
    : 'https://api.alpaca.markets';
}

const DATA_BASE_URL = 'https://data.alpaca.markets';

// ── HTTP ────────────────────────────────────────────────────

const MAX_RETRIES = 3;
const BACKOFF_BASE_MS = 1000;

async function alpacaFetch<T>(
  url: string,
  config: AlpacaConfig,
  options: RequestInit = {},
): Promise<T> {
  const headers: Record<string, string> = {
    'APCA-API-KEY-ID': config.apiKey,
    'APCA-API-SECRET-KEY': config.secretKey,
    'Accept': 'application/json',
    ...(options.headers as Record<string, string> ?? {}),
  };

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch(url, { ...options, headers });

    // Rate limit backoff
    if (res.status === 429 && attempt < MAX_RETRIES) {
      const delay = BACKOFF_BASE_MS * Math.pow(2, attempt);
      await new Promise(r => setTimeout(r, delay));
      continue;
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new AlpacaError(res.status, body, url);
    }

    // DELETE returns 204 No Content
    if (res.status === 204) return undefined as T;

    return await res.json() as T;
  }

  throw new Error('Alpaca: max retries exceeded');
}

export class AlpacaError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
    public readonly url: string,
  ) {
    const parsed = AlpacaError.parseBody(body);
    super(parsed);
    this.name = 'AlpacaError';
  }

  private static parseBody(body: string): string {
    try {
      const json = JSON.parse(body);
      return json.message || json.code || body;
    } catch {
      return body || 'Unknown Alpaca error';
    }
  }
}

// ── Adapter ─────────────────────────────────────────────────

export class AlpacaAdapter {
  private readonly tradingUrl: string;
  private readonly dataUrl = DATA_BASE_URL;

  constructor(private readonly config: AlpacaConfig) {
    this.tradingUrl = tradingBaseUrl(config.paper);
  }

  // ── Account ─────────────────────────────────────────────

  async getAccount(): Promise<AlpacaAccount> {
    return alpacaFetch<AlpacaAccount>(
      `${this.tradingUrl}/v2/account`,
      this.config,
    );
  }

  // ── Positions ───────────────────────────────────────────

  async getPositions(): Promise<AlpacaPosition[]> {
    return alpacaFetch<AlpacaPosition[]>(
      `${this.tradingUrl}/v2/positions`,
      this.config,
    );
  }

  // ── Orders ──────────────────────────────────────────────

  async getOrders(status: 'open' | 'closed' | 'all' = 'open'): Promise<AlpacaOrder[]> {
    return alpacaFetch<AlpacaOrder[]>(
      `${this.tradingUrl}/v2/orders?status=${status}&limit=500`,
      this.config,
    );
  }

  async placeOrder(params: {
    symbol: string;
    qty: number;
    side: 'buy' | 'sell';
    type: 'market' | 'limit' | 'stop' | 'stop_limit';
    time_in_force: 'day' | 'gtc' | 'ioc' | 'fok';
    limit_price?: number;
    stop_price?: number;
  }): Promise<AlpacaOrder> {
    const body: Record<string, unknown> = {
      symbol: params.symbol,
      qty: params.qty.toString(),
      side: params.side,
      type: params.type,
      time_in_force: params.time_in_force,
    };
    if (params.limit_price !== undefined) body.limit_price = params.limit_price.toString();
    if (params.stop_price !== undefined) body.stop_price = params.stop_price.toString();

    return alpacaFetch<AlpacaOrder>(
      `${this.tradingUrl}/v2/orders`,
      this.config,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
    );
  }

  async cancelOrder(orderId: string): Promise<void> {
    await alpacaFetch<void>(
      `${this.tradingUrl}/v2/orders/${orderId}`,
      this.config,
      { method: 'DELETE' },
    );
  }

  async cancelAllOrders(): Promise<void> {
    await alpacaFetch<void>(
      `${this.tradingUrl}/v2/orders`,
      this.config,
      { method: 'DELETE' },
    );
  }

  // ── Market Data ─────────────────────────────────────────

  async getQuote(symbol: string): Promise<AlpacaQuote> {
    const data = await alpacaFetch<{ quote: AlpacaQuote }>(
      `${this.dataUrl}/v2/stocks/${encodeURIComponent(symbol)}/quotes/latest`,
      this.config,
    );
    return data.quote;
  }

  async getBars(
    symbol: string,
    timeframe: string,
    limit: number,
  ): Promise<AlpacaBar[]> {
    const url = new URL(`${this.dataUrl}/v2/stocks/${encodeURIComponent(symbol)}/bars`);
    url.searchParams.set('timeframe', timeframe);
    url.searchParams.set('limit', limit.toString());
    url.searchParams.set('adjustment', 'split');
    url.searchParams.set('feed', 'sip');

    const data = await alpacaFetch<{ bars: AlpacaBar[] }>(
      url.toString(),
      this.config,
    );
    return data.bars ?? [];
  }

  // ── Clock ───────────────────────────────────────────────

  async getClock(): Promise<AlpacaClock> {
    return alpacaFetch<AlpacaClock>(
      `${this.tradingUrl}/v2/clock`,
      this.config,
    );
  }

  // ── Portfolio History ───────────────────────────────────

  async getPortfolioHistory(period?: string): Promise<AlpacaPortfolioHistory> {
    const url = new URL(`${this.tradingUrl}/v2/account/portfolio/history`);
    if (period) url.searchParams.set('period', period);
    url.searchParams.set('timeframe', '1D');

    return alpacaFetch<AlpacaPortfolioHistory>(
      url.toString(),
      this.config,
    );
  }
}
