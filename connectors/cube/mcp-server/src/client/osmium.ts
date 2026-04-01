import { WebSocket } from 'ws';
import { fetchAccessToken, getEnvironment, getSigningCredentials, getSigningKey, hasAuth } from './auth.js';
import { signMessage } from './signing.js';
import {
  CredentialsMethods,
  OrderRequestMethods,
  OrderResponseMethods,
  BootstrapMethods,
} from '@cubexch/client/lib/methods/trade.js';
import {
  WalletRequestMethods,
  WalletEventMethods,
} from '@cubexch/client/lib/methods/wallet.js';
import {
  Side,
  TimeInForce,
  OrderType,
  PostOnly,
} from '@cubexch/client/lib/trade.js';
import type {
  Credentials,
  OrderResponse,
} from '@cubexch/client/lib/trade.js';
import type {
  WalletEvent,
  NewIntent,
} from '@cubexch/client/lib/wallet.js';

// ── Side/TIF/OrderType string → enum mappings ────────────

const SIDE_MAP: Record<string, Side> = {
  BID: Side.BID,
  ASK: Side.ASK,
};

const TIF_MAP: Record<string, TimeInForce> = {
  IOC: TimeInForce.IMMEDIATE_OR_CANCEL,
  GFS: TimeInForce.GOOD_FOR_SESSION,
  FOK: TimeInForce.FILL_OR_KILL,
};

const ORDER_TYPE_MAP: Record<string, OrderType> = {
  LIMIT: OrderType.LIMIT,
  MARKET_LIMIT: OrderType.MARKET_LIMIT,
  MARKET_WITH_PROTECTION: OrderType.MARKET_WITH_PROTECTION,
  STOP_LOSS: OrderType.STOP_LOSS,
  STOP_LIMIT: OrderType.STOP_LIMIT,
};

/**
 * Osmium WebSocket client for Cube Exchange.
 * Uses binary protobuf via @cubexch/client for correct wire format.
 *
 * Authentication:
 * - HMAC env vars (CUBE_API_KEY + CUBE_SECRET_KEY): generates HMAC directly
 * - Verification key (npm run login): fetches HMAC from Iridium /users/hmac,
 *   then uses the returned {apiKey, signature, timestamp} for WebSocket auth
 *
 * Both paths produce the same Credentials protobuf message on the wire.
 */
export class OsmiumClient {
  private ws: WebSocket | null = null;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private requestIdCounter = 1n;
  private clientOrderIdCounter = BigInt(Date.now()) * 1000n;
  private pendingRequests = new Map<bigint, { resolve: (v: any) => void; reject: (e: Error) => void; timeout: ReturnType<typeof setTimeout> }>();
  private connected = false;
  private connecting: Promise<void> | null = null;
  private subaccountId: number | null = null;

  setSubaccountId(id: number): void {
    this.subaccountId = id;
  }

  private getSubaccountId(): bigint {
    if (this.subaccountId === null) {
      throw new Error('Subaccount ID not set. Call setSubaccountId() or wait for auto-discovery.');
    }
    return BigInt(this.subaccountId);
  }

  get isConnected(): boolean {
    return this.connected;
  }

