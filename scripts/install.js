#!/usr/bin/env node

/**
 * Install AI Fund skills into ~/.claude/skills/
 *
 * Usage:
 *   npx ai-fund install              # install all skills
 *   npx ai-fund install risk-manager  # install specific skill
 *   npx ai-fund list                  # list available skills
 *
 * Skills are installed as SKILL.md files that Claude Code reads and embodies.
 * Exchange connectors are configured via .mcp.json in the project root.
 */

import { existsSync, mkdirSync, cpSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { runDemo } from './demo.js';

const SKILLS_SRC = resolve(import.meta.dirname, '..', 'skills');
const CLAUDE_SKILLS_DIR = join(homedir(), '.claude', 'skills');

const DESKS = {
  'Trading Desk': ['scalper', 'momentum-trader', 'mean-reversion-trader', 'swing-trader', 'arbitrageur', 'grid-trader'],
  'Execution Desk': ['execution-trader', 'market-maker', 'dca-strategist'],
  'Research Desk': ['quant-analyst', 'orderflow-analyst', 'volatility-analyst', 'sentiment-analyst', 'onchain-analyst'],
  'Risk & Portfolio': ['risk-manager', 'portfolio-manager', 'performance-analyst'],
  'Specialists': ['funding-rate-farmer', 'liquidation-hunter', 'pairs-trader', 'breakout-specialist'],
  'Infrastructure': ['backtester'],
};

function getAvailableSkills() {
  if (!existsSync(SKILLS_SRC)) return [];
  return readdirSync(SKILLS_SRC, { withFileTypes: true })
    .filter(d => d.isDirectory() && d.name !== '_template')
    .filter(d => existsSync(join(SKILLS_SRC, d.name, 'SKILL.md')))
    .map(d => d.name);
}

function installSkill(name) {
  const src = join(SKILLS_SRC, name);
  const dest = join(CLAUDE_SKILLS_DIR, `hedge-${name}`);

  if (!existsSync(join(src, 'SKILL.md'))) {
    console.error(`  ✗ Skill "${name}" not found or has no SKILL.md`);
    return false;
  }

  try {
    mkdirSync(dest, { recursive: true });
    cpSync(src, dest, { recursive: true });
    console.log(`  ✓ Installed: ${name}`);
    return true;
  } catch (err) {
    console.error(`  ✗ Failed to install "${name}": ${err.message}`);
    return false;
  }
}

function listSkills() {
  const available = getAvailableSkills();
  console.log('\n🏢 AI Fund — Available Agents\n');
  console.log('  Trade on any exchange: Cube, OKX, Kraken, Binance, Coinbase, 100+ more\n');

  for (const [desk, roles] of Object.entries(DESKS)) {
    console.log(`  ${desk}`);
    for (const role of roles) {
      const status = available.includes(role) ? '✓' : '○';
      const skillPath = join(SKILLS_SRC, role, 'SKILL.md');
      let desc = '';
      if (existsSync(skillPath)) {
        const content = readFileSync(skillPath, 'utf-8');
        const match = content.match(/^description:\s*>?\s*\n?\s*(.+)/m);
        if (match) desc = ` — ${match[1].trim().slice(0, 60)}`;
      }
      console.log(`    ${status} ${role}${desc}`);
    }
    console.log('');
  }
}

function installAll() {
  const skills = getAvailableSkills();
  console.log(`\n🏢 Installing ${skills.length} AI Fund agents...\n`);

  mkdirSync(CLAUDE_SKILLS_DIR, { recursive: true });

  let installed = 0;
  for (const skill of skills) {
    if (installSkill(skill)) installed++;
  }

  console.log(`\n✓ Installed ${installed}/${skills.length} agents to ${CLAUDE_SKILLS_DIR}`);
  console.log('\nRestart Claude Code to load the new agents.');
  console.log('Use /setup to connect your exchanges.');
  console.log('Use /hire <role> to activate an agent.\n');
}

// ── CLI ────────────────────────────────────────────────────

const args = process.argv.slice(2);
const command = args[0];

switch (command) {
  case 'list':
    listSkills();
    break;
  case 'install': {
    const skillName = args[1];
    if (skillName) {
      mkdirSync(CLAUDE_SKILLS_DIR, { recursive: true });
      installSkill(skillName);
    } else {
      installAll();
    }
    break;
  }
  case 'demo':
    runDemo(args.slice(1));
    break;
  default:
    console.log(`
AI Fund — 22 AI trading agents for Claude Code
Trade on any exchange: Cube, OKX, Kraken, Binance, Coinbase, 100+ more

Usage:
  npx ai-fund install              Install all agents
  npx ai-fund install <role>       Install a specific agent
  npx ai-fund list                 List available agents
  npx ai-fund demo                 Run a simulated trading desk demo
  npx ai-fund demo --seed 42       Run demo with reproducible results

Example:
  npx ai-fund install risk-manager
  npx ai-fund install market-maker
  npx ai-fund demo
    `);
}
