/**
 * Runtime-agnostic execution layer for ai-fund.
 *
 * Works from any AI coding agent — Claude Code, OpenClaw, Codex, or plain shell.
 * Provides testable functions for desk operations without depending on
 * any specific runtime's command system (.claude/commands/, etc.).
 *
 * All functions return structured ExecResult objects that any LLM can parse.
 */

import fs from 'node:fs';
import path from 'node:path';

// ── Types ─────────────────────────────────────────────────────

export interface ExecResult {
  ok: boolean;
  action: string;
  data: Record<string, unknown>;
  message: string;
}

export interface AgentEntry {
  status: 'active' | 'fired';
  hired: string;
  skill: string;
  briefing: string;
  assets_covered: string[];
  last_action: string;
  fired_date?: string;
  fire_reason?: string;
}

export interface DeskState {
  desk: { created: string; last_session: string; mode: string };
  agents: Record<string, AgentEntry>;
  exchanges: Record<string, unknown>;
}

export interface SkillMeta {
  slug: string;
  name: string;
  description: string;
  commands: string[];
  skillPath: string;
}

// ── Helpers ───────────────────────────────────────────────────

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function ensureDirs(deskDir: string): void {
  fs.mkdirSync(deskDir, { recursive: true });
  fs.mkdirSync(path.join(deskDir, 'briefings'), { recursive: true });
}

function readJson<T>(filePath: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

function writeJson(filePath: string, data: unknown): void {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
}

function defaultState(): DeskState {
  return {
    desk: { created: today(), last_session: today(), mode: 'paper' },
    agents: {},
    exchanges: {},
  };
}

function parseSkillFrontmatter(content: string): { name: string; description: string; commands: string[] } {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return { name: '', description: '', commands: [] };

  const yaml = match[1];
  const name = yaml.match(/^name:\s*(.+)$/m)?.[1]?.trim() ?? '';
  const desc = yaml.match(/description:\s*>\s*\n([\s\S]*?)(?=\n\w|\ncommands:)/)?.[1]?.trim().replace(/\n\s*/g, ' ')
    ?? yaml.match(/^description:\s*(.+)$/m)?.[1]?.trim()
    ?? '';
  const commands: string[] = [];
  const cmdBlock = yaml.match(/commands:\s*\n((?:\s+-.*\n?)*)/);
  if (cmdBlock) {
    for (const line of cmdBlock[1].split('\n')) {
      const cmd = line.match(/^\s+-\s+(\S+)/)?.[1];
      if (cmd) commands.push(cmd);
    }
  }
  return { name, description: desc, commands };
}

// ── Core Functions ────────────────────────────────────────────

export function resolveRoot(projectRoot?: string): string {
  return projectRoot ?? process.cwd();
}

export function resolveDeskDir(projectRoot: string): string {
  return path.join(projectRoot, '.desk');
}

/**
 * List all available agent skills.
 */
export function listAgents(projectRoot: string): ExecResult {
  const skillsDir = path.join(projectRoot, 'skills');
  if (!fs.existsSync(skillsDir)) {
    return { ok: false, action: 'list', data: {}, message: 'No skills/ directory found.' };
  }

  const agents: SkillMeta[] = [];
  for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('_')) continue;
    const skillPath = path.join(skillsDir, entry.name, 'SKILL.md');
    if (!fs.existsSync(skillPath)) continue;

    const content = fs.readFileSync(skillPath, 'utf8');
    const meta = parseSkillFrontmatter(content);
    agents.push({
      slug: entry.name,
      name: meta.name || entry.name,
      description: meta.description,
      commands: meta.commands,
      skillPath: `skills/${entry.name}/SKILL.md`,
    });
  }

  return {
    ok: true,
    action: 'list',
    data: { agents, count: agents.length },
    message: `Found ${agents.length} agents.`,
  };
}

/**
 * Hire (activate) an agent.
 */
export function hire(slug: string, projectRoot: string): ExecResult {
  const deskDir = resolveDeskDir(projectRoot);
  const skillPath = path.join(projectRoot, 'skills', slug, 'SKILL.md');

  if (!fs.existsSync(skillPath)) {
    return {
      ok: false,
      action: 'hire',
      data: { agent: slug },
      message: `No skill found at skills/${slug}/SKILL.md`,
    };
  }

  ensureDirs(deskDir);
  const statePath = path.join(deskDir, 'state.json');
  const riskPath = path.join(deskDir, 'risk.json');
  const briefingPath = path.join(deskDir, 'briefings', `${slug}.md`);

  const state = readJson<DeskState>(statePath, defaultState());
  const wasActive = state.agents[slug]?.status === 'active';
  const isNew = !fs.existsSync(briefingPath);

  state.agents[slug] = {
    ...state.agents[slug],
    status: 'active',
    hired: state.agents[slug]?.hired ?? today(),
    skill: `skills/${slug}/SKILL.md`,
    briefing: `.desk/briefings/${slug}.md`,
    assets_covered: state.agents[slug]?.assets_covered ?? [],
    last_action: wasActive
      ? (state.agents[slug]?.last_action ?? 'Hired')
      : 'Hired — awaiting first assignment',
  };
  state.desk.last_session = today();
  writeJson(statePath, state);

  if (isNew) {
    const displayName = slug.split('-').map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
    fs.writeFileSync(
      briefingPath,
      `# ${displayName} — Briefing Book\n\n## Status\n- **Hired:** ${today()}\n\n## Analyses\n_No analyses yet._\n\n## Open Questions\n_None._\n`,
    );
  }

  if (slug === 'risk-manager') {
    const risk = readJson(riskPath, { risk_manager_hired: false, parameters: {}, warnings: [] });
    (risk as Record<string, unknown>).risk_manager_hired = true;
    writeJson(riskPath, risk);
  }

  const activeAgents = Object.entries(state.agents)
    .filter(([, a]) => a.status === 'active')
    .map(([k]) => k);

  return {
    ok: true,
    action: 'hire',
    data: {
      agent: slug,
      returning: !isNew,
      briefing_path: `.desk/briefings/${slug}.md`,
      skill_path: `skills/${slug}/SKILL.md`,
      active_agents: activeAgents,
      risk_manager_active: state.agents['risk-manager']?.status === 'active',
    },
    message: isNew
      ? `Hired ${slug}. New agent — briefing book created.`
      : `Hired ${slug}. Returning agent — briefing book loaded.`,
  };
}

