import { WebSocket } from 'ws';
import { buildWsVerificationKeyCredentials, getEnvironment, getSigningCredentials, getSigningKey, hasAuth, resolveAuth } from './auth';
import { signMessage, encodePublicKey, fromHex } from './signing';
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
  ConnectionFlags,
} from '@cubexch/client/lib/trade.js';
import type {
  Credentials,
  OrderResponse,
  OrderRequest,
  AssetPosition,
  Fill,
  SignatureInfo,
  Bootstrap,
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
 * Authentication via Ed25519 verification key (npm run login or CUBE_SIGNING_KEY env).
 */
export class OsmiumClient {
  private ws: WebSocket | null = null;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private requestIdCounter = 1n;
  private clientOrderIdCounter = BigInt(Date.now()) * 1000n;
  private pendingRequests = new Map<bigint, { resolve: (v: any) => void; reject: (e: Error) => void; timeout: ReturnType<typeof setTimeout> }>();
  /** Track IOC/FOK orders awaiting fills + cancel to report full execution result */
  private pendingIocOrders = new Map<bigint, {
    resolve: (v: OrderResult) => void;
    reject: (e: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
    ack: { clientOrderId: string; exchangeOrderId: string; marketId: number; side: string; transactTime: string };
    fills: Array<{ fillPrice: string; fillQuantity: string; fillQuoteQuantity: string }>;
    totalFillQuantity: bigint;
  }>();
  private connected = false;
  private connecting: Promise<void> | null = null;
  private subaccountId: number | null = null;
  private signingKey: CryptoKey | null = null;
  private verificationKeyEncoded: string | null = null;

  // Bootstrap data from connection
  private _bootstrapOrders: BootstrapOrder[] = [];
  private _bootstrapPositions: AssetPosition[] = [];

  // Event callbacks for live updates
  onFill?: (fill: Fill) => void;
  onPositionUpdate?: (position: AssetPosition) => void;
  /** Progress callback for order lifecycle events (submitted, ack, fill, cancel) */
  onOrderProgress?: (event: OrderProgressEvent) => void;

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

    // Resolve signing key for order signatures
    const auth = await resolveAuth();
    if (auth) {
      this.signingKey = auth.privateKey;
      this.verificationKeyEncoded = encodePublicKey(fromHex(auth.publicKeyHex));
    }

    const wsCreds = await buildWsVerificationKeyCredentials();

    // Reset bootstrap state
    this._bootstrapOrders = [];
    this._bootstrapPositions = [];

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
        const credMsg: Credentials = {
          accessKeyId: wsCreds.accessKeyId,
          signature: wsCreds.signature,
          timestamp: wsCreds.timestamp,
          flags: BigInt(ConnectionFlags.CF_WALLET_EVENTS),
          verificationKey: wsCreds.verificationKey,
          userKey: wsCreds.userKey,
        };
        const encoded = CredentialsMethods.encode(credMsg).finish();
        this.ws!.send(encoded);
      });

      this.ws.on('message', (data: ArrayBuffer | Buffer) => {
        const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);

        // During connection phase, decode as Bootstrap
        if (!this.connected) {
          try {
            const bootstrap = BootstrapMethods.decode(bytes);
            this.handleBootstrap(bootstrap);
            if (bootstrap.done) {
              clearTimeout(connectTimeout);
              this.connected = true;
              this.startHeartbeat();
              resolve();
              return;
            }
          } catch {
            // Not a bootstrap message — skip during connect phase
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

        // Reject all pending IOC orders
        for (const [, pending] of this.pendingIocOrders) {
          clearTimeout(pending.timeout);
          pending.reject(new Error(`WebSocket closed: ${code} ${reason?.toString()}`));
        }
        this.pendingIocOrders.clear();

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

    const request: OrderRequest = {
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
    };

    const isIoc = (params.timeInForce === 'IOC' || params.timeInForce === 'FOK');

    // For IOC/FOK: register tracking BEFORE sending so fills/cancels aren't missed
    if (isIoc) {
      const iocPromise = this.setupIocTracking(requestId, clientOrderId, 30_000);
      const msg = await this.encodeAndSign(request);
      this.ws!.send(msg);
      this.onOrderProgress?.({ stage: 'submitted', clientOrderId: clientOrderId.toString(), side: params.side, orderType: params.orderType ?? 'LIMIT', timeInForce: params.timeInForce ?? 'GFS' });
      return iocPromise;
    }

    const msg = await this.encodeAndSign(request);
    this.ws!.send(msg);
    this.onOrderProgress?.({ stage: 'submitted', clientOrderId: clientOrderId.toString(), side: params.side, orderType: params.orderType ?? 'LIMIT', timeInForce: params.timeInForce ?? 'GFS' });
    return this.waitForResponse<OrderResult>(requestId, clientOrderId, 30_000);
  }

  async cancelOrder(params: CancelOrderParams): Promise<CancelResult> {
    await this.ensureConnected();
    const requestId = this.nextRequestId();

    const request: OrderRequest = {
      cancel: {
        marketId: BigInt(params.marketId),
        clientOrderId: BigInt(params.clientOrderId),
        requestId,
        subaccountId: this.getSubaccountId(),
      },
    };

    const msg = await this.encodeAndSign(request);
    this.ws!.send(msg);

    return this.waitForResponse<CancelResult>(requestId, BigInt(params.clientOrderId), 30_000);
  }

  async modifyOrder(params: ModifyOrderParams): Promise<OrderResult> {
    await this.ensureConnected();
    const requestId = this.nextRequestId();

    const request: OrderRequest = {
      modify: {
        marketId: BigInt(params.marketId),
        clientOrderId: BigInt(params.clientOrderId),
        requestId,
        subaccountId: this.getSubaccountId(),
        newPrice: params.newPrice !== undefined ? BigInt(params.newPrice) : undefined,
        newQuantity: BigInt(params.newQuantity),
        postOnly: params.postOnly ? PostOnly.ENABLED : PostOnly.DISABLED,
      },
    };

    const msg = await this.encodeAndSign(request);
    this.ws!.send(msg);

    return this.waitForResponse<OrderResult>(requestId, BigInt(params.clientOrderId), 30_000);
  }

  async massCancel(params: MassCancelParams): Promise<MassCancelResult> {
    await this.ensureConnected();
    const requestId = this.nextRequestId();

    const request: OrderRequest = {
      mc: {
        subaccountId: this.getSubaccountId(),
        marketId: params.marketId !== undefined ? BigInt(params.marketId) : undefined,
        side: params.side !== undefined ? (SIDE_MAP[params.side] ?? undefined) : undefined,
        requestId,
      },
    };

    const msg = await this.encodeAndSign(request);
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
    const wsCreds = await buildWsVerificationKeyCredentials();
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
          accessKeyId: wsCreds.accessKeyId,
          signature: wsCreds.signature,
          timestamp: wsCreds.timestamp,
          flags: wsCreds.flags,
          verificationKey: wsCreds.verificationKey,
          userKey: wsCreds.userKey,
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

  // ── Getters for bootstrap data ────────────────────────────

  get bootstrapOrders(): BootstrapOrder[] {
    return this._bootstrapOrders;
  }

  get bootstrapPositions(): AssetPosition[] {
    return this._bootstrapPositions;
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

  /**
   * Encode an OrderRequest and sign it with Ed25519 if signing key is available.
   * Follows the same pattern as the app and core test helpers:
   * 1. Encode request WITHOUT signatureInfo
   * 2. Sign the encoded bytes
   * 3. Re-encode WITH signatureInfo
   */
  private async encodeAndSign(request: OrderRequest): Promise<Uint8Array> {
    if (!this.signingKey || !this.verificationKeyEncoded) {
      // No signing key — send unsigned (will fail if server requires signatures)
      return OrderRequestMethods.encode(request).finish();
    }

    // 1. Encode without signatureInfo
    const unsignedBytes = OrderRequestMethods.encode({
      ...request,
      signatureInfo: undefined,
    }).finish();

    // 2. Sign the encoded bytes with Ed25519
    const signature = await signMessage(unsignedBytes, this.signingKey);

    // 3. Re-encode with signatureInfo
    const signatureInfo: SignatureInfo = {
      signature: Buffer.from(signature).toString('base64').replace(/=+$/, ''),
      verificationKey: this.verificationKeyEncoded,
      timestamp: BigInt(Math.floor(Date.now() / 1000)),
    };

    return OrderRequestMethods.encode({
      ...request,
      signatureInfo,
    }).finish();
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

  /**
   * Process bootstrap messages received during connection.
   * Bootstrap contains: active orders, asset positions, contract positions, done.
   */
  private handleBootstrap(bootstrap: Bootstrap): void {
    if (bootstrap.active) {
      for (const order of bootstrap.active.orders) {
        this._bootstrapOrders.push({
          clientOrderId: order.clientOrderId.toString(),
          exchangeOrderId: order.exchangeOrderId.toString(),
          marketId: Number(order.marketId),
          price: order.price?.toString() ?? '',
          quantity: order.orderQuantity.toString(),
          side: order.side === Side.BID ? 'BID' : 'ASK',
          orderType: order.orderType,
          timeInForce: order.timeInForce,
        });
      }
    }
    if (bootstrap.position) {
      for (const pos of bootstrap.position.positions) {
        this._bootstrapPositions.push(pos);
      }
    }
  }

  private handleResponse(response: OrderResponse): void {
    // Handle live position updates (no requestId matching needed)
    if (response.position) {
      this.onPositionUpdate?.(response.position);
      return;
    }

    // Handle fill notifications
    if (response.fill) {
      this.onFill?.(response.fill);
      this.onOrderProgress?.({
        stage: 'fill',
        clientOrderId: response.fill.clientOrderId.toString(),
        fillPrice: response.fill.fillPrice.toString(),
        fillQuantity: response.fill.fillQuantity.toString(),
        leavesQuantity: response.fill.leavesQuantity.toString(),
        cumulativeQuantity: response.fill.cumulativeQuantity.toString(),
      });
      // Accumulate fill for pending IOC orders
      const iocPending = this.pendingIocOrders.get(response.fill.clientOrderId);
      if (iocPending) {
        iocPending.fills.push({
          fillPrice: response.fill.fillPrice.toString(),
          fillQuantity: response.fill.fillQuantity.toString(),
          fillQuoteQuantity: response.fill.fillQuoteQuantity.toString(),
        });
        iocPending.totalFillQuantity += BigInt(response.fill.fillQuantity);
        // If fully filled (leavesQuantity === 0), resolve immediately — no cancel will come
        if (BigInt(response.fill.leavesQuantity) === 0n) {
          this.pendingIocOrders.delete(response.fill.clientOrderId);
          clearTimeout(iocPending.timeout);
          this.onOrderProgress?.({ stage: 'done', clientOrderId: response.fill.clientOrderId.toString(), status: 'filled' });
          iocPending.resolve({
            type: 'newOrderAck',
            ...iocPending.ack,
            status: 'filled',
            quantity: iocPending.totalFillQuantity.toString(),
            price: iocPending.fills[0].fillPrice,
            fills: iocPending.fills,
          } as OrderResult);
        }
      }
      return;
    }

    // IOC cancel: resolve the pending IOC order with execution results.
    // Match ANY cancel against pending IOC orders — reason can be IOC(3),
    // WOULD_EXCEED_PROTECTION_RANGE(10), or others depending on market conditions.
    if (response.cancelAck) {
      const iocPending = this.pendingIocOrders.get(response.cancelAck.clientOrderId);
      if (iocPending) {
        this.pendingIocOrders.delete(response.cancelAck.clientOrderId);
        clearTimeout(iocPending.timeout);
        const filled = iocPending.totalFillQuantity > 0n;
        const status = filled ? 'partial_fill' : 'canceled';
        this.onOrderProgress?.({ stage: 'done', clientOrderId: response.cancelAck.clientOrderId.toString(), status, canceledQuantity: response.cancelAck.baseQuantityCanceled.toString() });
        iocPending.resolve({
          type: 'newOrderAck',
          ...iocPending.ack,
          status,
          quantity: iocPending.totalFillQuantity.toString(),
          price: iocPending.fills.length > 0 ? iocPending.fills[0].fillPrice : '',
          fills: iocPending.fills,
          canceledQuantity: response.cancelAck.baseQuantityCanceled.toString(),
        } as OrderResult);
        return;
      }
    }

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
      this.onOrderProgress?.({ stage: 'rejected', reason: `reason=${response.newReject.reason}` });
      pending.reject(new Error(`Order rejected: reason=${response.newReject.reason}`));
      return;
    }
    if (response.cancelReject) {
      this.onOrderProgress?.({ stage: 'rejected', reason: `cancel rejected: reason=${response.cancelReject.reason}` });
      pending.reject(new Error(`Cancel rejected: reason=${response.cancelReject.reason}`));
      return;
    }
    if (response.modifyReject) {
      this.onOrderProgress?.({ stage: 'rejected', reason: `modify rejected: reason=${response.modifyReject.reason}` });
      pending.reject(new Error(`Modify rejected: reason=${response.modifyReject.reason}`));
      return;
    }

    // Acks
    if (response.newAck) {
      const ack = response.newAck;
      this.onOrderProgress?.({ stage: 'ack', clientOrderId: ack.clientOrderId.toString(), exchangeOrderId: ack.exchangeOrderId.toString() });
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
      this.onOrderProgress?.({ stage: 'canceled', clientOrderId: ack.clientOrderId.toString(), canceledQuantity: ack.baseQuantityCanceled.toString() });
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
      this.onOrderProgress?.({ stage: 'modified', clientOrderId: ack.clientOrderId.toString() });
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

  /**
   * Set up IOC/FOK order tracking BEFORE sending the order.
   * Registers both the ack listener (pendingRequests) and the IOC lifecycle tracker
   * (pendingIocOrders) atomically so that fills/cancels arriving immediately after
   * the ack are never missed.
   */
  private setupIocTracking(requestId: bigint, clientOrderId: bigint, timeoutMs: number): Promise<OrderResult> {
    return new Promise<OrderResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        this.pendingIocOrders.delete(clientOrderId);
        reject(new Error('IOC order timed out after 30s'));
      }, timeoutMs);

      // Register IOC fill/cancel tracker keyed by clientOrderId
      this.pendingIocOrders.set(clientOrderId, {
        resolve,
        reject,
        timeout,
        ack: {
          clientOrderId: clientOrderId.toString(),
          exchangeOrderId: '',
          marketId: 0,
          side: '',
          transactTime: '',
        },
        fills: [],
        totalFillQuantity: 0n,
      });

      // Register ack listener keyed by requestId — updates the IOC tracker with ack data.
      // Uses a dummy timeout since the real timeout lives on the IOC entry.
      this.pendingRequests.set(requestId, {
        resolve: (ackResult: OrderResult) => {
          const iocEntry = this.pendingIocOrders.get(clientOrderId);
          if (iocEntry) {
            iocEntry.ack = {
              clientOrderId: ackResult.clientOrderId,
              exchangeOrderId: ackResult.exchangeOrderId,
              marketId: ackResult.marketId,
              side: ackResult.side,
              transactTime: ackResult.transactTime,
            };
          }
          // Don't resolve the outer promise — wait for fills + cancel
        },
        reject: (err: Error) => {
          // Order rejected — clean up IOC tracking and reject
          this.pendingIocOrders.delete(clientOrderId);
          clearTimeout(timeout);
          reject(err);
        },
        timeout: setTimeout(() => {}, 0), // dummy — real timeout on IOC entry
      });
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
  /** Fills for IOC/FOK orders */
  fills?: Array<{ fillPrice: string; fillQuantity: string; fillQuoteQuantity: string }>;
  /** Quantity canceled (unfilled) for IOC orders */
  canceledQuantity?: string;
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

export interface BootstrapOrder {
  clientOrderId: string;
  exchangeOrderId: string;
  marketId: number;
  price: string;
  quantity: string;
  side: string;
  orderType: number;
  timeInForce: number;
}

/** Progress events emitted during order lifecycle */
export type OrderProgressEvent =
  | { stage: 'submitted'; clientOrderId: string; side: string; orderType: string; timeInForce: string }
  | { stage: 'ack'; clientOrderId: string; exchangeOrderId: string }
  | { stage: 'fill'; clientOrderId: string; fillPrice: string; fillQuantity: string; leavesQuantity: string; cumulativeQuantity: string }
  | { stage: 'canceled'; clientOrderId: string; canceledQuantity: string }
  | { stage: 'modified'; clientOrderId: string }
  | { stage: 'rejected'; reason: string }
  | { stage: 'done'; clientOrderId: string; status: string; canceledQuantity?: string };
