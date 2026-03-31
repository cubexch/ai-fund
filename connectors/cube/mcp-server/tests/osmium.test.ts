import { describe, it, expect } from 'vitest';
import {
  CredentialsMethods,
  OrderRequestMethods,
  OrderResponseMethods,
  BootstrapMethods,
} from '@cubexch/client/lib/methods/trade.js';
import {
  Side,
  TimeInForce,
  OrderType,
  PostOnly,
} from '@cubexch/client/lib/trade.js';
import type {
  Credentials,
  OrderRequest,
  OrderResponse,
  Bootstrap,
  NewOrder,
} from '@cubexch/client/lib/trade.js';

describe('Protobuf Encoding — Credentials', () => {
  it('encodes and decodes credentials correctly', () => {
    const cred: Credentials = {
      accessKeyId: 'test-api-key-uuid',
      signature: 'dGVzdC1zaWduYXR1cmU=',
      timestamp: 1700000000n,
      flags: 0n,
    };

    const encoded = CredentialsMethods.encode(cred).finish();
    expect(encoded).toBeInstanceOf(Uint8Array);
    expect(encoded.length).toBeGreaterThan(0);

    const decoded = CredentialsMethods.decode(encoded);
    expect(decoded.accessKeyId).toBe('test-api-key-uuid');
    expect(decoded.signature).toBe('dGVzdC1zaWduYXR1cmU=');
    expect(decoded.timestamp).toBe(1700000000n);
  });
});

describe('Protobuf Encoding — OrderRequest (NewOrder)', () => {
  it('encodes a limit buy order', () => {
    const order: OrderRequest = {
      new: {
        clientOrderId: 1234567890n,
        requestId: 1n,
        marketId: 100086n, // SOLUSDC
        price: 8369n,       // 83.69 in lots (priceTickSize=0.01)
        quantity: 119n,      // 0.0119 in lots (quantityTickSize=0.0001)
        side: Side.BID,
        timeInForce: TimeInForce.GOOD_FOR_SESSION,
        orderType: OrderType.LIMIT,
        subaccountId: 42n,
        postOnly: PostOnly.DISABLED,
        cancelOnDisconnect: true,
      },
    };

    const encoded = OrderRequestMethods.encode(order).finish();
    expect(encoded).toBeInstanceOf(Uint8Array);
    expect(encoded.length).toBeGreaterThan(0);

    const decoded = OrderRequestMethods.decode(encoded);
    expect(decoded.new).toBeDefined();
    expect(decoded.new!.clientOrderId).toBe(1234567890n);
    expect(decoded.new!.marketId).toBe(100086n);
    expect(decoded.new!.price).toBe(8369n);
    expect(decoded.new!.quantity).toBe(119n);
    expect(decoded.new!.side).toBe(Side.BID);
    expect(decoded.new!.timeInForce).toBe(TimeInForce.GOOD_FOR_SESSION);
    expect(decoded.new!.orderType).toBe(OrderType.LIMIT);
    expect(decoded.new!.subaccountId).toBe(42n);
    expect(decoded.new!.cancelOnDisconnect).toBe(true);
  });

  it('encodes a market sell order', () => {
    const order: OrderRequest = {
      new: {
        clientOrderId: 999n,
        requestId: 2n,
        marketId: 100004n, // BTCUSDC
        quantity: 1n,
        side: Side.ASK,
        timeInForce: TimeInForce.IMMEDIATE_OR_CANCEL,
        orderType: OrderType.MARKET_WITH_PROTECTION,
        subaccountId: 42n,
        postOnly: PostOnly.DISABLED,
        cancelOnDisconnect: true,
      },
    };

    const encoded = OrderRequestMethods.encode(order).finish();
    const decoded = OrderRequestMethods.decode(encoded);
    expect(decoded.new!.side).toBe(Side.ASK);
    expect(decoded.new!.orderType).toBe(OrderType.MARKET_WITH_PROTECTION);
    expect(decoded.new!.timeInForce).toBe(TimeInForce.IMMEDIATE_OR_CANCEL);
    // price should be undefined for market orders
    expect(decoded.new!.price).toBeUndefined();
  });

  it('encodes a heartbeat', () => {
    const hb: OrderRequest = {
      heartbeat: {
        requestId: 100n,
        timestamp: BigInt(Math.floor(Date.now() / 1000)),
      },
    };

    const encoded = OrderRequestMethods.encode(hb).finish();
    const decoded = OrderRequestMethods.decode(encoded);
    expect(decoded.heartbeat).toBeDefined();
    expect(decoded.heartbeat!.requestId).toBe(100n);
  });

  it('encodes a cancel order', () => {
    const cancel: OrderRequest = {
      cancel: {
        marketId: 100086n,
        clientOrderId: 1234567890n,
        requestId: 3n,
        subaccountId: 42n,
      },
    };

    const encoded = OrderRequestMethods.encode(cancel).finish();
    const decoded = OrderRequestMethods.decode(encoded);
    expect(decoded.cancel).toBeDefined();
    expect(decoded.cancel!.clientOrderId).toBe(1234567890n);
    expect(decoded.cancel!.marketId).toBe(100086n);
  });

  it('encodes a mass cancel', () => {
    const mc: OrderRequest = {
      mc: {
        subaccountId: 42n,
        requestId: 4n,
        marketId: 100086n,
        side: Side.BID,
      },
    };

    const encoded = OrderRequestMethods.encode(mc).finish();
    const decoded = OrderRequestMethods.decode(encoded);
    expect(decoded.mc).toBeDefined();
    expect(decoded.mc!.subaccountId).toBe(42n);
    expect(decoded.mc!.side).toBe(Side.BID);
  });
});

