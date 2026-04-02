/**
 * Shareable artifact generator — produces SVG charts and scorecards
 * after a demo run. Zero external dependencies; uses only node:fs and node:path.
 *
 * Usage:
 *   import { generatePnlSvg, generateDeskReviewSvg, writeArtifacts } from './artifacts.js';
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';

// ─── Helpers ────────────────────────────────────────────────────────────────

function escapeXml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

// ─── PnL Chart ──────────────────────────────────────────────────────────────

/**
 * Generate an SVG equity curve chart.
 *
 * @param {Object} opts
 * @param {{ time: number, equity: number }[]} opts.prices
 * @param {{ pnl: string, maxDd: string, trades: number, sharpe: string, winRate: string }} opts.stats
 * @param {string} opts.title
 * @returns {string} SVG markup
 */
export function generatePnlSvg({ prices, stats, title }) {
  const W = 800;
  const H = 400;

  // Chart area (padding for axes and labels)
  const PAD = { top: 50, right: 200, bottom: 50, left: 80 };
  const chartW = W - PAD.left - PAD.right;
  const chartH = H - PAD.top - PAD.bottom;

  // Compute data bounds
  const startEquity = prices[0]?.equity ?? 10000;
  const equities = prices.map((p) => p.equity);
  const times = prices.map((p) => p.time);
  const minTime = Math.min(...times);
  const maxTime = Math.max(...times);
  const minEq = Math.min(...equities);
  const maxEq = Math.max(...equities);

  // Add 5% padding to equity range
  const eqRange = maxEq - minEq || 1;
  const yMin = minEq - eqRange * 0.05;
  const yMax = maxEq + eqRange * 0.05;

  // Map data to chart coordinates
  function toX(time) {
    const t = maxTime === minTime ? 0.5 : (time - minTime) / (maxTime - minTime);
    return PAD.left + t * chartW;
  }

  function toY(equity) {
    const t = (equity - yMin) / (yMax - yMin);
    return PAD.top + chartH - t * chartH;
  }

  // Build polyline path — split into green/red segments
  const segments = [];
  for (let i = 0; i < prices.length - 1; i++) {
    const p0 = prices[i];
    const p1 = prices[i + 1];
    const x0 = toX(p0.time);
    const y0 = toY(p0.equity);
    const x1 = toX(p1.time);
    const y1 = toY(p1.equity);

    // Check if segment crosses the start equity line
    const above0 = p0.equity >= startEquity;
    const above1 = p1.equity >= startEquity;

    if (above0 === above1) {
      segments.push({ x0, y0, x1, y1, color: above0 ? '#00ff88' : '#ff4444' });
    } else {
      // Split at crossing
      const t = (startEquity - p0.equity) / (p1.equity - p0.equity);
      const mx = lerp(x0, x1, t);
      const my = toY(startEquity);
      segments.push({ x0, y0, x1: mx, y1: my, color: above0 ? '#00ff88' : '#ff4444' });
      segments.push({ x0: mx, y0: my, x1, y1, color: above1 ? '#00ff88' : '#ff4444' });
    }
  }

  // Build segment lines
  const segmentLines = segments
    .map(
      (s) =>
        `<line x1="${s.x0.toFixed(1)}" y1="${s.y0.toFixed(1)}" x2="${s.x1.toFixed(1)}" y2="${s.y1.toFixed(1)}" stroke="${s.color}" stroke-width="2" stroke-linecap="round"/>`
    )
    .join('\n    ');

  // Area fill under curve (gradient from line to transparent)
  const polyPoints = prices.map((p) => `${toX(p.time).toFixed(1)},${toY(p.equity).toFixed(1)}`).join(' ');
  const lastPrice = prices[prices.length - 1];
  const areaColor = lastPrice.equity >= startEquity ? '#00ff88' : '#ff4444';

  // Grid lines (horizontal)
  const hGridCount = 5;
  const hGridLines = [];
  for (let i = 0; i <= hGridCount; i++) {
    const eq = yMin + (i / hGridCount) * (yMax - yMin);
    const y = toY(eq);
    hGridLines.push(
      `<line x1="${PAD.left}" y1="${y.toFixed(1)}" x2="${PAD.left + chartW}" y2="${y.toFixed(1)}" stroke="#333" stroke-width="0.5"/>`
    );
    hGridLines.push(
      `<text x="${PAD.left - 8}" y="${(y + 4).toFixed(1)}" text-anchor="end" fill="#666" font-family="'Courier New', monospace" font-size="10">${eq.toFixed(0)}</text>`
    );
  }

  // Grid lines (vertical) — hours
  const totalHours = Math.max(1, (maxTime - minTime) / 3600000);
  const hourStep = totalHours <= 6 ? 1 : totalHours <= 12 ? 2 : totalHours <= 48 ? 4 : 8;
  const vGridLines = [];
  for (let h = 0; h <= totalHours; h += hourStep) {
    const t = minTime + h * 3600000;
    const x = toX(t);
    if (x >= PAD.left && x <= PAD.left + chartW) {
      vGridLines.push(
        `<line x1="${x.toFixed(1)}" y1="${PAD.top}" x2="${x.toFixed(1)}" y2="${PAD.top + chartH}" stroke="#333" stroke-width="0.5"/>`
      );
      vGridLines.push(
        `<text x="${x.toFixed(1)}" y="${PAD.top + chartH + 18}" text-anchor="middle" fill="#666" font-family="'Courier New', monospace" font-size="10">${h}h</text>`
      );
    }
  }

  // Start equity reference line
  const startY = toY(startEquity);

  // Stats box
  const statsEntries = [
    `PnL: ${stats.pnl}`,
    `Max DD: ${stats.maxDd}`,
    `Trades: ${stats.trades}`,
    `Sharpe: ${stats.sharpe}`,
    `Win Rate: ${stats.winRate}`,
  ];
  const statsX = W - PAD.right + 20;
  const statsY = PAD.top + 10;
  const statsLines = statsEntries
    .map(
      (line, i) =>
        `<text x="${statsX}" y="${statsY + 24 + i * 22}" fill="#e0e0e0" font-family="'Courier New', monospace" font-size="13" font-weight="bold">${escapeXml(line)}</text>`
    )
    .join('\n    ');

  // Final equity dot
  const finalX = toX(lastPrice.time);
  const finalY = toY(lastPrice.equity);
  const dotColor = lastPrice.equity >= startEquity ? '#00ff88' : '#ff4444';

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
  <defs>
    <linearGradient id="areaGrad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${areaColor}" stop-opacity="0.15"/>
      <stop offset="100%" stop-color="${areaColor}" stop-opacity="0"/>
    </linearGradient>
    <filter id="glow">
      <feGaussianBlur stdDeviation="2" result="blur"/>
      <feMerge>
        <feMergeNode in="blur"/>
        <feMergeNode in="SourceGraphic"/>
      </feMerge>
    </filter>
  </defs>

  <!-- Background -->
  <rect width="${W}" height="${H}" fill="#1a1a2e" rx="8"/>

  <!-- Border -->
  <rect x="1" y="1" width="${W - 2}" height="${H - 2}" fill="none" stroke="#333" stroke-width="1" rx="8"/>

  <!-- Grid -->
  ${hGridLines.join('\n  ')}
  ${vGridLines.join('\n  ')}

  <!-- Chart border -->
  <rect x="${PAD.left}" y="${PAD.top}" width="${chartW}" height="${chartH}" fill="none" stroke="#444" stroke-width="0.5"/>

  <!-- Start equity reference -->
  <line x1="${PAD.left}" y1="${startY.toFixed(1)}" x2="${PAD.left + chartW}" y2="${startY.toFixed(1)}" stroke="#555" stroke-width="0.5" stroke-dasharray="4,4"/>

  <!-- Area fill -->
  <polygon points="${toX(prices[0].time).toFixed(1)},${(PAD.top + chartH).toFixed(1)} ${polyPoints} ${toX(lastPrice.time).toFixed(1)},${(PAD.top + chartH).toFixed(1)}" fill="url(#areaGrad)"/>

  <!-- Equity curve -->
  <g filter="url(#glow)">
    ${segmentLines}
  </g>

  <!-- Final equity dot -->
  <circle cx="${finalX.toFixed(1)}" cy="${finalY.toFixed(1)}" r="4" fill="${dotColor}" stroke="#1a1a2e" stroke-width="2"/>

  <!-- Title -->
  <text x="20" y="30" fill="#e0e0e0" font-family="'Courier New', monospace" font-size="16" font-weight="bold">${escapeXml(title)}</text>

  <!-- Stats separator -->
  <line x1="${W - PAD.right + 10}" y1="${PAD.top}" x2="${W - PAD.right + 10}" y2="${PAD.top + chartH}" stroke="#333" stroke-width="1"/>

  <!-- Stats label -->
  <text x="${statsX}" y="${statsY}" fill="#888" font-family="'Courier New', monospace" font-size="10" letter-spacing="2">PERFORMANCE</text>

  <!-- Stats -->
  ${statsLines}

  <!-- Watermark -->
  <text x="${W - 20}" y="${H - 15}" text-anchor="end" fill="#333" font-family="'Courier New', monospace" font-size="12" font-weight="bold" letter-spacing="3">AI FUND</text>
</svg>`;
}

// ─── Desk Review Scorecard ──────────────────────────────────────────────────

/**
 * Generate an SVG desk review scorecard.
 *
 * @param {Object} opts
 * @param {{ name: string, primaryKpi: string, actual: string, grade: string, emoji: string }[]} opts.agents
 * @param {string} opts.recommendation
 * @returns {string} SVG markup
 */
export function generateDeskReviewSvg({ agents, recommendation }) {
  const W = 800;
  const ROW_H = 36;
  const HEADER_H = 80;
  const TABLE_TOP = HEADER_H + 10;
  const TABLE_HEADER_H = 32;
  const REC_H = 60;
  const TABLE_ROWS_H = agents.length * ROW_H;
  const H = Math.max(500, TABLE_TOP + TABLE_HEADER_H + TABLE_ROWS_H + REC_H + 50);

  // Column positions
  const COL = {
    agent: 40,
    kpi: 260,
    actual: 480,
    grade: 680,
  };

  function gradeColor(g) {
    const upper = g.toUpperCase();
    if (upper === 'A' || upper === 'B') return '#00ff88';
    if (upper === 'C') return '#ffaa00';
    return '#ff4444';
  }

  // Table header
  const headerY = TABLE_TOP + 22;
  const tableHeader = `
    <rect x="20" y="${TABLE_TOP}" width="${W - 40}" height="${TABLE_HEADER_H}" fill="#252545" rx="4"/>
    <text x="${COL.agent}" y="${headerY}" fill="#888" font-family="'Courier New', monospace" font-size="11" font-weight="bold" letter-spacing="1.5">AGENT</text>
    <text x="${COL.kpi}" y="${headerY}" fill="#888" font-family="'Courier New', monospace" font-size="11" font-weight="bold" letter-spacing="1.5">PRIMARY KPI</text>
    <text x="${COL.actual}" y="${headerY}" fill="#888" font-family="'Courier New', monospace" font-size="11" font-weight="bold" letter-spacing="1.5">ACTUAL</text>
    <text x="${COL.grade}" y="${headerY}" fill="#888" font-family="'Courier New', monospace" font-size="11" font-weight="bold" letter-spacing="1.5">GRADE</text>`;

  // Table rows
  const rows = agents
    .map((agent, i) => {
      const y = TABLE_TOP + TABLE_HEADER_H + i * ROW_H;
      const textY = y + 24;
      const bgColor = i % 2 === 0 ? '#1e1e38' : '#222244';
      const gc = gradeColor(agent.grade);
      const emojiStr = agent.emoji ? `${agent.emoji} ` : '';
      return `
    <rect x="20" y="${y}" width="${W - 40}" height="${ROW_H}" fill="${bgColor}"/>
    <text x="${COL.agent}" y="${textY}" fill="#e0e0e0" font-family="'Courier New', monospace" font-size="13">${escapeXml(emojiStr + agent.name)}</text>
    <text x="${COL.kpi}" y="${textY}" fill="#aaa" font-family="'Courier New', monospace" font-size="13">${escapeXml(agent.primaryKpi)}</text>
    <text x="${COL.actual}" y="${textY}" fill="#e0e0e0" font-family="'Courier New', monospace" font-size="13" font-weight="bold">${escapeXml(agent.actual)}</text>
    <text x="${COL.grade}" y="${textY}" fill="${gc}" font-family="'Courier New', monospace" font-size="15" font-weight="bold">${escapeXml(agent.grade)}</text>`;
    })
    .join('');

  // Recommendation box
  const recY = TABLE_TOP + TABLE_HEADER_H + TABLE_ROWS_H + 20;
  const recBox = recommendation
    ? `
    <rect x="20" y="${recY}" width="${W - 40}" height="44" fill="#2a1520" stroke="#ff4444" stroke-width="1" rx="4"/>
    <text x="36" y="${recY + 16}" fill="#ff4444" font-family="'Courier New', monospace" font-size="10" font-weight="bold" letter-spacing="1.5">RECOMMENDATION</text>
    <text x="36" y="${recY + 34}" fill="#ff8888" font-family="'Courier New', monospace" font-size="12">${escapeXml(recommendation)}</text>`
    : '';

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
  <!-- Background -->
  <rect width="${W}" height="${H}" fill="#1a1a2e" rx="8"/>
  <rect x="1" y="1" width="${W - 2}" height="${H - 2}" fill="none" stroke="#333" stroke-width="1" rx="8"/>

  <!-- Title -->
  <text x="40" y="38" fill="#e0e0e0" font-family="'Courier New', monospace" font-size="18" font-weight="bold" letter-spacing="2">DESK PERFORMANCE REVIEW</text>

  <!-- Subtitle line -->
  <line x1="40" y1="50" x2="${W - 40}" y2="50" stroke="#444" stroke-width="0.5"/>
  <text x="40" y="68" fill="#666" font-family="'Courier New', monospace" font-size="11">AI FUND Trading Desk  ·  ${new Date().toISOString().slice(0, 10)}</text>

  <!-- Table header -->
  ${tableHeader}

  <!-- Table rows -->
  ${rows}

  <!-- Recommendation -->
  ${recBox}

  <!-- Watermark -->
  <text x="${W - 20}" y="${H - 15}" text-anchor="end" fill="#333" font-family="'Courier New', monospace" font-size="12" font-weight="bold" letter-spacing="3">AI FUND</text>
</svg>`;
}

