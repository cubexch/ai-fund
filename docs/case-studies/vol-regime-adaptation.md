# Case Study: Volatility Regime Adaptation

**Persona**: Market maker running a quoting strategy who needs to adapt to changing volatility.

**Goal**: Detect a regime shift from low-vol to high-vol and automatically widen spreads.

---

## Setup (3 minutes)

```
/setup          → Connect Cube Exchange (paper mode)
/hire risk-manager
/hire market-maker
/hire volatility-analyst
```

## Step 1: Classify the Current Regime

> "Vol Analyst, what's the current volatility regime for BTC?"

The volatility analyst runs regime detection on the last 30 days of BTC data:

```
Volatility Regime Analysis — BTC-USDC

  Current regime: LOW VOLATILITY
  Realized vol (30d): 28% annualized
  Vol percentile: 18th (historically quiet)
  Regime duration: 12 days
  Term structure: flat (no event premium)

  Regime history (last 90 days):
    Day 1-45:  HIGH VOL  (52% ann.)
    Day 46-78: TRENDING  (35% ann.)
    Day 79-90: LOW VOL   (28% ann.)

  Signal: vol compression often precedes expansion.
  Watch for: breakout above 35% realized → regime shift.
```

## Step 2: Set Initial Spreads

> "Market Maker, propose spreads for BTC in this low-vol regime."

```
Proposed Quoting Parameters:

  Bid-ask spread: 3 bps (tight — low vol environment)
  Quote size: 0.01 BTC per side
  Max inventory: 0.05 BTC (5x quote size)
  Refresh rate: every 5 seconds
  Skew: neutral (no directional bias)

  Expected capture: ~1.5 bps per round-trip after fees
  Daily volume target: 50 round-trips → ~$50/day on $67k BTC
```

> "Risk Manager, approve these parameters."

Risk Manager checks inventory limits against portfolio — approved with a 0.05 BTC max.

## Step 3: Regime Shift Detected

Two hours later, the volatility analyst alerts:

```
⚠ REGIME CHANGE DETECTED — BTC-USDC

  Previous: LOW VOL (28% ann.)
  Current:  HIGH VOL (48% ann.)
  Trigger: 15-min realized vol spiked to 65% ann.
  Cause: large liquidation cascade on perps

  Recommendation: WIDEN SPREADS immediately.
  Adverse selection risk is elevated.
```

## Step 4: Adapt the Strategy

> "Market Maker, adapt to the new regime."

```
Updated Quoting Parameters:

  Bid-ask spread: 12 bps (4x wider — high vol protection)
  Quote size: 0.005 BTC (halved)
  Max inventory: 0.02 BTC (reduced)
  Refresh rate: every 2 seconds (faster requoting)
  Skew: -2 bps toward sell (reduce long inventory risk)

  Expected capture: ~6 bps per round-trip
  Volume will drop but each fill is more profitable.
```

Risk Manager re-approves with tighter inventory limits.

## Step 5: Review After the Session

```
/review
```

```
Market Maker Performance:

  Session duration: 4 hours
  Phase 1 (low vol, 2h):
    Round-trips: 23
    Avg capture: 1.4 bps
    P&L: +$22.10
    Max inventory: 0.03 BTC

  Phase 2 (high vol, 2h):
    Round-trips: 8
    Avg capture: 5.8 bps
    P&L: +$31.20
    Max inventory: 0.015 BTC

  Total P&L: +$53.30
  Adverse selection events: 2 (both recovered within 30s)
  Inventory violations: 0

  Grade: B+ (adapted well to regime change, slight delay in widening)
```

## What Made This Work

1. **Regime awareness**: The volatility analyst detected the shift in real-time
2. **Adaptive parameters**: Spreads widened 4x, size halved — classic market-maker defense
3. **Risk escalation**: Inventory limits tightened during volatile periods
4. **Higher capture in vol**: Wider spreads meant each fill was more profitable, offsetting lower volume

## Key Insight

Market making is not "set and forget." The edge comes from adapting to the current regime:
- **Low vol**: tight spreads, high volume, thin margins
- **High vol**: wide spreads, low volume, fat margins
- **Trending**: skew quotes in the trend direction to avoid adverse selection

The volatility analyst provides the regime classification; the market maker translates it into quoting parameters.

## Commands Used

`/setup`, `/hire risk-manager`, `/hire market-maker`, `/hire volatility-analyst`, `/review`
