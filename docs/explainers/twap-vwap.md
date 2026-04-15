# TWAP & VWAP Execution

**What they are:** Algorithms that split a large order into smaller slices to minimize market impact.

---

## TWAP (Time-Weighted Average Price)

Splits your order into equal-sized slices executed at regular intervals.

```
You want to buy 10 BTC over 1 hour.
TWAP splits it into 12 slices of ~0.83 BTC every 5 minutes.

Time:   |-----|-----|-----|-----|-----|-----| ...
Slice:  0.83  0.83  0.83  0.83  0.83  0.83
```

**When to use:** You believe price will move randomly (no strong trend). You want simple, predictable execution.

**Trade-off:** If the price trends up, TWAP keeps buying at higher prices instead of front-loading.

## VWAP (Volume-Weighted Average Price)

Splits your order proportionally to expected volume. More shares during high-volume periods, fewer during low-volume.

```
Hour 1 (low volume):    buy 0.5 BTC
Hour 2 (high volume):   buy 3.0 BTC   ← more when liquidity is deeper
Hour 3 (medium volume): buy 1.5 BTC
```

**When to use:** You want to match the market's natural rhythm. You're benchmarked against VWAP (institutional standard).

**Trade-off:** Requires a volume profile estimate. If the profile is wrong, execution quality suffers.

## Key Differences

| Aspect | TWAP | VWAP |
|--------|------|------|
| Slice sizing | Equal | Proportional to volume |
| Complexity | Simple | Needs volume profile |
| Best for | Quiet markets | Active markets |
| Benchmark | Time | Volume |

## Try It

In Claude Code with CCXT connector:

```
# Plan a TWAP execution
Use the plan_twap tool: symbol BTC/USDT, side buy, total quantity 1.0, duration 3600 seconds, slices 12

# Plan a VWAP execution
Use the plan_vwap tool: symbol BTC/USDT, side buy, total quantity 1.0, duration 3600 seconds

# Compare them
Use the compare_execution_plans tool: symbol BTC/USDT, side buy, quantity 1.0, duration 3600
```

## Further Reading

- `lib/execution-planner.ts` — Implementation of `planTwap`, `planVwap`, `compareExecutionPlans`
- `lib/execution-analytics.ts` — Post-execution quality analysis
