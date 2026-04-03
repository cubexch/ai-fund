/**
 * Skill Evaluation Framework
 *
 * Tests every SKILL.md file against structural, content quality,
 * and cross-skill consistency requirements. Run with:
 *
 *   npm run test:evals
 *
 * Categories:
 *   1. Structural — required sections, frontmatter, heading order
 *   2. Content quality — KPIs have targets, safety rules present, persona voice
 *   3. API alignment — tool references are valid, capabilities match tools
 *   4. Cross-skill — no domain conflicts, risk manager awareness, unique personas
 */

import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import {
  discoverSkills,
  getSection,
  hasSection,
  extractBullets,
  extractToolReferences,
  extractAllToolReferences,
  REQUIRED_SECTIONS,
  KNOWN_TOOLS,
  type ParsedSkill,
} from './skill-parser';

// ── Setup ────────────────────────────────────────────────────

const SKILLS_DIR = resolve(import.meta.dirname, '..', 'skills');
const skills = discoverSkills(SKILLS_DIR);

// Sanity check — we should have 42+ skills
describe('Skill Discovery', () => {
  it('finds at least 40 skills', () => {
    expect(skills.length).toBeGreaterThanOrEqual(40);
  });

  it('excludes _template from results', () => {
    expect(skills.find(s => s.slug === '_template')).toBeUndefined();
  });
});

// ── 1. Structural Validation ────────────────────────────────

describe('Structural Validation', () => {
  describe.each(skills.map(s => [s.slug, s]))('%s', (_slug, skill) => {
    const s = skill as ParsedSkill;

    // ── Frontmatter ──

    it('has a non-empty name in frontmatter', () => {
      expect(s.frontmatter.name).toBeTruthy();
      expect(s.frontmatter.name).not.toBe('agent-name'); // Not template placeholder
    });

    it('has a description with trigger phrases', () => {
      expect(s.frontmatter.description.length).toBeGreaterThan(30);
    });

    it('has at least one command defined', () => {
      expect(s.frontmatter.commands.length).toBeGreaterThanOrEqual(1);
    });

    it('has self-review command', () => {
      expect(s.frontmatter.commands).toContain('self-review');
    });

    // ── Title ──

    it('has an H1 title', () => {
      expect(s.title).toBeTruthy();
      expect(s.title.length).toBeGreaterThan(3);
    });

    // ── Required sections ──

    for (const section of REQUIRED_SECTIONS) {
      it(`has "${section}" section with content`, () => {
        expect(hasSection(s, section)).toBe(true);
      });
    }
  });
});

// ── 2. Content Quality ──────────────────────────────────────

describe('Content Quality', () => {
  describe.each(skills.map(s => [s.slug, s]))('%s', (_slug, skill) => {
    const s = skill as ParsedSkill;

    // ── Personality ──

    it('personality is written in second person ("You")', () => {
      const personality = getSection(s, 'Personality');
      expect(personality).toBeDefined();
      expect(personality!.content).toMatch(/\bYou\b/);
    });

    it('personality is substantial (>200 chars)', () => {
      const personality = getSection(s, 'Personality');
      expect(personality!.content.length).toBeGreaterThan(200);
    });

    // ── Philosophy ──

    it('philosophy has at least 3 bullet points', () => {
      const philosophy = getSection(s, 'Philosophy');
      expect(philosophy).toBeDefined();
      const bullets = extractBullets(philosophy!.content);
      expect(bullets.length).toBeGreaterThanOrEqual(3);
    });

    // ── Capabilities ──

    it('capabilities has at least 4 items', () => {
      const capabilities = getSection(s, 'Capabilities');
      expect(capabilities).toBeDefined();
      const bullets = extractBullets(capabilities!.content);
      expect(bullets.length).toBeGreaterThanOrEqual(4);
    });

    // ── Safety Rules ──

    it('safety rules has at least 4 rules', () => {
      const safety = getSection(s, 'Safety');
      expect(safety).toBeDefined();
      const bullets = extractBullets(safety!.content);
      expect(bullets.length).toBeGreaterThanOrEqual(4);
    });

    it('safety rules mention confirmation for write operations', () => {
      const safety = getSection(s, 'Safety');
      expect(safety!.content.toLowerCase()).toMatch(/confirm|consent|explicit|approval/);
    });

    it('safety rules mention paper mode', () => {
      const safety = getSection(s, 'Safety');
      expect(safety!.content.toLowerCase()).toMatch(/paper|demo|test|staging/);
    });

    // ── Performance Metrics ──

    it('has measurable primary KPI', () => {
      const metrics = getSection(s, 'Performance Metrics')
        ?? getSection(s, 'How I\'m Measured')
        ?? getSection(s, 'Measured');
      // Also check subsections
      const howMeasured = s.sections.find(sec =>
        sec.heading.toLowerCase().includes('measured') ||
        sec.heading.toLowerCase().includes('primary')
      );
      const section = metrics ?? howMeasured;
      expect(section).toBeDefined();
      // Should contain a number or percentage as a target
      const fullContent = section!.content + s.sections
        .filter(sec => sec.heading.toLowerCase().includes('measured'))
        .map(sec => sec.content)
        .join('\n');
      expect(fullContent).toMatch(/\d+[%xX]|\d+\.\d+|>\s*\d|<\s*\d|target|goal|accuracy|rate|ratio|score/i);
    });

    it('has firing criteria', () => {
      const fireSection = s.sections.find(sec =>
        sec.heading.toLowerCase().includes('fire') ||
        sec.heading.toLowerCase().includes('termination')
      );
      // Or inline in Performance Metrics
      const metrics = getSection(s, 'Performance Metrics');
      const hasFireCriteria = fireSection
        ?? (metrics && metrics.content.toLowerCase().includes('fire'));

      // Check full raw text as fallback
      const rawHasFire = s.raw.toLowerCase().includes('fire me') ||
        s.raw.toLowerCase().includes('when to fire');
      expect(!!hasFireCriteria || rawHasFire).toBe(true);
    });
  });
});

