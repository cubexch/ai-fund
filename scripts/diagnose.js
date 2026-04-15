/**
 * Install-time diagnostics for AI Fund.
 *
 * Validates Node/tooling versions, connector prerequisites,
 * and common configuration issues. Returns human-readable
 * messages with copy-paste fix commands.
 *
 * Usage:
 *   npx ai-fund diagnose
 *   import { runDiagnostics } from './diagnose.js'
 */

import { existsSync, accessSync, constants, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';

const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';

const PASS = `${GREEN}✓${RESET}`;
const FAIL = `${RED}✗${RESET}`;
const WARN = `${YELLOW}!${RESET}`;

const ROOT = resolve(import.meta.dirname, '..');

/**
 * @typedef {{ name: string, status: 'pass' | 'fail' | 'warn', message: string, fix?: string }} Check
 */

/** Check Node.js version >= 20 */
function checkNodeVersion() {
  const major = parseInt(process.versions.node.split('.')[0], 10);
  if (major >= 20) {
    return { name: 'Node.js version', status: 'pass', message: `v${process.versions.node}` };
  }
  return {
    name: 'Node.js version',
    status: 'fail',
    message: `v${process.versions.node} (requires >= 20)`,
    fix: 'Install Node 20+: https://nodejs.org or use nvm:\n    nvm install 20 && nvm use 20',
  };
}

/** Check npm is available */
function checkNpm() {
  try {
    const version = execSync('npm --version', { encoding: 'utf-8' }).trim();
    return { name: 'npm', status: 'pass', message: `v${version}` };
  } catch {
    return {
      name: 'npm',
      status: 'fail',
      message: 'not found',
      fix: 'npm ships with Node.js. Reinstall Node from https://nodejs.org',
    };
  }
}

/** Check ~/.claude/ directory exists and is writable */
function checkClaudeDir() {
  const claudeDir = join(homedir(), '.claude');
  if (!existsSync(claudeDir)) {
    return {
      name: '~/.claude/ directory',
      status: 'warn',
      message: 'does not exist (will be created on install)',
    };
  }
  try {
    accessSync(claudeDir, constants.W_OK);
    return { name: '~/.claude/ directory', status: 'pass', message: 'exists and writable' };
  } catch {
    return {
      name: '~/.claude/ directory',
      status: 'fail',
      message: 'exists but not writable',
      fix: `Fix permissions:\n    chmod u+w ${claudeDir}`,
    };
  }
}

/** Check if skills directory has SKILL.md files */
function checkSkills() {
  const skillsDir = join(ROOT, 'skills');
  if (!existsSync(skillsDir)) {
    return {
      name: 'Skills directory',
      status: 'fail',
      message: 'skills/ not found — are you in the ai-fund repo?',
      fix: 'Clone the repo:\n    git clone https://github.com/cubexch/ai-fund && cd ai-fund',
    };
  }

  let count = 0;
  try {
    const entries = readdirSync(skillsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name !== '_template') {
        if (existsSync(join(skillsDir, entry.name, 'SKILL.md'))) count++;
      }
    }
  } catch {
    // ignore
  }

  if (count === 0) {
    return {
      name: 'Skills directory',
      status: 'fail',
      message: 'no SKILL.md files found',
    };
  }
  return { name: 'Skills directory', status: 'pass', message: `${count} agents available` };
}

/** Check if node_modules exist (dependencies installed) */
function checkDependencies() {
  const nodeModules = join(ROOT, 'node_modules');
  if (!existsSync(nodeModules)) {
    return {
      name: 'Dependencies',
      status: 'fail',
      message: 'node_modules/ not found',
      fix: 'Install dependencies:\n    npm ci',
    };
  }
  return { name: 'Dependencies', status: 'pass', message: 'installed' };
}

