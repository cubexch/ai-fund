# Risk Parity

**What it is:** A portfolio construction method where each asset contributes equally to total portfolio risk, rather than equal dollar amounts.

---

## The Problem with Equal Weighting

If you put 50% in BTC and 50% in a stablecoin yield strategy:

```
BTC:        50% of capital, 80% annual volatility  → contributes ~95% of risk
Yield:      50% of capital,  5% annual volatility  → contributes ~5% of risk
```

Your "diversified" portfolio is really just a BTC bet with extra steps.

## The Risk Parity Solution

Allocate so each asset contributes the same amount of risk:

```
BTC:         6% of capital, 80% volatility  → contributes 50% of risk
Yield:      94% of capital,  5% volatility  → contributes 50% of risk
```

Now both assets contribute equally to portfolio outcomes.

## How It Works

1. Estimate each asset's volatility (standard deviation of returns)
2. Allocate inversely proportional to volatility
3. Rebalance periodically as volatilities change

### Simple Formula

```
weight_i = (1 / volatility_i) / sum(1 / volatility_j for all j)
```

**Example with three assets:**

| Asset | Volatility | Inverse Vol | Weight |
|-------|-----------|-------------|--------|
| BTC | 60% | 1.67 | 17% |
| ETH | 75% | 1.33 | 14% |
| Bonds | 8% | 12.50 | 69% |

Low-volatility assets get more capital; high-volatility assets get less.

## When to Use

- You want genuine diversification, not just multiple positions
- You don't have strong views on which asset will outperform
- You want to reduce drawdowns while maintaining exposure

## When NOT to Use

- You have a strong directional conviction (just size the bet)
- Assets are highly correlated (risk parity won't help)
- Transaction costs are high relative to position sizes

## Try It

In Claude Code with CCXT connector:

```
# Calculate risk parity weights
Use the assess_portfolio_risk tool with your current positions

# Get optimal portfolio allocation
# The portfolio optimizer in lib/ supports multiple methods:
#   - riskParity: Equal risk contribution
#   - meanVariance: Maximize Sharpe ratio
#   - minimumVariance: Minimize total risk
```

## Related Methods

| Method | Objective | Best for |
|--------|-----------|----------|
| **Risk Parity** | Equal risk contribution | No strong views |
| **Mean-Variance** | Maximize Sharpe ratio | Strong return forecasts |
| **Minimum Variance** | Minimize total portfolio risk | Maximum safety |
| **Inverse Volatility** | Simple risk scaling | Quick approximation |

## Further Reading

- `lib/portfolio-optimizer.ts` — `riskParity`, `meanVariance`, `minimumVariance`, `inverseVolatility`
- `lib/portfolio-analytics.ts` — `assessPortfolioRisk`, `computePortfolioExposure`
- `lib/math.ts` — `annualizedVolatility`, `correlationMatrix`