// ─── Plain Text Desk Review ─────────────────────────────────────────────────

function generateDeskReviewTxt({ agents, recommendation }) {
  const lines = [];
  lines.push('╔══════════════════════════════════════════════════════════════════════╗');
  lines.push('║                    DESK PERFORMANCE REVIEW                         ║');
  lines.push('╠══════════════════════════════════════════════════════════════════════╣');
  lines.push('');

  const nameW = 22;
  const kpiW = 20;
  const actualW = 14;
  const gradeW = 6;

  const header =
    '  ' +
    'Agent'.padEnd(nameW) +
    'Primary KPI'.padEnd(kpiW) +
    'Actual'.padEnd(actualW) +
    'Grade'.padEnd(gradeW);
  lines.push(header);
  lines.push('  ' + '─'.repeat(nameW + kpiW + actualW + gradeW));

  for (const agent of agents) {
    const emoji = agent.emoji ? `${agent.emoji} ` : '';
    const name = `${emoji}${agent.name}`.padEnd(nameW);
    const kpi = agent.primaryKpi.padEnd(kpiW);
    const actual = agent.actual.padEnd(actualW);
    const grade = agent.grade.padEnd(gradeW);
    lines.push(`  ${name}${kpi}${actual}${grade}`);
  }

  if (recommendation) {
    lines.push('');
    lines.push('  ⚠ RECOMMENDATION:');
    lines.push(`    ${recommendation}`);
  }

  lines.push('');
  lines.push('╚══════════════════════════════════════════════════════════════════════╝');
  lines.push('                                                         AI FUND');
  return lines.join('\n');
}

