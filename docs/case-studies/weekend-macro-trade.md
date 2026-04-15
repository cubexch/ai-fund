# Case Study: Weekend Macro Trade

**Persona**: Part-time crypto trader, full-time engineer. Checks markets on Sunday morning.

**Goal**: Form a macro thesis and enter a BTC position before Monday volatility.

---

## Setup (2 minutes)

```
/setup          → Connect Cube Exchange (paper mode)
/hire risk-manager
/hire arthur-hayes
/hire raoul-pal
```

## Step 1: Get the Macro View

> "Arthur, what's the current macro setup — DXY, yields, global liquidity?"

Arthur Hayes analyzes the environment. He flags that DXY is weakening, 10Y yields are falling, and global M2 is expanding — historically bullish for BTC. His conviction: **7/10 long**.

> "Raoul, where are we in the cycle? What does network value say?"

Raoul Pal runs his network-value models. Metcalfe's Law valuation puts fair value at $78k. Current price: $67k. His conviction: **8/10 long**.

Both agents agree on direction. This is the ideal scenario — convergent macro views.

## Step 2: Size the Position

> "Risk Manager, size a BTC long based on both views. I want conservative risk."

The Risk Manager uses Kelly criterion with a blended 7.5/10 conviction score:
- Portfolio: $50k (paper)
- Kelly recommends 6%, capped at 5% by safe profile
- Position: $2,500 in BTC (~0.037 BTC)
- Stop loss: $64,000 (5% below entry)

## Step 3: Plan Execution

> "Execute a TWAP buy over 30 minutes."

The execution is planned: 6 slices of ~0.006 BTC every 5 minutes. Estimated market impact: 2.1 bps — negligible for this size.

> "Confirm and execute."

Orders placed in paper mode. All 6 slices fill within the expected range.

## Step 4: Verify

```
/health-report
```

```
Portfolio Health:
  BTC-USDC: 0.037 BTC ($2,501) — paper mode
  Entry VWAP: $67,431
  Stop loss: $64,000 (-5.1%)
  Risk: 2.4% of portfolio ✓
  Daily P&L: +$12.30 (+0.49%)
```

## Outcome

The trader spent 10 minutes on Sunday. Two AI analysts converged on a thesis, the risk manager sized it conservatively, and execution was automated. Monday opens +3.2% — the position is up $80.

## What Made This Work

1. **Convergent views**: Two independent analysts agreed, increasing confidence
2. **Risk-first**: Position sized by Kelly criterion, not gut feeling
3. **TWAP execution**: No market impact on a weekend with thin books
4. **Paper mode**: Zero real money at risk while learning the workflow

## Commands Used

`/setup`, `/hire risk-manager`, `/hire arthur-hayes`, `/hire raoul-pal`, `/health-report`