/**
 * Fire (deactivate) an agent.
 */
export function fire(slug: string, projectRoot: string, reason?: string): ExecResult {
  const deskDir = resolveDeskDir(projectRoot);
  const statePath = path.join(deskDir, 'state.json');
  const riskPath = path.join(deskDir, 'risk.json');

  const state = readJson<DeskState>(statePath, defaultState());

  if (!state.agents[slug] || state.agents[slug].status !== 'active') {
    return {
      ok: false,
      action: 'fire',
      data: { agent: slug },
      message: `${slug} is not currently active.`,
    };
  }

  state.agents[slug].status = 'fired';
  state.agents[slug].fired_date = today();
  state.agents[slug].fire_reason = reason ?? 'underperformance';
  state.desk.last_session = today();
  writeJson(statePath, state);

  if (slug === 'risk-manager') {
    const risk = readJson(riskPath, { risk_manager_hired: false, parameters: {}, warnings: [] });
    (risk as Record<string, unknown>).risk_manager_hired = false;
    writeJson(riskPath, risk);
  }

  const remaining = Object.entries(state.agents)
    .filter(([, a]) => a.status === 'active')
    .map(([k]) => k);

  const tradingActive = remaining.filter(a => a !== 'risk-manager');
  const warning = slug === 'risk-manager' && tradingActive.length > 0
    ? `Risk Manager fired with ${tradingActive.length} trading agent(s) still active!`
    : undefined;

  return {
    ok: true,
    action: 'fire',
    data: {
      agent: slug,
      reason: reason ?? 'underperformance',
      remaining_agents: remaining,
      warning,
    },
    message: warning
      ? `Fired ${slug}. WARNING: ${warning}`
      : `Fired ${slug}. ${remaining.length} agent(s) remaining.`,
  };
}

/**
 * Show full desk state.
 */
export function desk(projectRoot: string): ExecResult {
  const deskDir = resolveDeskDir(projectRoot);
  const statePath = path.join(deskDir, 'state.json');
  const riskPath = path.join(deskDir, 'risk.json');
  const ordersPath = path.join(deskDir, 'orders.json');

  const state = readJson<DeskState>(statePath, defaultState());
  const risk = readJson(riskPath, { risk_manager_hired: false, parameters: {} });
  const orders = readJson(ordersPath, []);

  const active = Object.entries(state.agents)
    .filter(([, a]) => a.status === 'active')
    .map(([slug, a]) => ({ slug, ...a }));

  const fired = Object.entries(state.agents)
    .filter(([, a]) => a.status === 'fired')
    .map(([slug, a]) => ({ slug, ...a }));

  return {
    ok: true,
    action: 'desk',
    data: {
      mode: state.desk.mode,
      last_session: state.desk.last_session,
      active_agents: active,
      fired_agents: fired,
      risk,
      order_count: Array.isArray(orders) ? orders.length : 0,
      exchanges: state.exchanges,
    },
    message: `Desk: ${active.length} active, ${fired.length} fired. Mode: ${state.desk.mode}.`,
  };
}

/**
 * Read an agent's skill definition.
 */
export function readSkill(slug: string, projectRoot: string): ExecResult {
  const skillPath = path.join(projectRoot, 'skills', slug, 'SKILL.md');
  if (!fs.existsSync(skillPath)) {
    return {
      ok: false,
      action: 'read-skill',
      data: { agent: slug },
      message: `No skill found at skills/${slug}/SKILL.md`,
    };
  }

  const content = fs.readFileSync(skillPath, 'utf8');
  const meta = parseSkillFrontmatter(content);

  return {
    ok: true,
    action: 'read-skill',
    data: {
      agent: slug,
      name: meta.name,
      description: meta.description,
      commands: meta.commands,
      content,
    },
    message: `Loaded skill: ${meta.name || slug}`,
  };
}

/**
 * Read an agent's briefing book.
 */
export function readBriefing(slug: string, projectRoot: string): ExecResult {
  const briefingPath = path.join(projectRoot, '.desk', 'briefings', `${slug}.md`);
  if (!fs.existsSync(briefingPath)) {
    return {
      ok: false,
      action: 'read-briefing',
      data: { agent: slug },
      message: `No briefing found for ${slug}.`,
    };
  }

  const content = fs.readFileSync(briefingPath, 'utf8');
  return {
    ok: true,
    action: 'read-briefing',
    data: { agent: slug, content },
    message: `Loaded briefing for ${slug}.`,
  };
}
