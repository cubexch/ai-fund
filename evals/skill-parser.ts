/**
 * SKILL.md parser for the eval framework.
 * Extracts frontmatter and markdown sections from skill files.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// ── Types ────────────────────────────────────────────────────

export interface SkillFrontmatter {
  name: string;
  description: string;
  commands: string[];
}

export interface SkillSection {
  heading: string;
  level: number;
  content: string;
}

export interface ParsedSkill {
  path: string;
  slug: string;
  raw: string;
  frontmatter: SkillFrontmatter;
  title: string;
  sections: SkillSection[];
}

// ── Parser ───────────────────────────────────────────────────

/**
 * Parse YAML-ish frontmatter from a SKILL.md file.
 * Simple parser — handles the subset of YAML used in skills.
 */
export function parseFrontmatter(raw: string): SkillFrontmatter {
  const match = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!match) {
    return { name: '', description: '', commands: [] };
  }

  const yaml = match[1];

  // Extract name
  const nameMatch = yaml.match(/^name:\s*(.+)$/m);
  const name = nameMatch?.[1]?.trim() ?? '';

  // Extract description (may be multi-line with >)
  const descMatch = yaml.match(/description:\s*>?\s*\n([\s\S]*?)(?=\ncommands:|\n[a-z]|\n$)/);
  const description = descMatch
    ? descMatch[1].split('\n').map(l => l.trim()).filter(Boolean).join(' ')
    : '';

  // Extract commands list
  const commands: string[] = [];
  const commandsMatch = yaml.match(/commands:\s*\n((?:\s+-\s+.+\n?)*)/);
  if (commandsMatch) {
    const lines = commandsMatch[1].split('\n');
    for (const line of lines) {
      const cmdMatch = line.match(/^\s+-\s+(\S+)/);
      if (cmdMatch) commands.push(cmdMatch[1]);
    }
  }

  return { name, description, commands };
}

/**
 * Extract markdown sections (headings + content) from a SKILL.md file.
 */