/** Check connector build artifacts exist */
function checkConnectorBuilds() {
  const connectors = [
    { name: 'Cube', path: 'connectors/cube/mcp-server/dist' },
    { name: 'CCXT', path: 'connectors/ccxt/mcp-server/dist' },
    { name: 'Alpaca', path: 'connectors/alpaca/mcp-server/dist' },
  ];

  const results = [];
  const unbuilt = [];

  for (const c of connectors) {
    const distPath = join(ROOT, c.path);
    if (existsSync(distPath)) {
      results.push(c.name);
    } else {
      unbuilt.push(c.name);
    }
  }

  if (unbuilt.length === 0) {
    return { name: 'Connector builds', status: 'pass', message: `${results.join(', ')} built` };
  }

  if (results.length === 0) {
    return {
      name: 'Connector builds',
      status: 'warn',
      message: 'no connectors built yet',
      fix: 'Build all connectors:\n    npm run build',
    };
  }

  return {
    name: 'Connector builds',
    status: 'warn',
    message: `${results.join(', ')} built; ${unbuilt.join(', ')} not built`,
    fix: 'Build all connectors:\n    npm run build',
  };
}

/** Check for TypeScript compiler */
function checkTypeScript() {
  try {
    const tscPath = join(ROOT, 'node_modules', '.bin', 'tsc');
    if (existsSync(tscPath)) {
      const version = execSync(`${tscPath} --version`, { encoding: 'utf-8' }).trim();
      return { name: 'TypeScript', status: 'pass', message: version };
    }
  } catch {
    // fall through
  }

  return {
    name: 'TypeScript',
    status: 'warn',
    message: 'tsc not found in node_modules',
    fix: 'Install dependencies:\n    npm ci',
  };
}

/** Check for .mcp.json or project-level MCP config */
function checkMcpConfig() {
  const mcpPath = join(ROOT, '.mcp.json');
  const claudeJsonPath = join(ROOT, '.claude.json');

  if (existsSync(mcpPath)) {
    return { name: 'MCP config', status: 'pass', message: '.mcp.json found' };
  }
  if (existsSync(claudeJsonPath)) {
    return { name: 'MCP config', status: 'pass', message: '.claude.json found' };
  }

  return {
    name: 'MCP config',
    status: 'warn',
    message: 'no .mcp.json found — connectors won\'t load in Claude Code',
    fix: 'Run setup in Claude Code:\n    /setup',
  };
}

/**
 * Run all diagnostics and return results.
 * @returns {Check[]}
 */
export function runDiagnostics() {
  return [
    checkNodeVersion(),
    checkNpm(),
    checkClaudeDir(),
    checkSkills(),
    checkDependencies(),
    checkConnectorBuilds(),
    checkTypeScript(),
    checkMcpConfig(),
  ];
}

/**
 * Run diagnostics as a pre-install check.
 * Prints warnings/errors but does not block install.
 * Returns true if all critical checks pass.
 * @returns {boolean}
 */
export function preInstallCheck() {
  const results = runDiagnostics();
  const failures = results.filter(r => r.status === 'fail');

  if (failures.length === 0) return true;

  console.log(`\n${YELLOW}Pre-install diagnostics found issues:${RESET}\n`);
  for (const f of failures) {
    console.log(`  ${FAIL} ${f.name}: ${f.message}`);
    if (f.fix) {
      console.log(`    ${DIM}Fix: ${f.fix}${RESET}`);
    }
  }
  console.log('');

  // Node version is the only hard blocker
  const nodeCheck = results.find(r => r.name === 'Node.js version');
  return !nodeCheck || nodeCheck.status !== 'fail';
}

/**
 * Print full diagnostic report to stdout.
 */
export function printDiagnostics() {
  const results = runDiagnostics();

  console.log(`\n${BOLD}AI Fund — System Diagnostics${RESET}\n`);

  for (const r of results) {
    const icon = r.status === 'pass' ? PASS : r.status === 'warn' ? WARN : FAIL;
    console.log(`  ${icon} ${r.name}: ${r.message}`);
    if (r.fix) {
      console.log(`    ${DIM}Fix: ${r.fix}${RESET}`);
    }
  }

  const fails = results.filter(r => r.status === 'fail').length;
  const warns = results.filter(r => r.status === 'warn').length;
  const passes = results.filter(r => r.status === 'pass').length;

  console.log('');
  if (fails > 0) {
    console.log(`  ${RED}${fails} issue(s) must be fixed before using AI Fund.${RESET}`);
  } else if (warns > 0) {
    console.log(`  ${GREEN}${passes} checks passed${RESET}, ${YELLOW}${warns} warning(s)${RESET} — ready to install.`);
  } else {
    console.log(`  ${GREEN}All ${passes} checks passed${RESET} — ready to go!`);
  }
  console.log('');
}
