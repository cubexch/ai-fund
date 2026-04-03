import { describe, it, expect } from 'vitest';
import { AssetRegistry } from '../src/client/iridium';
import type { Market } from '../src/client/iridium';

function makeMarket(overrides: Partial<Market> & Pick<Market, 'symbol' | 'baseAssetId' | 'quoteAssetId'>): Market {
  return {
    marketId: 100000,
    baseLotSize: '1',
    quoteLotSize: '1',
    priceDisplayDecimals: 2,
    priceTickSize: '0.01',
    quantityTickSize: '0.01',
    status: 1,
    ...overrides,
  };
}

describe('AssetRegistry', () => {
  it('builds from markets and resolves assetId → symbol', () => {
    const registry = new AssetRegistry();
    registry.buildFromMarkets([
      makeMarket({ symbol: 'BTCUSDC', baseAssetId: 1, quoteAssetId: 2 }),
      makeMarket({ symbol: 'ETHUSDC', baseAssetId: 3, quoteAssetId: 2 }),
      makeMarket({ symbol: 'SOLUSDC', baseAssetId: 4, quoteAssetId: 2 }),
    ]);

    expect(registry.getSymbol(1)).toBe('BTC');
    expect(registry.getSymbol(2)).toBe('USDC');
    expect(registry.getSymbol(3)).toBe('ETH');
    expect(registry.getSymbol(4)).toBe('SOL');
  });

  it('returns ASSET-{id} for unknown asset IDs', () => {
    const registry = new AssetRegistry();
    registry.buildFromMarkets([]);
    expect(registry.getSymbol(999)).toBe('ASSET-999');
  });

  it('resolves icons for known assets', () => {
    const registry = new AssetRegistry();
    registry.buildFromMarkets([
      makeMarket({ symbol: 'BTCUSDC', baseAssetId: 1, quoteAssetId: 2 }),
    ]);

    const btc = registry.getById(1);
    expect(btc).toBeDefined();
    expect(btc!.icon).toBe('₿');

    const usdc = registry.getById(2);
    expect(usdc).toBeDefined();
    expect(usdc!.icon).toBe('💵');
  });

  it('supports symbol → assetId lookup', () => {
    const registry = new AssetRegistry();
    registry.buildFromMarkets([
      makeMarket({ symbol: 'ETHUSDC', baseAssetId: 10, quoteAssetId: 20 }),
    ]);

    const eth = registry.getBySymbol('ETH');
    expect(eth).toBeDefined();
    expect(eth!.assetId).toBe(10);

    // Case-insensitive
    const eth2 = registry.getBySymbol('eth');
    expect(eth2).toBeDefined();
    expect(eth2!.assetId).toBe(10);
  });

  it('does not overwrite existing entries for same assetId', () => {
    const registry = new AssetRegistry();
    registry.buildFromMarkets([
      makeMarket({ symbol: 'BTCUSDC', baseAssetId: 1, quoteAssetId: 2 }),
      makeMarket({ symbol: 'BTCUSDT', baseAssetId: 1, quoteAssetId: 5 }),
    ]);

    // BTC should still be assetId 1
    expect(registry.getSymbol(1)).toBe('BTC');
    // USDT should be assetId 5
    expect(registry.getSymbol(5)).toBe('USDT');
  });

  it('lists all registered assets', () => {
    const registry = new AssetRegistry();
    registry.buildFromMarkets([
      makeMarket({ symbol: 'BTCUSDC', baseAssetId: 1, quoteAssetId: 2 }),
      makeMarket({ symbol: 'ETHUSDC', baseAssetId: 3, quoteAssetId: 2 }),
    ]);

    const all = registry.allAssets();
    expect(all.length).toBe(3); // BTC, USDC, ETH
    const symbols = all.map(a => a.symbol).sort();
    expect(symbols).toEqual(['BTC', 'ETH', 'USDC']);
  });

  it('handles exotic market symbols without known quote', () => {
    const registry = new AssetRegistry();
    // A symbol that doesn't end with USDC or USDT — base = full symbol
    registry.buildFromMarkets([
      makeMarket({ symbol: 'SOLUSDC', baseAssetId: 4, quoteAssetId: 2 }),
    ]);
    expect(registry.getSymbol(4)).toBe('SOL');
  });
});