// ── 3. API Alignment ────────────────────────────────────────

describe('API Alignment', () => {
  describe.each(skills.map(s => [s.slug, s]))('%s', (_slug, skill) => {
    const s = skill as ParsedSkill;

    it('references at least one known exchange tool', () => {
      const apiSection = getSection(s, 'Exchange APIs')
        ?? getSection(s, 'How You Use');
      expect(apiSection).toBeDefined();

      const tools = extractAllToolReferences(apiSection!.content);
      const knownRefs = tools.filter(t => KNOWN_TOOLS.includes(t));
      expect(knownRefs.length).toBeGreaterThanOrEqual(1);
    });

    it('only references valid tool names (backtick syntax)', () => {
      const apiSection = getSection(s, 'Exchange APIs')
        ?? getSection(s, 'How You Use');
      if (!apiSection) return;

      const tools = extractToolReferences(apiSection.content);
      // Filter out non-tool backtick references (config values, etc.)
      const toolLike = tools.filter(t => t.includes('_') || t.startsWith('get') || t.startsWith('place'));
      const invalid = toolLike.filter(t => !KNOWN_TOOLS.includes(t));

      expect(invalid).toEqual([]);
    });
  });
});

// ── 4. Cross-Skill Consistency ──────────────────────────────

describe('Cross-Skill Consistency', () => {
  it('all skills have unique names', () => {
    const names = skills.map(s => s.frontmatter.name);
    const unique = new Set(names);
    expect(unique.size).toBe(names.length);
  });

  it('all skills have unique titles', () => {
    const titles = skills.map(s => s.title);
    const unique = new Set(titles);
    expect(unique.size).toBe(titles.length);
  });

  it('trading agents reference risk awareness', () => {
    const tradingAgents = skills.filter(s => {
      const caps = getSection(s, 'Capabilities');
      return caps && (
        caps.content.toLowerCase().includes('order') ||
        caps.content.toLowerCase().includes('trade') ||
        caps.content.toLowerCase().includes('position')
      );
    });

    // At least 50% of trading agents should mention risk
    const riskAware = tradingAgents.filter(s =>
      s.raw.toLowerCase().includes('risk manager') ||
      s.raw.toLowerCase().includes('risk') ||
      s.raw.toLowerCase().includes('stop loss') ||
      s.raw.toLowerCase().includes('position size')
    );

    const ratio = riskAware.length / tradingAgents.length;
    expect(ratio).toBeGreaterThan(0.5);
  });

  it('no two skills have identical descriptions', () => {
    const descriptions = skills.map(s => s.frontmatter.description);
    const unique = new Set(descriptions);
    expect(unique.size).toBe(descriptions.length);
  });

  it('all skills are exchange-agnostic (no hardcoded exchange names in capabilities)', () => {
    const violations: string[] = [];

    for (const skill of skills) {
      const caps = getSection(skill, 'Capabilities');
      if (!caps) continue;

      // Skills should reference generic tools, not specific exchange APIs
      // Exception: skills that explicitly discuss multi-exchange routing
      const content = caps.content.toLowerCase();
      const hardcodedExchanges = ['binance api', 'okx api', 'kraken api', 'coinbase api'];
      for (const exchange of hardcodedExchanges) {
        if (content.includes(exchange)) {
          violations.push(`${skill.slug}: hardcodes "${exchange}" in Capabilities`);
        }
      }
    }

    expect(violations).toEqual([]);
  });
});

// ── Summary ─────────────────────────────────────────────────

describe('Coverage Summary', () => {
  it('reports total skills evaluated', () => {
    // This test always passes — it's for reporting
    console.log(`\n  Skills evaluated: ${skills.length}`);
    console.log(`  Sections per skill: ${REQUIRED_SECTIONS.length} required`);

    const missingSection: Record<string, string[]> = {};
    for (const skill of skills) {
      for (const section of REQUIRED_SECTIONS) {
        if (!hasSection(skill, section)) {
          if (!missingSection[section]) missingSection[section] = [];
          missingSection[section].push(skill.slug);
        }
      }
    }

    if (Object.keys(missingSection).length > 0) {
      console.log('\n  Missing sections:');
      for (const [section, slugs] of Object.entries(missingSection)) {
        console.log(`    ${section}: ${slugs.join(', ')}`);
      }
    } else {
      console.log('  All skills have all required sections.');
    }

    expect(true).toBe(true);
  });
});
