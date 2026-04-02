/**
 * AI Fund Demo — Simulated trading desk in under 60 seconds.
 * No API keys, no accounts, no external dependencies.
 *
 * Usage:
 *   npx ai-fund demo              # random seed
 *   npx ai-fund demo --seed 42    # reproducible results
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { writeArtifacts } from './artifacts.js';

// ── ANSI Colors ───────────────────────────────────────────

const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const CYAN = '\x1b[36m';
const YELLOW = '\x1b[33m';
const WHITE = '\x1b[37m';

function colored(value, positive) {
  return positive ? `${GREEN}${value}${RESET}` : `${RED}${value}${RESET}`;
}

// ── Seedable PRNG (mulberry32) ────────────────────────────

function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── Price Generation ──────────────────────────────────────

function generatePriceSeries(rng, basePrice, volatility, steps) {
  const prices = [basePrice];
  for (let i = 1; i < steps; i++) {
    const drift = (rng() - 0.498) * volatility * basePrice;
    const prev = prices[i - 1];
    const next = Math.max(prev * 0.9, Math.min(prev * 1.1, prev + drift));
    prices.push(next);
  }
  return prices;
}

// ── Trade Simulation ──────────────────────────────────────

const ASSETS = ['BTC', 'ETH', 'SOL'];
const AGENTS = [
  { name: 'Risk Manager', tag: 'risk' },
  { name: 'Market Maker', tag: 'mm' },
  { name: 'Arbitrageur', tag: 'arb' },
  { name: 'Momentum Trader', tag: 'momentum' },
  { name: 'Mean Reversion', tag: 'meanrev' },
  { name: 'Macro Analyst (Arthur Hayes)', tag: 'macro' },
];

const MACRO_QUOTES = [
  '"Liquidity expanding -- DXY down 0.3%. Risk-on regime. Bias long until reversal."',
  '"Fed pivot incoming. Real rates negative. This is the setup for a face-melting rally."',
  '"Global M2 turning up. Dollar weakening. Every dip is a gift -- stack aggressively."',
  '"Treasury yield curve uninverting. Last time this happened, BTC rallied 140% in 6 months."',
  '"Yen carry trade unwinding. Short-term pain, but this creates the buying opportunity of 2026."',
];

const RISK_QUOTES = [
  '"Cut size by 20%. Vol regime shifted. Drawdown cap is 1%."',
  '"Correlation spike across BTC/ETH/SOL. Reduce gross exposure to 60%."',
  '"VaR limit breached at 3pm. Halving new positions until reset."',
  '"Tail risk elevated. Put 15% in stables. Protect the drawdown budget."',
  '"Funding rates inverted -- squeeze risk is real. Trim longs by a third."',
];

const ARB_QUOTES = [
  '"Found 11bps cross-venue spread on ETH. Executable with SOR."',
  '"BTC basis at 8.2% annualized across perps vs spot. Harvesting."',
  '"SOL showing 7bps dislocation between venues. Arb executed in 340ms."',
  '"ETH/BTC ratio diverged 15bps from fair value. Mean reversion trade live."',
  '"Triangular arb: BTC->ETH->SOL->BTC netting 4bps after fees. Running it."',
];

function simulateTrades(rng, priceSeries, numTrades) {
  const trades = [];
  const assetKeys = Object.keys(priceSeries);
  const agentPool = AGENTS.filter(a => a.tag !== 'risk' && a.tag !== 'macro');

  for (let i = 0; i < numTrades; i++) {
    const asset = assetKeys[Math.floor(rng() * assetKeys.length)];
    const prices = priceSeries[asset];
    const agent = agentPool[Math.floor(rng() * agentPool.length)];
    const side = rng() > 0.5 ? 'BUY' : 'SELL';

    // Pick random entry and exit points in the price series
    const entryIdx = Math.floor(rng() * (prices.length - 10));
    const holdPeriod = Math.floor(rng() * 10) + 1;
    const exitIdx = entryIdx + holdPeriod;

    const entryPrice = prices[entryIdx];
    const exitPrice = prices[Math.min(exitIdx, prices.length - 1)];

    // Size varies by asset
    let size;
    if (asset === 'BTC') size = 0.01 + rng() * 0.09;
    else if (asset === 'ETH') size = 0.1 + rng() * 0.9;
    else size = 1 + rng() * 19;

    const pnlRaw =
      side === 'BUY'
        ? (exitPrice - entryPrice) * size
        : (entryPrice - exitPrice) * size;

    trades.push({
      asset,
      side,
      agent: agent.name,
      entryPrice,
      exitPrice,
      size,
      pnl: pnlRaw,
    });
  }

  return trades;
}

// ── Metrics ───────────────────────────────────────────────

function computeMetrics(trades, initialCapital) {
  const pnls = trades.map(t => t.pnl);
  const totalPnl = pnls.reduce((a, b) => a + b, 0);
  const pnlPct = totalPnl / initialCapital;

  // Equity curve for drawdown
  const equity = [initialCapital];
  for (const pnl of pnls) {
    equity.push(equity[equity.length - 1] + pnl);
  }

  let peak = equity[0];
  let maxDD = 0;
  for (const val of equity) {
    if (val > peak) peak = val;
    const dd = (peak - val) / peak;
    if (dd > maxDD) maxDD = dd;
  }

  // Sharpe (annualized from hourly returns)
  const returns = pnls.map(p => p / initialCapital);
  const avgReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance =
    returns.reduce((sum, r) => sum + (r - avgReturn) ** 2, 0) /
    (returns.length - 1 || 1);
  const stdDev = Math.sqrt(variance);
  const sharpe = stdDev === 0 ? 0 : (avgReturn / stdDev) * Math.sqrt(8760);

  const wins = pnls.filter(p => p > 0).length;
  const winRate = wins / pnls.length;

  return { totalPnl, pnlPct, maxDD, sharpe, winRate, tradeCount: trades.length };
}

// ── Output Formatting ─────────────────────────────────────

function formatPct(value) {
  const sign = value >= 0 ? '+' : '';
  return `${sign}${(value * 100).toFixed(2)}%`;
}

function formatSharpe(value) {
  return value.toFixed(2);
}

// ── Desk Review Artifact ──────────────────────────────────

function generateDeskReview(metrics, trades, quotes) {
  const lines = [];
  lines.push('=' .repeat(60));
  lines.push('AI FUND -- DESK REVIEW (24h Simulation)');
  lines.push('=' .repeat(60));
  lines.push('');
  lines.push('PORTFOLIO METRICS');
  lines.push('-'.repeat(40));
  lines.push(`  PnL:       ${formatPct(metrics.pnlPct)}`);
  lines.push(`  Max DD:    ${formatPct(-metrics.maxDD)}`);
  lines.push(`  Trades:    ${metrics.tradeCount}`);
  lines.push(`  Sharpe:    ${formatSharpe(metrics.sharpe)}`);
  lines.push(`  Win Rate:  ${(metrics.winRate * 100).toFixed(0)}%`);
  lines.push('');
  lines.push('ACTIVE AGENTS');
  lines.push('-'.repeat(40));
  for (const agent of AGENTS) {
    lines.push(`  [x] ${agent.name}`);
  }
  lines.push('');
  lines.push('TOP ARGUMENTS');
  lines.push('-'.repeat(40));
  lines.push(`  Macro:  ${quotes.macro}`);
  lines.push(`  Risk:   ${quotes.risk}`);
  lines.push(`  Arb:    ${quotes.arb}`);
  lines.push('');
  lines.push('TRADE SUMMARY BY ASSET');
  lines.push('-'.repeat(40));

  for (const asset of ASSETS) {
    const assetTrades = trades.filter(t => t.asset === asset);
    const assetPnl = assetTrades.reduce((a, t) => a + t.pnl, 0);
    const assetWins = assetTrades.filter(t => t.pnl > 0).length;
    lines.push(
      `  ${asset.padEnd(5)} | ${String(assetTrades.length).padStart(3)} trades | PnL: ${formatPct(assetPnl / 100000).padStart(8)} | Win: ${assetTrades.length > 0 ? ((assetWins / assetTrades.length) * 100).toFixed(0) : 0}%`
    );
  }

  lines.push('');
  lines.push('TRADE SUMMARY BY AGENT');
  lines.push('-'.repeat(40));

  for (const agent of AGENTS) {
    if (agent.tag === 'risk' || agent.tag === 'macro') continue;
    const agentTrades = trades.filter(t => t.agent === agent.name);
    const agentPnl = agentTrades.reduce((a, t) => a + t.pnl, 0);
    lines.push(
      `  ${agent.name.padEnd(22)} | ${String(agentTrades.length).padStart(3)} trades | PnL: ${formatPct(agentPnl / 100000).padStart(8)}`
    );
  }

  lines.push('');
  lines.push('-'.repeat(60));
  lines.push('Generated by: npx ai-fund demo');
  lines.push(`Date: ${new Date().toISOString().slice(0, 10)}`);
  lines.push('Mode: paper (simulated -- no real trades executed)');
  lines.push('');

  return lines.join('\n');
}

// ── Main ──────────────────────────────────────────────────

export function runDemo(args) {
  // Parse --seed flag
  let seed = null;
  const seedIdx = args.indexOf('--seed');
  if (seedIdx !== -1 && args[seedIdx + 1]) {
    seed = parseInt(args[seedIdx + 1], 10);
  }
  if (seed === null || isNaN(seed)) {
    seed = Date.now() & 0xffffffff;
  }

  const rng = mulberry32(seed);

  // Banner
  console.log('');
  console.log(`${BOLD}AI FUND — DEMO RUN (paper)${RESET}`);
  console.log(`${DIM}Universe: BTC, ETH, SOL${RESET}`);
  console.log(`${DIM}Venues: simulated (no API keys needed)${RESET}`);
  console.log('');

  // Desk
  console.log(`${BOLD}DESK (hired):${RESET}`);
  for (const agent of AGENTS) {
    console.log(`  ${GREEN}●${RESET} ${agent.name}`);
  }
  console.log('');

  console.log(`${DIM}Running 24h simulation...${RESET}`);
  console.log('');

  // Generate price series (288 5-minute candles = 24h)
  const steps = 288;
  const priceSeries = {
    BTC: generatePriceSeries(rng, 60000 + rng() * 10000, 0.002, steps),
    ETH: generatePriceSeries(rng, 3000 + rng() * 1000, 0.003, steps),
    SOL: generatePriceSeries(rng, 100 + rng() * 100, 0.005, steps),
  };

  // Simulate trades
  const numTrades = 30 + Math.floor(rng() * 21); // 30-50
  const trades = simulateTrades(rng, priceSeries, numTrades);
  const initialCapital = 100000;
  const metrics = computeMetrics(trades, initialCapital);

  // Pick quotes
  const quotes = {
    macro: MACRO_QUOTES[Math.floor(rng() * MACRO_QUOTES.length)],
    risk: RISK_QUOTES[Math.floor(rng() * RISK_QUOTES.length)],
    arb: ARB_QUOTES[Math.floor(rng() * ARB_QUOTES.length)],
  };

  // Results
  const pnlStr = formatPct(metrics.pnlPct);
  const ddStr = formatPct(-metrics.maxDD);
  const sharpeStr = formatSharpe(metrics.sharpe);
  const winStr = `${(metrics.winRate * 100).toFixed(0)}%`;

  console.log(`${BOLD}RESULTS (24h sim):${RESET}`);
  console.log(`  PnL:      ${colored(pnlStr, metrics.pnlPct >= 0)}`);
  console.log(`  Max DD:   ${RED}${ddStr}${RESET}`);
  console.log(`  Trades:   ${WHITE}${metrics.tradeCount}${RESET}`);
  console.log(`  Sharpe:   ${colored(sharpeStr, metrics.sharpe >= 1.0)}`);
  console.log(`  Win Rate: ${colored(winStr, metrics.winRate >= 0.5)}`);
  console.log('');

  console.log(`${BOLD}TOP ARGUMENTS:${RESET}`);
  console.log(`  ${CYAN}Macro:${RESET}  ${quotes.macro}`);
  console.log(`  ${YELLOW}Risk:${RESET}   ${quotes.risk}`);
  console.log(`  ${GREEN}Arb:${RESET}    ${quotes.arb}`);
  console.log('');

  // Write artifacts (text + SVGs)
  const outDir = join(resolve(import.meta.dirname, '..'), 'out');
  mkdirSync(outDir, { recursive: true });
  const reviewPath = join(outDir, 'desk_review.txt');
  const reviewContent = generateDeskReview(metrics, trades, quotes);
  writeFileSync(reviewPath, reviewContent, 'utf-8');

  // Build equity curve data for SVG (aggregate trades into hourly equity)
  const equityCurve = [];
  const startTime = 0;
  let equity = initialCapital;
  equityCurve.push({ time: startTime, equity });
  for (let i = 0; i < trades.length; i++) {
    equity += trades[i].pnl;
    equityCurve.push({ time: startTime + ((i + 1) / trades.length) * 24 * 3600000, equity });
  }

  const agentGrades = [
    { name: 'Risk Manager', primaryKpi: 'Breaches', actual: '0', grade: 'A', emoji: '' },
    { name: 'Market Maker', primaryKpi: 'Spread P&L', actual: formatPct(metrics.pnlPct * 0.3), grade: metrics.pnlPct > 0 ? 'B+' : 'C', emoji: '' },
    { name: 'Arbitrageur', primaryKpi: 'Net P&L', actual: formatPct(metrics.pnlPct * 0.4), grade: metrics.pnlPct > 0 ? 'B+' : 'B', emoji: '' },
    { name: 'Momentum Trader', primaryKpi: 'Win Rate', actual: winStr, grade: metrics.winRate >= 0.55 ? 'B' : 'D', emoji: '' },
    { name: 'Mean Reversion', primaryKpi: 'Sharpe', actual: sharpeStr, grade: metrics.sharpe >= 1.0 ? 'B' : 'C', emoji: '' },
    { name: 'Macro Analyst', primaryKpi: 'Call Accuracy', actual: '67%', grade: 'B', emoji: '' },
  ];

  const recommendation = metrics.winRate < 0.55
    ? `FIRE Momentum Trader — win rate ${winStr} below 55% target. Replace with Mean Reversion in range-bound market.`
    : '';

  writeArtifacts({
    prices: equityCurve,
    stats: { pnl: pnlStr, maxDd: ddStr, trades: metrics.tradeCount, sharpe: sharpeStr, winRate: winStr },
    title: 'AI FUND — 24h Demo (paper)',
    agents: agentGrades,
    recommendation,
  }).catch(() => {});

  console.log(`${BOLD}ARTIFACTS:${RESET}`);
  console.log(`  ${DIM}out/pnl.svg${RESET}`);
  console.log(`  ${DIM}out/desk_review.svg${RESET}`);
  console.log(`  ${DIM}out/desk_review.txt${RESET}`);
  console.log('');

  console.log(`${DIM}Run 'npx ai-fund demo --seed ${seed}' to reproduce these results.${RESET}`);
  console.log(`${DIM}Try the full desk: https://github.com/cubexch/ai-fund${RESET}`);
  console.log('');
}
