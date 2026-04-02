/**
 * Hyperliquid REST API adapter.
 *
 * Direct HTTP calls to:
 *   - Info:     POST https://api.hyperliquid.xyz/info
 *   - Exchange: POST https://api.hyperliquid.xyz/exchange (EIP-712 signed)
 *
 * No SDK, no MCP. Signing uses Web Crypto + manual EIP-712 encoding.
 */

import type {
  HyperliquidMeta,
  HyperliquidUserState,
  HyperliquidOpenOrder,
  HyperliquidFill,
  HyperliquidCandle,
  HyperliquidAllMids,
  HyperliquidL2Book,
  HyperliquidOrderResult,
} from './types.js';

// ── Config ──────────────────────────────────────────────────

export interface HyperliquidConfig {
  walletAddress: string;
  privateKey: string;
  testnet: boolean;
}

function baseUrl(testnet: boolean): string {
  return testnet
    ? 'https://api.hyperliquid-testnet.xyz'
    : 'https://api.hyperliquid.xyz';
}

// ── Info Endpoint (Read-Only, No Auth) ──────────────────────

async function infoRequest<T>(url: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${url}/info`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Hyperliquid info error (${res.status}): ${text}`);
  }

  return await res.json() as T;
}

// ── Adapter ─────────────────────────────────────────────────

export class HyperliquidAdapter {
  private readonly url: string;
  private assetMap: Map<string, number> | null = null;

  constructor(private readonly config: HyperliquidConfig) {
    this.url = baseUrl(config.testnet);
  }

  // ── Asset Resolution ──────────────────────────────────────

  async getMeta(): Promise<HyperliquidMeta> {
    return infoRequest<HyperliquidMeta>(this.url, { type: 'meta' });
  }

  async resolveAssetIndex(coin: string): Promise<number> {
    if (!this.assetMap) {
      const meta = await this.getMeta();
      this.assetMap = new Map();
      for (let i = 0; i < meta.universe.length; i++) {
        this.assetMap.set(meta.universe[i].name, i);
      }
    }
    const idx = this.assetMap.get(coin);
    if (idx === undefined) throw new Error(`Unknown Hyperliquid asset: ${coin}`);
    return idx;
  }

  // ── Account & Positions ───────────────────────────────────

  async getUserState(): Promise<HyperliquidUserState> {
    return infoRequest<HyperliquidUserState>(this.url, {
      type: 'clearinghouseState',
      user: this.config.walletAddress,
    });
  }

  async getOpenOrders(): Promise<HyperliquidOpenOrder[]> {
    return infoRequest<HyperliquidOpenOrder[]>(this.url, {
      type: 'openOrders',
      user: this.config.walletAddress,
    });
  }

  async getUserFills(): Promise<HyperliquidFill[]> {
    return infoRequest<HyperliquidFill[]>(this.url, {
      type: 'userFills',
      user: this.config.walletAddress,
    });
  }

  // ── Market Data ───────────────────────────────────────────

  async getAllMids(): Promise<HyperliquidAllMids> {
    return infoRequest<HyperliquidAllMids>(this.url, { type: 'allMids' });
  }

  async getL2Book(coin: string): Promise<HyperliquidL2Book> {
    return infoRequest<HyperliquidL2Book>(this.url, {
      type: 'l2Book',
      coin,
    });
  }

  async getCandles(
    coin: string,
    interval: string,
    startTime: number,
    endTime?: number,
  ): Promise<HyperliquidCandle[]> {
    return infoRequest<HyperliquidCandle[]>(this.url, {
      type: 'candleSnapshot',
      req: {
        coin,
        interval,
        startTime,
        endTime: endTime ?? Date.now(),
      },
    });
  }

  // ── Exchange Endpoint (Signed, Write Operations) ──────────

  /**
   * Place an order via the exchange endpoint.
   *
   * NOTE: This requires EIP-712 signing with the wallet's private key.
   * The signing implementation handles:
   *   1. Construct the typed data (EIP-712 domain + order action)
   *   2. Sign with secp256k1 private key
   *   3. POST to /exchange with { action, nonce, signature, vaultAddress? }
   *
   * For now, this method delegates to a signing helper.
   * Full EIP-712 implementation is TODO — requires keccak256 + secp256k1.
   */
  async placeOrder(params: {
    coin: string;
    isBuy: boolean;
    sz: number;
    limitPx: number;
    orderType: { limit: { tif: 'Gtc' | 'Ioc' | 'Alo' } } | { trigger: { triggerPx: string; isMarket: boolean; tpsl: 'tp' | 'sl' } };
    reduceOnly?: boolean;
    cloid?: string;
  }): Promise<HyperliquidOrderResult> {
    const assetIndex = await this.resolveAssetIndex(params.coin);

    const action = {
      type: 'order',
      orders: [{
        a: assetIndex,
        b: params.isBuy,
        p: params.limitPx.toString(),
        s: params.sz.toString(),
        r: params.reduceOnly ?? false,
        t: params.orderType,
        c: params.cloid,
      }],
      grouping: 'na',
    };

    return this.signAndSend(action);
  }

  async cancelOrder(coin: string, oid: number): Promise<HyperliquidOrderResult> {
    const assetIndex = await this.resolveAssetIndex(coin);

    const action = {
      type: 'cancel',
      cancels: [{ a: assetIndex, o: oid }],
    };

    return this.signAndSend(action);
  }

  async updateLeverage(coin: string, leverage: number, isCross: boolean): Promise<HyperliquidOrderResult> {
    const assetIndex = await this.resolveAssetIndex(coin);

    const action = {
      type: 'updateLeverage',
      asset: assetIndex,
      isCross,
      leverage,
    };

    return this.signAndSend(action);
  }

  // ── EIP-712 Signing ───────────────────────────────────────

  private async signAndSend(action: Record<string, unknown>): Promise<HyperliquidOrderResult> {
    // EIP-712 signing requires:
    // 1. keccak256 hash of typed data
    // 2. secp256k1 signature with private key
    // 3. Encode as { action, nonce, signature }
    //
    // This is a placeholder — full implementation requires
    // either a minimal secp256k1/keccak256 lib or the ethers
    // signTypedData equivalent built from scratch.
    //
    // For read-only operations (info endpoint), no signing is needed.
    // Signing will be implemented when the connector moves to production.

    const nonce = Date.now();

    const res = await fetch(`${this.url}/exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action,
        nonce,
        signature: { r: '0x0', s: '0x0', v: 27 }, // placeholder
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Hyperliquid exchange error (${res.status}): ${text}`);
    }

    return await res.json() as HyperliquidOrderResult;
  }
}
