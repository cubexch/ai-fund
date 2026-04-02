/**
 * Hyperliquid API raw response types.
 * These are shapes from the Hyperliquid REST API
 * before normalization to ExchangeConnector types.
 *
 * API: POST https://api.hyperliquid.xyz/info (read)
 *      POST https://api.hyperliquid.xyz/exchange (write, EIP-712 signed)
 */

// ── Info Endpoint Responses ─────────────────────────────────

export interface HyperliquidMeta {
  universe: HyperliquidAsset[];
}

export interface HyperliquidAsset {
  name: string;
  szDecimals: number;
  maxLeverage: number;
  onlyIsolated?: boolean;
}

export interface HyperliquidUserState {
  assetPositions: HyperliquidAssetPosition[];
  crossMarginSummary: {
    accountValue: string;
    totalNtlPos: string;
    totalRawUsd: string;
    totalMarginUsed: string;
  };
  marginSummary: {
    accountValue: string;
    totalNtlPos: string;
    totalRawUsd: string;
    totalMarginUsed: string;
  };
  withdrawable: string;
}

export interface HyperliquidAssetPosition {
  position: {
    coin: string;
    szi: string;       // signed size — negative = short
    leverage: {
      type: 'cross' | 'isolated';
      value: number;
    };
    entryPx: string;
    positionValue: string;
    unrealizedPnl: string;
    returnOnEquity: string;
    liquidationPx: string | null;
    marginUsed: string;
  };
  type: string;
}

export interface HyperliquidOpenOrder {
  coin: string;
  side: 'A' | 'B';       // A = sell/ask, B = buy/bid
  limitPx: string;
  sz: string;
  oid: number;
  timestamp: number;
  origSz: string;
  cloid?: string;
}

export interface HyperliquidFill {
  coin: string;
  px: string;
  sz: string;
  side: 'A' | 'B';
  time: number;
  startPosition: string;
  dir: string;
  closedPnl: string;
  hash: string;
  oid: number;
  crossed: boolean;
  fee: string;
  tid: number;
}

export interface HyperliquidCandle {
  t: number;  // open time ms
  T: number;  // close time ms
  s: string;  // symbol
  i: string;  // interval
  o: string;  // open
  c: string;  // close
  h: string;  // high
  l: string;  // low
  v: string;  // volume
  n: number;  // number of trades
}

export interface HyperliquidAllMids {
  [coin: string]: string;
}

export interface HyperliquidL2Book {
  coin: string;
  levels: [
    Array<{ px: string; sz: string; n: number }>,  // bids
    Array<{ px: string; sz: string; n: number }>,   // asks
  ];
}

// ── Exchange Endpoint Types ─────────────────────────────────

export interface HyperliquidOrderResult {
  status: 'ok' | 'err';
  response?: {
    type: string;
    data?: {
      statuses: Array<{
        resting?: { oid: number };
        filled?: { totalSz: string; avgPx: string; oid: number };
        error?: string;
      }>;
    };
  };
  error?: string;
}
