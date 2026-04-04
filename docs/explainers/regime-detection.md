# Regime Detection

**What it is:** Classifying the current market into one of several states (trending, range-bound, volatile) so you can pick the right strategy.

---

## Why It Matters

Different strategies work in different markets:

| Regime | Best strategies | Worst strategies |
|--------|----------------|-----------------|
| **Trending** | Momentum, breakout | Mean reversion |
| **Range-bound** | Mean reversion, grid | Momentum, breakout |
| **Volatile** | Volatility selling, reduce size | Trend following (whipsaws) |

Using a momentum strategy in a range-bound market loses money. Regime detection helps you avoid that mismatch.

## How It Works

The detector looks at three signals:

### 1. ADX (Average Directional Index)
Measures trend strength on a 0-100 scale.
- ADX > 25: trending
- ADX < 20: range-bound

### 2. Volatility Ratio
Current volatility vs. historical average.
- Ratio > 1.5: volatile regime
- Ratio < 0.8: quiet/compressed

### 3. Hurst Exponent
Measures whether price movements are trending (H > 0.5) or mean-reverting (H < 0.5).
- H > 0.55: trending
- H < 0.45: mean-reverting
- H ~ 0.5: random walk

## The Three Regimes

```
           Trending           Range-Bound          Volatile
           ╱╲                 ────────────         ╱╲╱╲╱╲
          ╱  ╲               ╱            ╲       ╱      ╲
         ╱    ╲             ╱              ╲     ╱        ╲
        ╱      ╲           ────────────────     ╱╲╱╲      ╲╱╲
       ╱        ╲          Price oscillates     Wild swings
      Clear direction      between bounds       both directions
```

## Try It

In Claude Code with CCXT connector:

```
# Detect current regime for BTC
Use the detect_market_regime tool: symbol BTC/USDT

# Scan multiple assets for regime changes
Use the scan_regime_changes tool: symbols ["BTC/USDT", "ETH/USDT", "SOL/USDT"]

# Match strategy to current regime
Use the match_strategy_to_regime tool: symbol BTC/USDT
```

## Further Reading

- `lib/regime-detector.ts` — `RegimeDetector` class implementation
- `lib/time-series.ts` — `hurstExponent`, `garch11`, `regimeChangeDetection`
- `lib/indicators.ts` — `adx`, `atr` for trend/volatility measurement
