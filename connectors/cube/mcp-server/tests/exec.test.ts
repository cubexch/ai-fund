import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { listAgents, hire, fire, desk, readSkill, readBriefing } from '../../../../lib/exec.js';

// Use a temp directory as a fake project root for each test
let tmpRoot: string;

function setupFakeProject() {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-fund-test-'));

  // Create a minimal skills directory with two fake agents
  const skillsDir = path.join(tmpRoot, 'skills');
  fs.mkdirSync(path.join(skillsDir, 'test-agent'), { recursive: true });
  fs.mkdirSync(path.join(skillsDir, 'risk-manager'), { recursive: true });
  fs.mkdirSync(path.join(skillsDir, '_template'), { recursive: true });

  fs.writeFileSync(
    path.join(skillsDir, 'test-agent', 'SKILL.md'),
    `---
name: test-agent
description: >
  A test agent for unit tests. Use when: testing, unit test.
commands:
  - analyze
  - self-review
---

# Test Agent

## Personality
You are a test agent.
`,
  );

  fs.writeFileSync(
    path.join(skillsDir, 'risk-manager', 'SKILL.md'),
    `---
name: risk-manager
description: >
  Risk management gatekeeper. Use when: risk, sizing, drawdown.
commands:
  - evaluate
  - size-position
  - self-review
---

# Risk Manager

## Personality
You say no for a living.
`,
  );

  // Template should be skipped (starts with _)
  fs.writeFileSync(
    path.join(skillsDir, '_template', 'SKILL.md'),
    '---\nname: template\n---\n',
  );
}

function cleanup() {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}

describe('listAgents', () => {
  beforeEach(setupFakeProject);
  afterEach(cleanup);

  it('lists available agents, skipping _template', () => {
    const result = listAgents(tmpRoot);
    expect(result.ok).toBe(true);
    expect(result.action).toBe('list');
    const agents = result.data.agents as Array<{ slug: string }>;
    expect(agents.length).toBe(2);
    const slugs = agents.map(a => a.slug).sort();
    expect(slugs).toEqual(['risk-manager', 'test-agent']);
  });

  it('returns agent metadata from frontmatter', () => {
    const result = listAgents(tmpRoot);
    const agents = result.data.agents as Array<{ slug: string; name: string; commands: string[] }>;
    const testAgent = agents.find(a => a.slug === 'test-agent')!;
    expect(testAgent.name).toBe('test-agent');
    expect(testAgent.commands).toContain('analyze');
    expect(testAgent.commands).toContain('self-review');
  });

  it('returns ok=false when skills/ does not exist', () => {
    const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-fund-empty-'));
    const result = listAgents(emptyRoot);
    expect(result.ok).toBe(false);
    fs.rmSync(emptyRoot, { recursive: true, force: true });
  });
});

describe('hire', () => {
  beforeEach(setupFakeProject);
  afterEach(cleanup);

  it('hires a new agent and creates state + briefing', () => {
    const result = hire('test-agent', tmpRoot);
    expect(result.ok).toBe(true);
    expect(result.data.agent).toBe('test-agent');
    expect(result.data.returning).toBe(false);
    expect(result.data.skill_path).toBe('skills/test-agent/SKILL.md');

    // State file should exist
    const state = JSON.parse(fs.readFileSync(path.join(tmpRoot, '.desk', 'state.json'), 'utf8'));
    expect(state.agents['test-agent'].status).toBe('active');

    // Briefing should exist
    const briefing = fs.readFileSync(path.join(tmpRoot, '.desk', 'briefings', 'test-agent.md'), 'utf8');
    expect(briefing).toContain('Test Agent');
  });

  it('marks returning agent on re-hire', () => {
    hire('test-agent', tmpRoot);
    // Fire then re-hire
    fire('test-agent', tmpRoot);
    const result = hire('test-agent', tmpRoot);
    expect(result.ok).toBe(true);
    expect(result.data.returning).toBe(true);
  });

  it('returns ok=false for nonexistent agent', () => {
    const result = hire('nonexistent', tmpRoot);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('No skill found');
  });

  it('updates risk.json when hiring risk-manager', () => {
    hire('risk-manager', tmpRoot);
    const risk = JSON.parse(fs.readFileSync(path.join(tmpRoot, '.desk', 'risk.json'), 'utf8'));
    expect(risk.risk_manager_hired).toBe(true);
  });

  it('tracks active agents across multiple hires', () => {
    hire('risk-manager', tmpRoot);
    const result = hire('test-agent', tmpRoot);
    const active = result.data.active_agents as string[];
    expect(active).toContain('risk-manager');
    expect(active).toContain('test-agent');
    expect(result.data.risk_manager_active).toBe(true);
  });
});

