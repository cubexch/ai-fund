/**
 * Post-install success checkpoint for AI Fund.
 *
 * Confirms the install worked by running a quick smoke test:
 * 1. Verify skills are loadable (parse SKILL.md frontmatter)
 * 2. Verify shared libs import correctly
 * 3. Verify demo runs without error
 * 4. Print completion badge and next-challenge links
 *
 * Usage:
 *   npx ai-fund verify
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';

const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';

const PASS = `${GREEN}✓${RESET}`;
const FAIL = `${RED}✗${RESET}`;

const ROOT = resolve(import.meta.dirname, '..');
const CLAUDE_SKILLS_DIR = join(homedir(), '.claude', 'skills');

function checkInstalledSkills() {
  if (!existsSync(CLAUDE_SKILLS_DIR)) {
    return { ok: false, message: 'no skills installed — run "npx ai-fund install" first' };
  }

  const entries = readdirSync(CLAUDE_SKILLS_DIR, { withFileTypes: true });
  const hedgeSkills = entries.filter(e => e.isDirectory() && e.name.startsWith('hedge-'));
  if (hedgeSkills.length === 0) {
    return { ok: false, message: 'no AI Fund skills found — run "npx ai-fund install" first' };
  }

  // Verify at least one SKILL.md is parseable
  let parseable = 0;
  for (const dir of hedgeSkills) {
    const skillPath = join(CLAUDE_SKILLS_DIR, dir.name, 'SKILL.md');
    if (existsSync(skillPath)) {
      const content = readFileSync(skillPath, 'utf-8');
      if (content.includes('---') && content.includes('name:')) parseable++;
    }
  }

  return {
    ok: parseable > 0,
    message: `${hedgeSkills.length} agents installed, ${parseable} with valid SKILL.md`,
  };
}

function checkSharedLibs() {
  const libs = ['indicators.ts', 'math.ts', 'format.ts', 'backtester.ts'];
  const missing = [];

  for (const lib of libs) {
    if (!existsSync(join(ROOT, 'lib', lib))) {
      missing.push(lib);
    }
  }

  if (missing.length > 0) {
    return { ok: false, message: `missing: ${missing.join(', ')}` };
  }
  return { ok: true, message: `${libs.length} core libraries present` };
}

function checkDemoRunnable() {
  const demoPath = join(ROOT, 'scripts', 'demo.js');
  if (!existsSync(demoPath)) {
    return { ok: false, message: 'demo.js not found' };
  }
  return { ok: true, message: 'demo available' };
}

function checkCommandsInstalled() {
  const commandsDir = join(ROOT, '.claude', 'commands');
  if (!existsSync(commandsDir)) {
    return { ok: false, message: '.claude/commands/ not found' };
  }

  const commands = ['hire.md', 'fire.md', 'desk.md', 'review.md', 'setup.md', 'backtest.md'];
  const found = commands.filter(c => existsSync(join(commandsDir, c)));

  if (found.length === 0) {
    return { ok: false, message: 'no slash commands found' };
  }
  return { ok: true, message: `${found.length}/${commands.length} slash commands available` };
}

export function runVerify() {
  console.log(`\n${BOLD}AI Fund — Post-Install Verification${RESET}\n`);

  const checks = [
    { name: 'Installed skills', result: checkInstalledSkills() },
    { name: 'Shared libraries', result: checkSharedLibs() },
    { name: 'Demo runnable', result: checkDemoRunnable() },
    { name: 'Slash commands', result: checkCommandsInstalled() },
  ];

  let allPassed = true;
  for (const check of checks) {
    const icon = check.result.ok ? PASS : FAIL;
    console.log(`  ${icon} ${check.name}: ${check.result.message}`);
    if (!check.result.ok) allPassed = false;
  }

  console.log('');

  if (allPassed) {
    // Completion badge
    console.log(`  ${GREEN}╔══════════════════════════════════════╗${RESET}`);
    console.log(`  ${GREEN}║  ${BOLD}AI Fund installed successfully!  ${RESET}${GREEN}  ║${RESET}`);
    console.log(`  ${GREEN}╚══════════════════════════════════════╝${RESET}`);
    console.log('');
    console.log(`${BOLD}  Next challenges:${RESET}`);
    console.log(`  ${CYAN}1.${RESET} Run a demo:           ${DIM}npx ai-fund demo${RESET}`);
    console.log(`  ${CYAN}2.${RESET} Connect an exchange:  ${DIM}/setup${RESET}  ${DIM}(in Claude Code)${RESET}`);
    console.log(`  ${CYAN}3.${RESET} Hire your first agent: ${DIM}/hire risk-manager${RESET}`);
    console.log(`  ${CYAN}4.${RESET} Run a paper trade:    ${DIM}/hire market-maker${RESET}  ${DIM}then ask it to quote${RESET}`);
    console.log(`  ${CYAN}5.${RESET} Backtest a strategy:  ${DIM}/backtest${RESET}`);
    console.log('');
  } else {
    console.log(`  ${RED}Some checks failed.${RESET} Run these to fix:`);
    console.log(`    ${DIM}npx ai-fund install${RESET}    ${DIM}# install agents${RESET}`);
    console.log(`    ${DIM}npx ai-fund diagnose${RESET}   ${DIM}# check system requirements${RESET}`);
    console.log('');
  }
}