describe('Protobuf Encoding — OrderResponse', () => {
  it('encodes and decodes a NewOrderAck', () => {
    const response: OrderResponse = {
      newAck: {
        msgSeqNum: 1n,
        clientOrderId: 1234567890n,
        requestId: 1n,
        exchangeOrderId: 9876543210n,
        marketId: 100086n,
        price: 8369n,
        quantity: 119n,
        side: Side.BID,
        timeInForce: TimeInForce.GOOD_FOR_SESSION,
        orderType: OrderType.LIMIT,
        transactTime: BigInt(Date.now()) * 1000n,
        subaccountId: 42n,
        cancelOnDisconnect: true,
        status: 0,
      },
    };

    const encoded = OrderResponseMethods.encode(response).finish();
    const decoded = OrderResponseMethods.decode(encoded);
    expect(decoded.newAck).toBeDefined();
    expect(decoded.newAck!.clientOrderId).toBe(1234567890n);
    expect(decoded.newAck!.exchangeOrderId).toBe(9876543210n);
    expect(decoded.newAck!.price).toBe(8369n);
    expect(decoded.newAck!.quantity).toBe(119n);
  });

  it('encodes and decodes a NewOrderReject', () => {
    const response: OrderResponse = {
      newReject: {
        msgSeqNum: 2n,
        clientOrderId: 999n,
        requestId: 2n,
        transactTime: BigInt(Date.now()) * 1000n,
        subaccountId: 42n,
        reason: 2, // EXCEEDED_SPOT_POSITION
        marketId: 100086n,
        price: 8369n,
        quantity: 119n,
        side: Side.BID,
        timeInForce: TimeInForce.GOOD_FOR_SESSION,
        orderType: OrderType.LIMIT,
        cancelOnDisconnect: true,
      },
    };

    const encoded = OrderResponseMethods.encode(response).finish();
    const decoded = OrderResponseMethods.decode(encoded);
    expect(decoded.newReject).toBeDefined();
    expect(decoded.newReject!.reason).toBe(2);
    expect(decoded.newReject!.clientOrderId).toBe(999n);
  });
});

describe('Protobuf Encoding — Bootstrap', () => {
  it('encodes and decodes a bootstrap done message', () => {
    const bootstrap: Bootstrap = {
      done: {
        latestTransactTime: BigInt(Date.now()) * 1000n,
        readOnly: false,
      },
    };

    const encoded = BootstrapMethods.encode(bootstrap).finish();
    const decoded = BootstrapMethods.decode(encoded);
    expect(decoded.done).toBeDefined();
    expect(decoded.done!.readOnly).toBe(false);
  });
});

describe('Lot Conversion', () => {
  // Replicate the toLots/fromLots logic from orders.ts
  function toLots(humanValue: string, tickSize: string): string {
    const hv = parseFloat(humanValue);
    const ts = parseFloat(tickSize);
    return Math.round(hv / ts).toString();
  }

  function fromLots(lots: string, tickSize: string): string {
    const l = parseFloat(lots);
    const ts = parseFloat(tickSize);
    return (l * ts).toString();
  }

  it('converts SOL price to lots (priceTickSize=0.01)', () => {
    expect(toLots('83.69', '0.01')).toBe('8369');
    expect(toLots('100.00', '0.01')).toBe('10000');
    expect(toLots('0.50', '0.01')).toBe('50');
  });

  it('converts SOL quantity to lots (quantityTickSize=0.0001)', () => {
    expect(toLots('0.0119', '0.0001')).toBe('119');
    expect(toLots('1.0', '0.0001')).toBe('10000');
    expect(toLots('0.5', '0.0001')).toBe('5000');
  });

  it('converts BTC price to lots (priceTickSize=0.1)', () => {
    expect(toLots('67885.3', '0.1')).toBe('678853');
  });

  it('converts lots back to human-readable', () => {
    expect(fromLots('8369', '0.01')).toBe('83.69');
    expect(fromLots('119', '0.0001')).toBe('0.0119');
  });

  it('handles small tick sizes for memecoins', () => {
    // BONK: quantityTickSize could be 1000
    expect(toLots('150000', '1000')).toBe('150');
    // PEPPER: priceTickSize could be 1e-10
    expect(toLots('0.000000000894', '0.0000000001')).toBe('9');
  });
});
