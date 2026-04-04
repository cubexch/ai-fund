# Case Study: Cross-Exchange Arbitrage

**Persona**: Quantitative trader running two exchange accounts, looking for structural mispricings.

**Goal**: Detect and capture a BTC price difference between Cube and Coinbase.

---

## Setup (3 minutes)

```
/setup          → Connect Cube (paper) + Coinbase via CCXT (sandbox)
/hire risk-manager
/hire arbitrageur
/hire execution-trader
```

## Step 1: Scan for Spreads

> "Scan all connected exchanges for BTC and ETH price differences."

The arbitrageur fetches quotes from both venues simultaneously:

```
Cross-Exchange Spreads:

  Pair       Cube         Coinbase     Spread     Net (after fees)
  BTC-USD    $67,430      $67,485      8.2 bps    3.2 bps ✓
  ETH-USD    $3,521       $3,524       0.9 bps    -4.1 bps ✗

BTC spread is actionable — 3.2 bps net after maker/taker fees on both venues.
ETH spread doesn't cover fees.
```

## Step 2: Risk Check

> "Risk Manager, can we do this trade?"

Risk Manager checks:
- Portfolio split: $25k on each exchange
- BTC position would be $5k per leg (10% of total)
- Within limits ✓
- Both exchanges in paper/sandbox mode ✓
- Sufficient balance on both venues ✓

## Step 3: Plan Two-Leg Execution

> "Execution Trader, plan the arb — buy on Cube, sell on Coinbase."

```
Arb Execution Plan:

  Leg 1 (buy):  Cube     — 0.074 BTC @ $67,430 (limit)
  Leg 2 (sell): Coinbase — 0.074 BTC @ $67,485 (limit)

  Expected profit: $4.07 (3.2 bps on $5,000)
  Execution risk: LOW — both limit orders, no market impact
  Timing: simultaneous submission

  ⚠ Fill risk: if one leg fills and the other doesn't, you hold directional risk.
  Mitigation: 30-second timeout, cancel unfilled leg.
```

## Step 4: Execute

> "Confirmed — execute both legs."

Both orders placed simultaneously. Leg 1 fills in 200ms, Leg 2 fills in 1.2s.

```
Arb Complete:
  Buy:  0.074 BTC @ $67,430.50 on Cube
  Sell: 0.074 BTC @ $67,484.20 on Coinbase
  Gross: $3.97
  Fees:  -$1.35 (Cube) -$1.69 (Coinbase)
  Net:   $0.93

  Small but positive — the spread was real.
```

## Step 5: Review

```
/health-report
```

The position is flat (no directional risk). Net P&L: +$0.93.

## What Made This Work

1. **Multi-venue scanning**: Arbitrageur checked both exchanges in parallel
2. **Fee-aware**: Spread was filtered for net profitability after fees
3. **Simultaneous execution**: Both legs submitted at once to minimize timing risk
4. **Risk guardrails**: Fill timeout and position limits prevented runaway exposure
5. **Paper mode**: Both exchanges in sandbox — zero real capital at risk

## When It Doesn't Work

- **Spread too small**: Most of the time, efficient markets eliminate the spread before fees
- **Latency**: Real arb requires sub-second execution; AI agents add latency
- **One-sided fill**: If only one leg fills, you're holding directional risk

The arbitrageur will flag all of these conditions before recommending execution.

## Commands Used

`/setup`, `/hire risk-manager`, `/hire arbitrageur`, `/hire execution-trader`, `/health-report`