  /**
   * Check if any credentials are available for WebSocket trading.
   * Supports both HMAC env vars and verification key (from npm run login).
   */
  static async canUseWebSocket(): Promise<boolean> {
    return hasAuth();
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    if (this.connecting) return this.connecting;

    this.connecting = this._connect();
    try {
      await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  private async _connect(): Promise<void> {
    const env = getEnvironment(process.env.CUBE_ENV);

    // Fetch access token via the best available auth method:
    // - HMAC env vars → generates signature locally
    // - Verification key → calls Iridium /users/hmac to get HMAC credentials
    const accessToken = await fetchAccessToken();

    return new Promise((resolve, reject) => {
      if (this.ws) {
        try { this.ws.close(); } catch { /* ignore */ }
        this.ws = null;
      }

      const connectTimeout = setTimeout(() => {
        reject(new Error('WebSocket connect timed out after 10s'));
        if (this.ws) {
          try { this.ws.close(); } catch { /* ignore */ }
          this.ws = null;
        }
      }, 10_000);

      this.ws = new WebSocket(env.wsTradeUrl);
      this.ws.binaryType = 'arraybuffer';

      this.ws.on('open', () => {
        // Send protobuf-encoded Credentials using HMAC from access token
        const credMsg: Credentials = {
          accessKeyId: accessToken.apiKey,
          signature: accessToken.signature,
          timestamp: BigInt(accessToken.timestamp),
          flags: 0n,
        };
        const encoded = CredentialsMethods.encode(credMsg).finish();
        this.ws!.send(encoded);
      });

      this.ws.on('message', (data: ArrayBuffer | Buffer) => {
        const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);

        // Try to decode as Bootstrap first (during connection phase)
        if (!this.connected) {
          try {
            const bootstrap = BootstrapMethods.decode(bytes);
            if (bootstrap.done) {
              clearTimeout(connectTimeout);
              this.connected = true;
              this.startHeartbeat();
              resolve();
              return;
            }
          } catch {
            // Not a bootstrap message, try as OrderResponse
          }
          return;
        }

        // After connected, decode as OrderResponse
        try {
          const response = OrderResponseMethods.decode(bytes);
          this.handleResponse(response);
        } catch {
          // Unknown message type — skip
        }
      });

      this.ws.on('error', (err: Error) => {
        if (!this.connected) {
          clearTimeout(connectTimeout);
          reject(err);
        }
      });

      this.ws.on('close', (code: number, reason: Buffer) => {
        clearTimeout(connectTimeout);
        const wasConnected = this.connected;
        this.connected = false;
        this.stopHeartbeat();

        // Reject all pending requests
        for (const [, pending] of this.pendingRequests) {
          clearTimeout(pending.timeout);
          pending.reject(new Error(`WebSocket closed: ${code} ${reason?.toString()}`));
        }
        this.pendingRequests.clear();

        if (!wasConnected) {
          reject(new Error(`WebSocket closed during connect: ${code} ${reason?.toString()}`));
        }
      });
    });
  }

  disconnect(): void {
    this.stopHeartbeat();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
  }

  // ── Order Operations ─────────────────────────────────────

  async placeOrder(params: PlaceOrderParams): Promise<OrderResult> {
    await this.ensureConnected();
    const requestId = this.nextRequestId();
    const clientOrderId = this.nextClientOrderId();

    const msg = OrderRequestMethods.encode({
      new: {
        clientOrderId,
        requestId,
        marketId: BigInt(params.marketId),
        price: params.price !== undefined ? BigInt(params.price) : undefined,
        quantity: params.quantity !== undefined ? BigInt(params.quantity) : undefined,
        side: SIDE_MAP[params.side] ?? Side.BID,
        timeInForce: TIF_MAP[params.timeInForce ?? 'GFS'] ?? TimeInForce.GOOD_FOR_SESSION,
        orderType: ORDER_TYPE_MAP[params.orderType ?? 'LIMIT'] ?? OrderType.LIMIT,
        subaccountId: this.getSubaccountId(),
        postOnly: params.postOnly ? PostOnly.ENABLED : PostOnly.DISABLED,
        cancelOnDisconnect: params.cancelOnDisconnect ?? true,
        quoteQuantity: params.quoteQuantity !== undefined ? BigInt(params.quoteQuantity) : undefined,
        stopPrice: params.stopPrice !== undefined ? BigInt(params.stopPrice) : undefined,
      },
    }).finish();

    this.ws!.send(msg);

    return this.waitForResponse<OrderResult>(requestId, clientOrderId, 30_000);
  }

  async cancelOrder(params: CancelOrderParams): Promise<CancelResult> {
    await this.ensureConnected();
    const requestId = this.nextRequestId();

    const msg = OrderRequestMethods.encode({
      cancel: {
        marketId: BigInt(params.marketId),
        clientOrderId: BigInt(params.clientOrderId),
        requestId,
        subaccountId: this.getSubaccountId(),
      },
    }).finish();

    this.ws!.send(msg);

    return this.waitForResponse<CancelResult>(requestId, BigInt(params.clientOrderId), 30_000);
  }

  async modifyOrder(params: ModifyOrderParams): Promise<OrderResult> {
    await this.ensureConnected();
    const requestId = this.nextRequestId();

    const msg = OrderRequestMethods.encode({
      modify: {
        marketId: BigInt(params.marketId),
        clientOrderId: BigInt(params.clientOrderId),
        requestId,
        subaccountId: this.getSubaccountId(),
        newPrice: params.newPrice !== undefined ? BigInt(params.newPrice) : undefined,
        newQuantity: BigInt(params.newQuantity),
        postOnly: params.postOnly ? PostOnly.ENABLED : PostOnly.DISABLED,
      },
    }).finish();

    this.ws!.send(msg);

    return this.waitForResponse<OrderResult>(requestId, BigInt(params.clientOrderId), 30_000);
  }

  async massCancel(params: MassCancelParams): Promise<MassCancelResult> {
    await this.ensureConnected();
    const requestId = this.nextRequestId();

    const msg = OrderRequestMethods.encode({
      mc: {
        subaccountId: this.getSubaccountId(),
        marketId: params.marketId !== undefined ? BigInt(params.marketId) : undefined,
        side: params.side !== undefined ? (SIDE_MAP[params.side] ?? undefined) : undefined,
        requestId,
      },
    }).finish();

    this.ws!.send(msg);

    return this.waitForResponse<MassCancelResult>(requestId, 0n, 30_000);
  }

  // ── Wallet WebSocket (DeFi intents) ──────────────────────

  private walletWs: WebSocket | null = null;
  private walletConnected = false;
  private walletConnecting: Promise<void> | null = null;
  private walletHeartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private walletPendingIntents = new Map<bigint, {
    resolve: (v: IntentResult) => void;
    reject: (e: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
  }>();
  private intentIdCounter = BigInt(Date.now()) * 1000n;

  get isWalletConnected(): boolean {
    return this.walletConnected;
  }

  /**
   * Connect to the wallet WebSocket for DeFi intent submission.
   * Uses the same access token flow as the trade WebSocket.
   */
  async connectWallet(): Promise<void> {
    if (this.walletConnected) return;
    if (this.walletConnecting) return this.walletConnecting;

    this.walletConnecting = this._connectWallet();
    try {
      await this.walletConnecting;
    } finally {
      this.walletConnecting = null;
    }
  }

  private async _connectWallet(): Promise<void> {
    const env = getEnvironment(process.env.CUBE_ENV);
    const accessToken = await fetchAccessToken();
    const wsUrl = env.wsTradeUrl.replace('/os', '/os/wallet');

    return new Promise((resolve, reject) => {
      if (this.walletWs) {
        try { this.walletWs.close(); } catch { /* ignore */ }
        this.walletWs = null;
      }

      const connectTimeout = setTimeout(() => {
        reject(new Error('Wallet WebSocket connect timed out after 10s'));
        if (this.walletWs) {
          try { this.walletWs.close(); } catch { /* ignore */ }
          this.walletWs = null;
        }
      }, 10_000);

      this.walletWs = new WebSocket(wsUrl);
      this.walletWs.binaryType = 'arraybuffer';

      this.walletWs.on('open', () => {
        const credMsg: Credentials = {
          accessKeyId: accessToken.apiKey,
          signature: accessToken.signature,
          timestamp: BigInt(accessToken.timestamp),
          flags: 0n,
        };
        const encoded = CredentialsMethods.encode(credMsg).finish();
        this.walletWs!.send(encoded);
      });

      this.walletWs.on('message', (data: ArrayBuffer | Buffer) => {
        const bytes = data instanceof ArrayBuffer
          ? new Uint8Array(data)
          : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);

        if (!this.walletConnected) {
          try {
            const event = WalletEventMethods.decode(bytes);
            if (event.positions) {
              clearTimeout(connectTimeout);
              this.walletConnected = true;
              this.startWalletHeartbeat();
              resolve();
              return;
            }
          } catch {
            // Not a wallet event yet
          }
          return;
        }

        try {
          const event = WalletEventMethods.decode(bytes);
          this.handleWalletEvent(event);
        } catch {
          // Unknown message
        }
      });

      this.walletWs.on('error', (err: Error) => {
        if (!this.walletConnected) {
          clearTimeout(connectTimeout);
          reject(err);
        }
      });

      this.walletWs.on('close', (code: number, reason: Buffer) => {
        clearTimeout(connectTimeout);
        const wasConnected = this.walletConnected;
        this.walletConnected = false;
        this.stopWalletHeartbeat();

        for (const [, pending] of this.walletPendingIntents) {
          clearTimeout(pending.timeout);
          pending.reject(new Error(`Wallet WebSocket closed: ${code} ${reason?.toString()}`));
        }
        this.walletPendingIntents.clear();

        if (!wasConnected) {
          reject(new Error(`Wallet WebSocket closed during connect: ${code} ${reason?.toString()}`));
        }
      });
    });
  }

  disconnectWallet(): void {
    this.stopWalletHeartbeat();
    if (this.walletWs) {
      this.walletWs.close();
      this.walletWs = null;
    }
    this.walletConnected = false;
  }

  /**
   * Submit a signed intent via the wallet WebSocket.
   */
  async submitIntent(params: SubmitIntentParams): Promise<IntentResult> {
    await this.ensureWalletConnected();

    const signingKey = await getSigningKey();
    const signingCreds = await getSigningCredentials();
    if (!signingKey || !signingCreds) {
      throw new Error('No signing credentials. Run `npm run login` first.');
    }

    const clientOrderId = this.intentIdCounter++;
    const timestamp = BigInt(Math.floor(Date.now() / 1000));
    const verificationKey = new Uint8Array(Buffer.from(signingCreds.verificationKey, 'base64'));

    const sig = await signMessage(params.intentBytes, signingKey);

    const intent: NewIntent = {
      subaccountId: BigInt(params.subaccountId),
      timestamp,
      sourceId: params.sourceId,
      intentType: params.intentType,
      intentBytes: params.intentBytes,
      verificationKey,
      signature: sig,
      clientOrderId,
    };

    const msg = WalletRequestMethods.encode({ newIntent: intent }).finish();
    this.walletWs!.send(msg);

    return this.waitForIntent(clientOrderId, 60_000);
  }

  private async ensureWalletConnected(): Promise<void> {
    if (!this.walletConnected) {
      await this.connectWallet();
    }
  }

  private startWalletHeartbeat(): void {
    this.walletHeartbeatInterval = setInterval(() => {
      if (this.walletWs && this.walletConnected) {
        const msg = WalletRequestMethods.encode({}).finish();
        this.walletWs.send(msg);
      }
    }, 25_000);
  }

  private stopWalletHeartbeat(): void {
    if (this.walletHeartbeatInterval) {
      clearInterval(this.walletHeartbeatInterval);
      this.walletHeartbeatInterval = null;
    }
  }

  private handleWalletEvent(event: WalletEvent): void {
    if (event.preflightIntentAck) {
      // Don't resolve yet — wait for the full intent result
    }

    if (event.preflightIntentReject) {
      const reject = event.preflightIntentReject;
      const pending = this.walletPendingIntents.get(reject.clientOrderId);
      if (pending) {
        this.walletPendingIntents.delete(reject.clientOrderId);
        clearTimeout(pending.timeout);
        pending.reject(new Error(`Intent rejected: ${reject.preflightFailureReason ?? 'unknown'}`));
      }
    }

    if (event.intent) {
      const intent = event.intent;
      const pending = this.walletPendingIntents.get(intent.clientOrderId);
      if (pending) {
        if (intent.success !== undefined || intent.failureReason !== undefined) {
          this.walletPendingIntents.delete(intent.clientOrderId);
          clearTimeout(pending.timeout);

          if (intent.success) {
            pending.resolve({
              status: 'success',
              intentId: intent.intentId.toString(),
              txnHash: intent.txnHash,
              deltas: intent.deltas.map(d => ({
                assetId: Number(d.assetId),
                delta: d.delta ? d.delta.word0.toString() : '0',
              })),
            });
          } else {
            pending.reject(new Error(
              `Intent failed: ${intent.failureReason} ${intent.failureContext ?? ''}`
            ));
          }
        }
      }
    }
  }

  private waitForIntent(clientOrderId: bigint, timeoutMs: number): Promise<IntentResult> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.walletPendingIntents.delete(clientOrderId);
        reject(new Error('Intent timed out after 60s'));
      }, timeoutMs);

      this.walletPendingIntents.set(clientOrderId, { resolve, reject, timeout });
    });
  }

  // ── Internals ────────────────────────────────────────────

  private async ensureConnected(): Promise<void> {
    if (!this.connected) {
      await this.connect();
    }
  }

  private nextRequestId(): bigint {
    return this.requestIdCounter++;
  }

  private nextClientOrderId(): bigint {
    return this.clientOrderIdCounter++;
  }

  private startHeartbeat(): void {
    this.heartbeatInterval = setInterval(() => {
      if (this.ws && this.connected) {
        const msg = OrderRequestMethods.encode({
          heartbeat: {
            requestId: this.nextRequestId(),
            timestamp: BigInt(Math.floor(Date.now() / 1000)),
          },
        }).finish();
        this.ws.send(msg);
      }
    }, 25_000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  private handleResponse(response: OrderResponse): void {
    let requestId: bigint | undefined;

    if (response.newAck) {
      requestId = response.newAck.requestId;
    } else if (response.cancelAck) {
      requestId = response.cancelAck.requestId;
    } else if (response.modifyAck) {
      requestId = response.modifyAck.requestId;
    } else if (response.massCancelAck) {
      requestId = response.massCancelAck.requestId;
    } else if (response.newReject) {
      requestId = response.newReject.requestId;
    } else if (response.cancelReject) {
      requestId = response.cancelReject.requestId;
    } else if (response.modifyReject) {
      requestId = response.modifyReject.requestId;
    }

    if (requestId === undefined) return;

    const pending = this.pendingRequests.get(requestId);
    if (!pending) return;

    this.pendingRequests.delete(requestId);
    clearTimeout(pending.timeout);

    // Rejects
    if (response.newReject) {
      pending.reject(new Error(`Order rejected: reason=${response.newReject.reason}`));
      return;
    }
    if (response.cancelReject) {
      pending.reject(new Error(`Cancel rejected: reason=${response.cancelReject.reason}`));
      return;
    }
    if (response.modifyReject) {
      pending.reject(new Error(`Modify rejected: reason=${response.modifyReject.reason}`));
      return;
    }

    // Acks
    if (response.newAck) {
      const ack = response.newAck;
      pending.resolve({
        type: 'newOrderAck',
        clientOrderId: ack.clientOrderId.toString(),
        exchangeOrderId: ack.exchangeOrderId.toString(),
        marketId: Number(ack.marketId),
        status: 'placed',
        price: ack.price?.toString() ?? '',
        quantity: ack.quantity.toString(),
        side: ack.side === Side.BID ? 'BID' : 'ASK',
        transactTime: ack.transactTime.toString(),
      } satisfies OrderResult);
      return;
    }

    if (response.cancelAck) {
      const ack = response.cancelAck;
      pending.resolve({
        type: 'cancelOrderAck',
        clientOrderId: ack.clientOrderId.toString(),
        reason: String(ack.reason),
        marketId: Number(ack.marketId),
        baseQuantityCanceled: ack.baseQuantityCanceled.toString(),
      } satisfies CancelResult);
      return;
    }

    if (response.modifyAck) {
      const ack = response.modifyAck;
      pending.resolve({
        type: 'modifyOrderAck',
        clientOrderId: ack.clientOrderId.toString(),
        exchangeOrderId: '',
        marketId: Number(ack.marketId),
        status: 'modified',
        price: ack.price?.toString() ?? '',
        quantity: ack.remainingQuantity.toString(),
        side: '',
        transactTime: ack.transactTime.toString(),
      } satisfies OrderResult);
      return;
    }

    if (response.massCancelAck) {
      const ack = response.massCancelAck;
      pending.resolve({
        type: 'massCancelAck',
        totalAffectedOrders: Number(ack.totalAffectedOrders),
        reason: String(ack.reason),
      } satisfies MassCancelResult);
      return;
    }
  }

  private waitForResponse<T>(requestId: bigint, _clientOrderId: bigint, timeoutMs: number): Promise<T> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error('Request timed out after 30s'));
      }, timeoutMs);

      this.pendingRequests.set(requestId, { resolve, reject, timeout });
    });
  }
}