// ─── Write Artifacts ────────────────────────────────────────────────────────

/**
 * Write all artifact files to the out/ directory.
 *
 * @param {Object} demoResults
 * @param {{ time: number, equity: number }[]} demoResults.prices
 * @param {{ pnl: string, maxDd: string, trades: number, sharpe: string, winRate: string }} demoResults.stats
 * @param {string} demoResults.title
 * @param {{ name: string, primaryKpi: string, actual: string, grade: string, emoji: string }[]} demoResults.agents
 * @param {string} demoResults.recommendation
 * @returns {Promise<string[]>} list of written file paths
 */
export async function writeArtifacts(demoResults) {
  const outDir = join(dirname(new URL(import.meta.url).pathname), '..', 'out');
  await mkdir(outDir, { recursive: true });

  const files = [];

  // PnL chart
  if (demoResults.prices && demoResults.stats) {
    const pnlSvg = generatePnlSvg({
      prices: demoResults.prices,
      stats: demoResults.stats,
      title: demoResults.title || 'AI FUND — Demo (paper)',
    });
    const pnlPath = join(outDir, 'pnl.svg');
    await writeFile(pnlPath, pnlSvg, 'utf-8');
    files.push(pnlPath);
  }

  // Desk review
  if (demoResults.agents) {
    const reviewSvg = generateDeskReviewSvg({
      agents: demoResults.agents,
      recommendation: demoResults.recommendation || '',
    });
    const reviewPath = join(outDir, 'desk_review.svg');
    await writeFile(reviewPath, reviewSvg, 'utf-8');
    files.push(reviewPath);

    const reviewTxt = generateDeskReviewTxt({
      agents: demoResults.agents,
      recommendation: demoResults.recommendation || '',
    });
    const txtPath = join(outDir, 'desk_review.txt');
    await writeFile(txtPath, reviewTxt, 'utf-8');
    files.push(txtPath);
  }

  return files;
}
