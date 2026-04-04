---
description: Guided walkthrough to your first paper trade in under 5 minutes
---

# /first-trade — Your First Paper Trade

Walk the user from zero to their first paper trade. This is the fastest path to value — under 5 minutes.

## Prerequisites Check

1. **Verify at least one exchange is connected**: Read `.mcp.json` to check for enabled exchanges. If none are configured, tell the user:
   > No exchange connected yet. Let's fix that — run `/setup` first (takes 2 minutes).
   Then stop.

2. **Verify paper mode**: Check that the connected exchange is in paper/staging/demo mode. If live mode is detected, warn clearly and ask to switch.

## Guided Flow

### Step 1: Pick a Market (30 seconds)

Use the connected exchange's market data tools (fetch via `ToolSearch` first) to show the user 3-5 top markets by volume:

```
Let's pick a market for your first trade. Here's what's active:

  Symbol        Price         24h Volume      24h Change
  BTC-USDC      $67,432       $142M           +2.1%
  ETH-USDC      $3,521        $89M            +1.4%
  SOL-USDC      $148.20       $34M            +3.7%

Which one? (BTC is the safest choice for a first trade)
```

### Step 2: Hire the Risk Manager (30 seconds)

Check if risk-manager is already hired by running `node bin/desk-state show`. If not:

```
Before we trade, let's get risk oversight. Hiring the Risk Manager...
```

Run `node bin/desk-state hire risk-manager` and briefly acknowledge the hire. Set conservative defaults:
- Max position: 2% of portfolio
- Paper mode required: yes

### Step 3: Check the Order Book (30 seconds)

Fetch the current quote/order book for the chosen market. Show:
- Best bid and ask
- Spread in basis points
- Recent price action (use `get_bars` or equivalent)

```
BTC-USDC Order Book:
  Best Bid: $67,430 (0.5 BTC)
  Best Ask: $67,435 (0.3 BTC)
  Spread: 0.7 bps — tight ✓

Last 5 candles (1h): 67200 → 67350 → 67400 → 67410 → 67432
Trend: slightly up
```

### Step 4: Size the Position (30 seconds)

Use the risk manager's sizing logic. For a first trade, suggest a small market order:

```
Risk Manager says:
  Portfolio value: ~$10,000 (paper)
  Max position (2%): $200
  Suggested: Buy 0.003 BTC (~$200) at market

This is a tiny position — perfect for learning the flow.
Ready to place this order? (yes/no)
```

### Step 5: Place the Order (30 seconds)

**Wait for explicit user confirmation before placing any order.**

Once confirmed, use the exchange's `place_order` tool:
- Side: buy
- Type: market
- Amount: the calculated size
- Paper mode: yes

Show the result:

```
✓ Order placed!
  Order ID: abc-123
  Status: filled
  Fill price: $67,433
  Amount: 0.003 BTC
  Cost: $202.30

🎉 Congratulations — you just executed your first paper trade!
```

### Step 6: Verify and Next Steps (30 seconds)

Check the position using `get_positions` and confirm it shows up:

```
Your Positions:
  BTC-USDC: 0.003 BTC ($202.30) — paper mode

What's next?
  • /hire execution-trader — Get a TWAP/VWAP execution specialist
  • /hire momentum-trader — Get an AI trader with market conviction
  • /desk — See your full trading desk status
  • /health-report — Check PnL and portfolio health
  • "Set a stop-loss at $66,000" — Protect your position
```

## Important Rules

- **ALWAYS paper mode.** If you detect live credentials, refuse and ask the user to switch.
- **ALWAYS get confirmation** before placing any order. Summarize the exact order first.
- **Keep it fast.** Don't over-explain. The goal is momentum — get them to their first trade, then they'll explore.
- **If anything fails** (exchange not responding, tools not found, auth missing), diagnose quickly and give the exact fix command. Don't let the user get stuck.
- **Use real data.** Fetch actual prices and books — don't use placeholder numbers.