describe('fire', () => {
  beforeEach(setupFakeProject);
  afterEach(cleanup);

  it('fires an active agent', () => {
    hire('test-agent', tmpRoot);
    const result = fire('test-agent', tmpRoot, 'low win rate');
    expect(result.ok).toBe(true);
    expect(result.data.agent).toBe('test-agent');
    expect(result.data.reason).toBe('low win rate');

    const state = JSON.parse(fs.readFileSync(path.join(tmpRoot, '.desk', 'state.json'), 'utf8'));
    expect(state.agents['test-agent'].status).toBe('fired');
    expect(state.agents['test-agent'].fire_reason).toBe('low win rate');
  });

  it('returns ok=false for inactive agent', () => {
    const result = fire('test-agent', tmpRoot);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('not currently active');
  });

  it('warns when firing risk-manager with active traders', () => {
    hire('risk-manager', tmpRoot);
    hire('test-agent', tmpRoot);
    const result = fire('risk-manager', tmpRoot);
    expect(result.ok).toBe(true);
    expect(result.data.warning).toContain('Risk Manager fired');
    expect(result.data.warning).toContain('1 trading agent');
  });

  it('uses default reason when none provided', () => {
    hire('test-agent', tmpRoot);
    const result = fire('test-agent', tmpRoot);
    expect(result.data.reason).toBe('underperformance');
  });
});

describe('desk', () => {
  beforeEach(setupFakeProject);
  afterEach(cleanup);

  it('returns empty desk when no agents hired', () => {
    const result = desk(tmpRoot);
    expect(result.ok).toBe(true);
    expect(result.data.active_agents).toEqual([]);
    expect(result.data.mode).toBe('paper');
  });

  it('shows active and fired agents', () => {
    hire('risk-manager', tmpRoot);
    hire('test-agent', tmpRoot);
    fire('test-agent', tmpRoot);

    const result = desk(tmpRoot);
    const active = result.data.active_agents as Array<{ slug: string }>;
    const fired = result.data.fired_agents as Array<{ slug: string }>;
    expect(active.length).toBe(1);
    expect(active[0].slug).toBe('risk-manager');
    expect(fired.length).toBe(1);
    expect(fired[0].slug).toBe('test-agent');
  });
});

describe('readSkill', () => {
  beforeEach(setupFakeProject);
  afterEach(cleanup);

  it('reads a skill file and parses metadata', () => {
    const result = readSkill('test-agent', tmpRoot);
    expect(result.ok).toBe(true);
    expect(result.data.name).toBe('test-agent');
    expect(result.data.commands).toContain('analyze');
    expect((result.data.content as string)).toContain('# Test Agent');
  });

  it('returns ok=false for nonexistent skill', () => {
    const result = readSkill('nonexistent', tmpRoot);
    expect(result.ok).toBe(false);
  });
});

describe('readBriefing', () => {
  beforeEach(setupFakeProject);
  afterEach(cleanup);

  it('reads a briefing after hire', () => {
    hire('test-agent', tmpRoot);
    const result = readBriefing('test-agent', tmpRoot);
    expect(result.ok).toBe(true);
    expect((result.data.content as string)).toContain('Test Agent');
  });

  it('returns ok=false when no briefing exists', () => {
    const result = readBriefing('test-agent', tmpRoot);
    expect(result.ok).toBe(false);
  });
});