export function parseSections(raw: string): { title: string; sections: SkillSection[] } {
  // Strip frontmatter
  const body = raw.replace(/^---\n[\s\S]*?\n---\n*/, '');

  const lines = body.split('\n');
  const sections: SkillSection[] = [];
  let title = '';
  let currentSection: SkillSection | null = null;

  for (const line of lines) {
    const headingMatch = line.match(/^(#{1,4})\s+(.+)$/);
    if (headingMatch) {
      // Save previous section
      if (currentSection) {
        currentSection.content = currentSection.content.trim();
        sections.push(currentSection);
      }

      const level = headingMatch[1].length;
      const heading = headingMatch[2].trim();

      if (level === 1 && !title) {
        title = heading;
        currentSection = null; // Don't create a section for H1
        continue;
      }

      currentSection = { heading, level, content: '' };
    } else if (currentSection) {
      currentSection.content += line + '\n';
    }
  }

  // Push final section
  if (currentSection) {
    currentSection.content = currentSection.content.trim();
    sections.push(currentSection);
  }

  return { title, sections };
}

/**
 * Parse a complete SKILL.md file.
 */
export function parseSkill(filePath: string): ParsedSkill {
  const raw = readFileSync(filePath, 'utf-8');
  const slug = filePath.split('/').slice(-2, -1)[0];
  const frontmatter = parseFrontmatter(raw);
  const { title, sections } = parseSections(raw);

  return { path: filePath, slug, raw, frontmatter, title, sections };
}

// ── Discovery ────────────────────────────────────────────────

/**
 * Find all SKILL.md files in the skills directory.
 */
export function discoverSkills(skillsDir: string): ParsedSkill[] {
  const skills: ParsedSkill[] = [];

  const entries = readdirSync(skillsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === '_template') continue;
    const skillPath = join(skillsDir, entry.name, 'SKILL.md');
    if (existsSync(skillPath)) {
      skills.push(parseSkill(skillPath));
    }
  }

  return skills.sort((a, b) => a.slug.localeCompare(b.slug));
}

// ── Section helpers ─────────────────────────────────────────

/**
 * Get a section by heading (case-insensitive partial match).
 */
export function getSection(skill: ParsedSkill, heading: string): SkillSection | undefined {
  const lower = heading.toLowerCase();
  return skill.sections.find(s => s.heading.toLowerCase().includes(lower));
}

/**
 * Check if a section exists and has meaningful content (>50 chars).
 * Also checks subsections — a parent heading with only H3 children still counts.
 */
export function hasSection(skill: ParsedSkill, heading: string, minLength = 50): boolean {
  const section = getSection(skill, heading);
  if (!section) return false;
  if (section.content.length >= minLength) return true;

  // Check if there are subsections (H3s following this H2) with content
  const idx = skill.sections.indexOf(section);
  if (idx === -1) return false;

  let combinedLength = section.content.length;
  for (let i = idx + 1; i < skill.sections.length; i++) {
    const next = skill.sections[i];
    if (next.level <= section.level) break; // Stop at same or higher level heading
    combinedLength += next.content.length;
  }

  return combinedLength >= minLength;
}

// ── Content extraction helpers ──────────────────────────────

/**
 * Extract bullet points from a section's content.
 */
export function extractBullets(content: string): string[] {
  return content
    .split('\n')
    .filter(line => /^\s*[-*]\s+/.test(line))
    .map(line => line.replace(/^\s*[-*]\s+/, '').trim());
}

/**
 * Extract backtick-quoted tool names from content.
 */
export function extractToolReferences(content: string): string[] {
  const matches = content.match(/`([a-z_]+)`/g);
  return matches ? matches.map(m => m.replace(/`/g, '')) : [];
}

/**
 * Natural language patterns that map to known tools.
 * Some skills use "Get tickers" instead of `get_tickers`.
 */
const TOOL_PATTERNS: [RegExp, string][] = [
  [/\bplace\s+order/i, 'place_order'],
  [/\bcancel\s+order/i, 'cancel_order'],
  [/\bmodify\s+order/i, 'modify_order'],
  [/\bmass\s+cancel/i, 'mass_cancel'],
  [/\bget\s+ticker/i, 'get_tickers'],
  [/\bget\s+market/i, 'get_markets'],
  [/\border\s+book/i, 'get_order_book'],
  [/\brecent\s+trade/i, 'get_recent_trades'],
  [/\bget\s+position/i, 'get_positions'],
  [/\bget\s+balance/i, 'get_balances'],
  [/\bportfolio\s+summary/i, 'get_portfolio_summary'],
  [/\border\s+history/i, 'get_order_history'],
  [/\bget\s+fill/i, 'get_fills'],
  [/\bprice\s+history/i, 'get_price_history'],
  [/\btechnical\s+analysis/i, 'get_technical_analysis'],
  [/\bestimated\s+fee/i, 'get_estimated_fees'],
  [/\bposition\s+siz/i, 'calculate_position_size'],
  [/\bsearch\s+token/i, 'search_tokens'],
  [/\bswap\s+estimate/i, 'get_swap_estimate'],
  [/\bexecute\s+swap/i, 'execute_swap'],
  [/\bcompare\s+venue/i, 'compare_venues'],
];

/**
 * Extract tool references from content using both backtick syntax and natural language.
 */
export function extractAllToolReferences(content: string): string[] {
  const backtickTools = extractToolReferences(content);
  const nlpTools: string[] = [];

  for (const [pattern, tool] of TOOL_PATTERNS) {
    if (pattern.test(content)) {
      nlpTools.push(tool);
    }
  }

  return [...new Set([...backtickTools, ...nlpTools])];
}

/** Known generic trading tools from the exchange API */
export const KNOWN_TOOLS = [
  'place_order', 'cancel_order', 'modify_order', 'mass_cancel',
  'cancel_all_orders',
  'get_account', 'get_orders', 'get_quote', 'get_bars', 'get_portfolio_history',
  'get_tickers', 'get_markets', 'get_order_book', 'get_recent_trades',
  'get_positions', 'get_balances', 'get_portfolio_summary',
  'get_order_history', 'get_fills', 'get_subaccounts',
  'get_price_history', 'get_technical_analysis', 'get_estimated_fees',
  'calculate_position_size',
  'search_tokens', 'get_trending_tokens', 'get_swap_estimate',
  'execute_swap', 'compare_venues',
];

/** Required sections that every skill must have */
export const REQUIRED_SECTIONS = [
  'Personality',
  'Philosophy',
  'Capabilities',
  'How You Use Exchange APIs',
  'Safety Rules',
  'Performance Metrics',
];