// ── Types ──────────────────────────────────────────────────

export interface PlaceOrderParams {
  marketId: number;
  side: 'BID' | 'ASK';
  price?: string;
  quantity?: string;
  orderType?: 'LIMIT' | 'MARKET_LIMIT' | 'MARKET_WITH_PROTECTION' | 'STOP_LOSS' | 'STOP_LIMIT';
  timeInForce?: 'IOC' | 'GFS' | 'FOK';
  postOnly?: boolean;
  cancelOnDisconnect?: boolean;
  stopPrice?: string;
  quoteQuantity?: string;
}

export interface CancelOrderParams {
  marketId: number;
  clientOrderId: string;
}

export interface ModifyOrderParams {
  marketId: number;
  clientOrderId: string;
  newPrice?: string;
  newQuantity: string;
  postOnly?: boolean;
}

export interface MassCancelParams {
  marketId?: number;
  side?: 'BID' | 'ASK';
}

export interface OrderResult {
  type: string;
  clientOrderId: string;
  exchangeOrderId: string;
  marketId: number;
  status: string;
  price: string;
  quantity: string;
  side: string;
  transactTime: string;
}

export interface CancelResult {
  type: string;
  clientOrderId: string;
  reason: string;
  marketId: number;
  baseQuantityCanceled: string;
}

export interface MassCancelResult {
  type: string;
  totalAffectedOrders: number;
  reason: string;
}

// ── Wallet/Intent Types ───────────────────────────────────

export interface SubmitIntentParams {
  subaccountId: number;
  sourceId: number;
  intentType: number;
  intentBytes: Uint8Array;
}

export interface IntentResult {
  status: 'success' | 'failed';
  intentId: string;
  txnHash?: string;
  deltas: Array<{ assetId: number; delta: string }>;
}
