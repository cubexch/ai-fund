import { WebSocket } from 'ws';
import { generateSignature, getCredentials, getEnvironment } from './auth.js';

/**
 * Osmium WebSocket client for Cube Exchange.
 * Handles: real-time order submission, cancellation, modification,
 * market data streaming, and position updates via protobuf.
 *
 * For the MCP server, we use a simplified JSON-message approach
 * that wraps the protobuf client for tool-level interactions.
 */
export class OsmiumClient {
  private ws: WebSocket | null = null;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private requestIdCounter = 1n;
  private clientOrderIdCounter = BigInt(Date.now()) * 1000n;
  private pendingRequests = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private connected = false;
  private subaccountId: number;

  constructor() {
    const creds = getCredentials();
    this.subaccountId = creds.subaccountId;
  }

  get isConnected(): boolean {
    return this.connected;
  }

  async connect(): Promise<void> {
    if (this.connected) return;

    const env = getEnvironment(process.env.CUBE_ENV);
    const creds = getCredentials();
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = generateSignature(creds.secretKey, timestamp);

    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(env.wsTradeUrl);

      this.ws.on('open', () => {
        // Send credentials
        this.ws!.send(
          JSON.stringify({
            type: 'credentials',
            accessKeyId: creds.apiKey,
            signature,
            timestamp,
          })
        );
      });

      this.ws.on('message', (data: Buffer) => {
        try {
          const msg = JSON.parse(data.toString());
          this.handleMessage(msg);

          if (msg.type === 'bootstrap' && msg.done) {
            this.connected = true;
            this.startHeartbeat();
            resolve();
          }
        } catch {
          // Binary protobuf message — skip in JSON mode
        }
      });

      this.ws.on('error', (err: Error) => {
        if (!this.connected) reject(err);
      });

      this.ws.on('close', (code: number, reason: Buffer) => {
        this.connected = false;
        this.stopHeartbeat();
        // Reject all pending requests
        for (const [, pending] of this.pendingRequests) {
          pending.reject(new Error(`WebSocket closed: ${code} ${reason}`));
        }
        this.pendingRequests.clear();
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

    const msg = {
      type: 'newOrder',
      requestId: requestId.toString(),
      clientOrderId: clientOrderId.toString(),
      marketId: params.marketId,
      side: params.side,
      orderType: params.orderType || 'LIMIT',
      timeInForce: params.timeInForce || 'GFS',
      price: params.price,
      quantity: params.quantity,
      postOnly: params.postOnly || false,
      subaccountId: this.subaccountId,
      cancelOnDisconnect: params.cancelOnDisconnect ?? true,
    };

    return this.sendAndWait<OrderResult>(requestId.toString(), msg);
  }

  async cancelOrder(params: CancelOrderParams): Promise<CancelResult> {
    await this.ensureConnected();
    const requestId = this.nextRequestId();

    const msg = {
      type: 'cancelOrder',
      requestId: requestId.toString(),
      marketId: params.marketId,
      clientOrderId: params.clientOrderId,
      subaccountId: this.subaccountId,
    };

    return this.sendAndWait<CancelResult>(requestId.toString(), msg);
  }

  async modifyOrder(params: ModifyOrderParams): Promise<OrderResult> {
    await this.ensureConnected();
    const requestId = this.nextRequestId();

    const msg = {
      type: 'modifyOrder',
      requestId: requestId.toString(),
      marketId: params.marketId,
      clientOrderId: params.clientOrderId,
      newPrice: params.newPrice,
      newQuantity: params.newQuantity,
      subaccountId: this.subaccountId,
      postOnly: params.postOnly || false,
    };

    return this.sendAndWait<OrderResult>(requestId.toString(), msg);
  }

  async massCancel(params: MassCancelParams): Promise<MassCancelResult> {
    await this.ensureConnected();
    const requestId = this.nextRequestId();

    const msg = {
      type: 'massCancel',
      requestId: requestId.toString(),
      subaccountId: this.subaccountId,
      marketId: params.marketId,
      side: params.side,
    };

    return this.sendAndWait<MassCancelResult>(requestId.toString(), msg);
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
        this.ws.send(
          JSON.stringify({
            type: 'heartbeat',
            requestId: this.nextRequestId().toString(),
            timestamp: Math.floor(Date.now() / 1000).toString(),
          })
        );
      }
    }, 25_000); // Every 25s (server requires < 30s)
  }

  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  private handleMessage(msg: any): void {
    if (msg.requestId && this.pendingRequests.has(msg.requestId)) {
      const pending = this.pendingRequests.get(msg.requestId)!;
      this.pendingRequests.delete(msg.requestId);

      if (msg.type?.includes('Reject')) {
        pending.reject(new Error(`Order rejected: ${msg.reason}`));
      } else {
        pending.resolve(msg);
      }
    }
  }

  private sendAndWait<T>(requestId: string, msg: any): Promise<T> {
    return new Promise((resolve, reject) => {
      this.pendingRequests.set(requestId, { resolve, reject });

      const timeout = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error('Request timed out after 30s'));
      }, 30_000);

      this.pendingRequests.set(requestId, {
        resolve: v => {
          clearTimeout(timeout);
          resolve(v);
        },
        reject: e => {
          clearTimeout(timeout);
          reject(e);
        },
      });

      this.ws!.send(JSON.stringify(msg));
    });
  }
}

// ── Types ──────────────────────────────────────────────────

export interface PlaceOrderParams {
  marketId: number;
  side: 'BID' | 'ASK';
  price?: string;
  quantity: string;
  orderType?: 'LIMIT' | 'MARKET_LIMIT' | 'MARKET_WITH_PROTECTION' | 'STOP_LOSS' | 'STOP_LIMIT';
  timeInForce?: 'IOC' | 'GFS' | 'FOK';
  postOnly?: boolean;
  cancelOnDisconnect?: boolean;
  stopPrice?: string;
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
