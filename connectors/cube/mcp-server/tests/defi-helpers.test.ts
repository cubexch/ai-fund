import { describe, it, expect } from 'vitest';
import { isMintAddress, KNOWN_MINTS, formatToken, assetSymbolMatches, findMatchingTickerSymbol } from '../src/tools/defi';

// ── isMintAddress ────────────────────────────────────────────

describe('isMintAddress', () => {
  it('accepts valid Solana mint addresses', () => {
    expect(isMintAddress('So11111111111111111111111111111111111111112')).toBe(true);
    expect(isMintAddress('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')).toBe(true);
    expect(isMintAddress('Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB')).toBe(true);
  });

  it('rejects strings that are too short', () => {
    expect(isMintAddress('abc')).toBe(false);
    expect(isMintAddress('1234567890123456789012345678901')).toBe(false); // 31 chars
  });

  it('rejects strings that are too long', () => {
    expect(isMintAddress('a'.repeat(45))).toBe(false);
  });

  it('rejects strings with invalid base58 characters', () => {
    // 0, O, I, l are not valid in base58
    expect(isMintAddress('0' + 'a'.repeat(43))).toBe(false);
    expect(isMintAddress('O' + 'a'.repeat(43))).toBe(false);
    expect(isMintAddress('I' + 'a'.repeat(43))).toBe(false);
    expect(isMintAddress('l' + 'a'.repeat(43))).toBe(false);
  });

  it('rejects empty string', () => {
    expect(isMintAddress('')).toBe(false);
  });

  it('rejects regular token symbols', () => {
    expect(isMintAddress('SOL')).toBe(false);
    expect(isMintAddress('USDC')).toBe(false);
    expect(isMintAddress('BONK')).toBe(false);
  });
});

// ── KNOWN_MINTS ──────────────────────────────────────────────

describe('KNOWN_MINTS', () => {
  it('has SOL with correct mint address', () => {
    expect(KNOWN_MINTS.SOL).toBeDefined();
    expect(KNOWN_MINTS.SOL.mint).toBe('So11111111111111111111111111111111111111112');
    expect(KNOWN_MINTS.SOL.symbol).toBe('SOL');
    expect(KNOWN_MINTS.SOL.decimals).toBe(9);
  });

  it('has WSOL aliased to SOL mint', () => {
    expect(KNOWN_MINTS.WSOL.mint).toBe(KNOWN_MINTS.SOL.mint);
  });

  it('has USDC with correct mint and 6 decimals', () => {
    expect(KNOWN_MINTS.USDC).toBeDefined();
    expect(KNOWN_MINTS.USDC.mint).toBe('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
    expect(KNOWN_MINTS.USDC.decimals).toBe(6);
  });

  it('has USDT with correct mint and 6 decimals', () => {
    expect(KNOWN_MINTS.USDT).toBeDefined();
    expect(KNOWN_MINTS.USDT.mint).toBe('Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB');
    expect(KNOWN_MINTS.USDT.decimals).toBe(6);
  });

  it('all known mints pass isMintAddress validation', () => {
    for (const [, entry] of Object.entries(KNOWN_MINTS)) {
      expect(isMintAddress(entry.mint)).toBe(true);
    }
  });
});

// ── formatToken ──────────────────────────────────────────────

describe('formatToken', () => {
  it('formats a token with full metadata', () => {
    const result = formatToken({
      symbol: 'BONK',
      decimals: 5,
      metadata: {
        currencyName: 'Bonk',
        mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
        snapshotPrice: 0.00001234,
        liquidity: 500_000_000,
      },
    } as any);
    expect(result).toContain('BONK');
    expect(result).toContain('(Bonk)');
    expect(result).toContain('mint:DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263');
    expect(result).toContain('$0.00001234');
    expect(result).toContain('mcap:$500.0M');
  });

  it('formats a token with minimal metadata', () => {
    const result = formatToken({
      symbol: 'UNKNOWN',
      decimals: 9,
      metadata: {},
    } as any);
    expect(result).toBe('UNKNOWN');
  });

  it('skips currency name when it matches symbol', () => {
    const result = formatToken({
      symbol: 'SOL',
      decimals: 9,
      metadata: { currencyName: 'SOL' },
    } as any);
    expect(result).not.toContain('(SOL)');
  });

  it('includes currency name when different from symbol', () => {
    const result = formatToken({
      symbol: 'JUP',
      decimals: 6,
      metadata: { currencyName: 'Jupiter' },
    } as any);
    expect(result).toContain('(Jupiter)');
  });
});

describe('assetSymbolMatches', () => {
  it('matches exact symbols case-insensitively', () => {
    expect(assetSymbolMatches('sol', 'SOL')).toBe(true);
  });

  it('matches Cube prefixed orderbook symbols against plain inputs', () => {
    expect(assetSymbolMatches('SOL', 'tSOL')).toBe(true);
    expect(assetSymbolMatches('USDC', 'tUSDC')).toBe(true);
    expect(assetSymbolMatches('gETH', 'ETH')).toBe(true);
  });

  it('does not match unrelated assets', () => {
    expect(assetSymbolMatches('SOL', 'tBTC')).toBe(false);
    expect(assetSymbolMatches('USDC', 'tPYUSD')).toBe(false);
  });
});

describe('findMatchingTickerSymbol', () => {
  const tickers = [
    { symbol: 'tSOLtUSDC', baseAsset: 'tSOL', quoteAsset: 'tUSDC' },
    { symbol: 'tBTCtUSDC', baseAsset: 'tBTC', quoteAsset: 'tUSDC' },
  ];

  it('finds an exact symbol match first', () => {
    expect(findMatchingTickerSymbol(tickers as any, 'tBTC', 'tUSDC')).toBe('tBTCtUSDC');
  });

  it('finds a prefixed market for plain token inputs', () => {
    expect(findMatchingTickerSymbol(tickers as any, 'SOL', 'USDC')).toBe('tSOLtUSDC');
  });

  it('returns null when no market matches', () => {
    expect(findMatchingTickerSymbol(tickers as any, 'BONK', 'USDC')).toBeNull();
  });
});
