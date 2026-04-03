#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { stdin as input, stdout as terminalOutput } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { ZodRawShape, ZodTypeAny } from 'zod';

import { IridiumClient } from '../client/iridium';
import { MendelevClient } from '../client/mendelev';
import { OsmiumClient } from '../client/osmium';
import { registerAccountTools } from '../tools/account';
import { registerAnalysisTools } from '../tools/analysis';
import { registerTradingTools } from '../tools/defi';
import { registerMarketDataTools } from '../tools/market-data';
import { registerOrderTools } from '../tools/orders';
import { registerRiskTools } from '../tools/risk';
import { registerMarketResources } from '../resources/markets';
import { registerPortfolioResources } from '../resources/portfolio';

import packageJson from '../../package.json';

type SchemaLike = ZodTypeAny | ZodRawShape | undefined;
type ToolInputHandler = (params: any) => Promise<ToolResponse> | ToolResponse;
type ResourceHandler = () => Promise<any> | any;
type RendererId =
  | 'positions'
  | 'accountSummary'
  | 'orders'
  | 'fills'
  | 'subaccounts'
  | 'portfolio'
  | 'marketList'
  | 'tickers'
  | 'orderBook'
  | 'deposit'
  | 'generic';

interface CliOutput {
  stdout: string[];
  stderr: string[];
}

interface CliContext {
  command?: string;
  commandTokens: string[];
}

interface ToolResponse {
  content?: { type: string; text: string }[];
  isError?: boolean;
  [key: string]: any;
}

interface CapturedTool {
  name: string;
  description: string;
  schema?: ZodTypeAny;
  handler: ToolInputHandler;
}

interface CapturedResource {
  name: string;
  uri: string;
  description?: string;
  mimeType?: string;
  handler: ResourceHandler;
}

interface Catalog {
  tools: Map<string, CapturedTool>;
  resources: Map<string, CapturedResource>;
  clients: {
    iridium: IridiumClient;
    mendelev: MendelevClient;
    osmium: OsmiumClient;
  };
}

interface CliCommandSpec {
  path: string[];
  summary: string;
  targetKind: 'tool' | 'resource';
  targetName: string;
  renderer: RendererId;
  destructive?: boolean;
  hidden?: boolean;
}

interface GlobalFlags {
  help?: boolean;
  version?: boolean;
  json?: boolean;
  raw?: boolean;
  no_color?: boolean;
  yes?: boolean;
  h?: boolean;
  v?: boolean;
  j?: boolean;
  r?: boolean;
}

interface ResolvedCommand {
  spec?: CliCommandSpec;
  args: string[];
  deprecatedMessage?: string;
  mode?: 'legacy-tools-list' | 'legacy-resources-list' | 'mcp-tools-list' | 'mcp-resources-list';
  exactToolName?: string;
  exactResourceName?: string;
}

type OptionMap = Record<string, string | boolean>;
type Alignment = 'left' | 'right';

const requireFromCurrent = createRequire(import.meta.url);

let colorsEnabled = process.stdout.isTTY && !process.env.NO_COLOR;
const c = {
  get reset() { return colorsEnabled ? '\x1b[0m' : ''; },
  get bold() { return colorsEnabled ? '\x1b[1m' : ''; },
  get dim() { return colorsEnabled ? '\x1b[2m' : ''; },
  get cyan() { return colorsEnabled ? '\x1b[36m' : ''; },
  get green() { return colorsEnabled ? '\x1b[32m' : ''; },
  get yellow() { return colorsEnabled ? '\x1b[33m' : ''; },
  get red() { return colorsEnabled ? '\x1b[31m' : ''; },
};

const GLOBAL_BOOL_FLAGS = new Set([
  'h',
  'help',
  'j',
  'json',
  'r',
  'raw',
  'v',
  'version',
  'no_color',
  'yes',
]);

const LEGACY_TARGET_RENDERERS: Record<string, RendererId> = {
  get_positions: 'positions',
  get_account: 'accountSummary',
  get_order_history: 'orders',
  get_orders: 'orders',
  get_fills: 'fills',
  get_subaccounts: 'subaccounts',
  get_portfolio: 'portfolio',
  get_assets: 'marketList',
  markets: 'marketList',
  get_tickers: 'tickers',
  tickers: 'tickers',
  get_order_book: 'orderBook',
  portfolio: 'generic',
};

const GROUP_SUMMARIES: Record<string, string> = {
  account: 'Balances, subaccounts, funding, and account history.',
  market: 'Market discovery, live data, and trading analysis.',
  order: 'Order placement and order lifecycle commands.',
  risk: 'Sizing, portfolio analytics, and stress testing.',
  trade: 'Venue comparison, quoting, routing, and execution.',
};

const PUBLIC_COMMANDS: CliCommandSpec[] = [
  {
    path: ['account', 'positions'],
    summary: 'Show current holdings and balances.',
    targetKind: 'tool',
    targetName: 'get_positions',
    renderer: 'positions',
  },
  {
    path: ['account', 'summary'],
    summary: 'Show account value and holdings summary.',
    targetKind: 'tool',
    targetName: 'get_account',
    renderer: 'accountSummary',
  },
  {
    path: ['account', 'orders'],
    summary: 'Show historical orders.',
    targetKind: 'tool',
    targetName: 'get_order_history',
    renderer: 'orders',
  },
  {
    path: ['account', 'fills'],
    summary: 'Show recent fills.',
    targetKind: 'tool',
    targetName: 'get_fills',
    renderer: 'fills',
  },
  {
    path: ['account', 'subaccounts'],
    summary: 'List available subaccounts.',
    targetKind: 'tool',
    targetName: 'get_subaccounts',
    renderer: 'subaccounts',
  },
  {
    path: ['account', 'deposit'],
    summary: 'Get a deposit link to fund your account.',
    targetKind: 'tool',
    targetName: 'get_account_deposit',
    renderer: 'deposit',
  },
  {
    path: ['account', 'portfolio'],
    summary: 'Show portfolio allocations and current values.',
    targetKind: 'tool',
    targetName: 'get_portfolio',
    renderer: 'portfolio',
  },
  {
    path: ['market', 'list'],
    summary: 'List available trading markets.',
    targetKind: 'tool',
    targetName: 'get_assets',
    renderer: 'marketList',
  },
  {
    path: ['market', 'tickers'],
    summary: 'Show live ticker data.',
    targetKind: 'tool',
    targetName: 'get_tickers',
    renderer: 'tickers',
  },
  {
    path: ['market', 'book'],
    summary: 'Show the current order book.',
    targetKind: 'tool',
    targetName: 'get_order_book',
    renderer: 'orderBook',
  },
  {
    path: ['market', 'trades'],
    summary: 'Show recent trades.',
    targetKind: 'tool',
    targetName: 'get_trades',
    renderer: 'generic',
  },
  {
    path: ['market', 'candles'],
    summary: 'Show historical candles.',
    targetKind: 'tool',
    targetName: 'get_bars',
    renderer: 'generic',
  },
  {
    path: ['market', 'fees'],
    summary: 'Estimate trading fees.',
    targetKind: 'tool',
    targetName: 'get_fees',
    renderer: 'generic',
  },
  {
    path: ['market', 'ta'],
    summary: 'Run technical analysis.',
    targetKind: 'tool',
    targetName: 'get_technical_analysis',
    renderer: 'generic',
  },
  {
    path: ['market', 'confluence'],
    summary: 'Run confluence analysis.',
    targetKind: 'tool',
    targetName: 'detect_confluence',
    renderer: 'generic',
  },
  {
    path: ['market', 'squeeze'],
    summary: 'Detect Bollinger squeeze conditions.',
    targetKind: 'tool',
    targetName: 'detect_bb_squeeze',
    renderer: 'generic',
  },
  {
    path: ['market', 'microstructure'],
    summary: 'Inspect order book microstructure.',
    targetKind: 'tool',
    targetName: 'get_market_microstructure',
    renderer: 'generic',
  },
  {
    path: ['market', 'search'],
    summary: 'Search tradable assets.',
    targetKind: 'tool',
    targetName: 'search_assets',
    renderer: 'generic',
  },
  {
    path: ['market', 'trending'],
    summary: 'Show trending assets.',
    targetKind: 'tool',
    targetName: 'get_trending',
    renderer: 'generic',
  },
  {
    path: ['order', 'place'],
    summary: 'Place a live order.',
    targetKind: 'tool',
    targetName: 'place_order',
    renderer: 'generic',
    destructive: true,
  },
  {
    path: ['order', 'cancel'],
    summary: 'Cancel a live order.',
    targetKind: 'tool',
    targetName: 'cancel_order',
    renderer: 'generic',
    destructive: true,
  },
  {
    path: ['order', 'modify'],
    summary: 'Modify a live order.',
    targetKind: 'tool',
    targetName: 'modify_order',
    renderer: 'generic',
    destructive: true,
  },
  {
    path: ['order', 'cancel-all'],
    summary: 'Cancel all live orders.',
    targetKind: 'tool',
    targetName: 'cancel_all_orders',
    renderer: 'generic',
    destructive: true,
  },
  {
    path: ['order', 'close'],
    summary: 'Close an open position.',
    targetKind: 'tool',
    targetName: 'close_position',
    renderer: 'generic',
    destructive: true,
  },
  {
    path: ['order', 'list'],
    summary: 'Show resting/open orders.',
    targetKind: 'tool',
    targetName: 'get_orders',
    renderer: 'orders',
  },
  {
    path: ['risk', 'size'],
    summary: 'Calculate a recommended position size.',
    targetKind: 'tool',
    targetName: 'calculate_position_size',
    renderer: 'generic',
  },
  {
    path: ['risk', 'portfolio'],
    summary: 'Assess portfolio risk metrics.',
    targetKind: 'tool',
    targetName: 'assess_portfolio_risk',
    renderer: 'generic',
  },
  {
    path: ['risk', 'stress-test'],
    summary: 'Run a portfolio stress test.',
    targetKind: 'tool',
    targetName: 'simulate_stress_test',
    renderer: 'generic',
  },
  {
    path: ['trade', 'execute'],
    summary: 'Execute a trade with smart routing (orderbook + on-chain).',
    targetKind: 'tool',
    targetName: 'execute_trade',
    renderer: 'generic',
    destructive: true,
  },
  {
    path: ['trade', 'twap'],
    summary: 'Plan a TWAP execution.',
    targetKind: 'tool',
    targetName: 'plan_twap',
    renderer: 'generic',
  },
  {
    path: ['trade', 'impact'],
    summary: 'Estimate market impact.',
    targetKind: 'tool',
    targetName: 'simulate_market_impact',
    renderer: 'generic',
  },
];

function resolveTsxCliPath(): string {
  const tsxPackageJson = requireFromCurrent.resolve('tsx/package.json');
  return resolve(dirname(tsxPackageJson), 'dist', 'cli.mjs');
}

function normalizeFlagName(name: string): string {
  return name.replace(/^--?/, '').replace(/-/g, '_');
}

function isZodSchema(value: unknown): value is ZodTypeAny {
  return Boolean(value && typeof value === 'object' && typeof (value as any).safeParse === 'function');
}

function normalizeToolSchema(schemaLike: SchemaLike): ZodTypeAny | undefined {
  if (!schemaLike) return undefined;
  if (isZodSchema(schemaLike)) return schemaLike;
  if (typeof schemaLike === 'object' && !Array.isArray(schemaLike)) {
    return z.object(schemaLike as ZodRawShape);
  }
  return undefined;
}

type ZodInternalDef = Record<string, any>;

function schemaDef(schema?: ZodTypeAny): ZodInternalDef | undefined {
  if (!schema) return undefined;
  return (schema as unknown as { _def?: ZodInternalDef })._def;
}

function schemaKind(schema?: ZodTypeAny): string | undefined {
  const def = schemaDef(schema);
  if (!def) return undefined;
  return def.typeName ?? def.type;
}

function schemaDescription(schema?: ZodTypeAny): string {
  const direct = (schema as any)?.description;
  return direct ?? schemaDef(schema)?.description ?? '';
}

function unwrapSchema(schema?: ZodTypeAny): ZodTypeAny | undefined {
  let current = schema;
  while (
    current &&
    schemaDef(current) &&
    ['ZodOptional', 'ZodDefault', 'ZodNullable', 'optional', 'default', 'nullable'].includes(schemaKind(current) ?? '')
  ) {
    current = schemaDef(current)?.innerType;
  }
  return current;
}

function schemaShape(schema: ZodTypeAny | undefined): Record<string, ZodTypeAny> {
  const base = unwrapSchema(schema);
  if (!base || !['ZodObject', 'object'].includes(schemaKind(base) ?? '')) return {};
  const shapeFactory = schemaDef(base)?.shape;
  const shape = typeof shapeFactory === 'function' ? shapeFactory() : shapeFactory ?? {};
  return shape;
}

function isOptional(schema: ZodTypeAny): boolean {
  return ['ZodOptional', 'ZodDefault', 'optional', 'default'].includes(schemaKind(schema) ?? '');
}

function toBoolean(value: string | boolean): boolean {
  if (typeof value === 'boolean') return value;
  const text = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(text)) return true;
  if (['0', 'false', 'no', 'off'].includes(text)) return false;
  return text.length > 0;
}

function coerceValueBySchema(raw: any, schema: ZodTypeAny | undefined): any {
  if (schema == null) return raw;
  const base = unwrapSchema(schema);
  if (!base) return raw;

  const kind = schemaKind(base);
  if (kind === 'ZodBoolean' || kind === 'boolean') return toBoolean(raw);
  if (kind === 'ZodNumber' || kind === 'number') return Number(raw);
  if (kind === 'ZodString' || kind === 'string') return String(raw);

  if (kind === 'ZodArray' || kind === 'array') {
    const inner = unwrapSchema(schemaDef(base)?.type);
    const list = Array.isArray(raw)
      ? raw
      : String(raw).split(',').map(value => value.trim()).filter(Boolean);
    return list.map(value => coerceValueBySchema(value, inner));
  }

  if (kind === 'ZodRecord' || kind === 'record') {
    const valueType = unwrapSchema(schemaDef(base)?.valueType);

    if (typeof raw === 'string' && raw.trim().startsWith('{')) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          const out: Record<string, any> = {};
          for (const [key, value] of Object.entries(parsed)) {
            out[key] = coerceValueBySchema(value, valueType);
          }
          return out;
        }
      } catch {
        return raw;
      }
    }

    if (typeof raw === 'string' && raw.includes(',')) {
      const out: Record<string, any> = {};
      for (const chunk of raw.split(',').map(value => value.trim()).filter(Boolean)) {
        const [key, value] = chunk.split('=').map(part => part.trim());
        if (key) out[key] = coerceValueBySchema(value ?? '', valueType);
      }
      return out;
    }

    return raw;
  }

  if ((kind === 'ZodObject' || kind === 'object') && typeof raw === 'string' && raw.trim().startsWith('{')) {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }

  return raw;
}

function parseOptionTokens(tokens: string[], booleanHints: Set<string>): { options: OptionMap; positional: string[] } {
  const options: OptionMap = {};
  const positional: string[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === '-') {
      positional.push(token);
      continue;
    }
    if (token === '--') {
      positional.push(...tokens.slice(i + 1));
      break;
    }
    if (!token.startsWith('-') || token.length < 2) {
      positional.push(token);
      continue;
    }

    const shortForm = /^-[A-Za-z]$/.test(token);
    const dashedToken = shortForm ? token.slice(1) : token.slice(2);
    const eq = token.indexOf('=');
    if (eq >= 0) {
      const key = normalizeFlagName(shortForm ? token.slice(1, eq) : token.slice(2, eq));
      options[key] = token.slice(eq + 1);
      continue;
    }

    const key = normalizeFlagName(dashedToken);
    const next = tokens[i + 1];
    if (booleanHints.has(key)) {
      if (next !== undefined && !next.startsWith('--') && /^(true|false|1|0|yes|no|on|off)$/i.test(next)) {
        options[key] = next;
        i++;
        continue;
      }
      options[key] = true;
      continue;
    }

    options[key] = next;
    i++;
  }

  return { options, positional };
}

export function parseTopLevel(argv: string[]): CliContext & { global: OptionMap } {
  let i = 0;
  const leading: string[] = [];
  while (i < argv.length && argv[i].startsWith('-') && argv[i] !== '-') {
    leading.push(argv[i]);
    i++;
  }

  const command = argv[i];
  const commandTokens = argv.slice(i + 1);
  const parsed = parseOptionTokens(leading, GLOBAL_BOOL_FLAGS);
  if (parsed.options.h && parsed.options.help === undefined) parsed.options.help = true;
  if (parsed.options.v && parsed.options.version === undefined) parsed.options.version = true;
  if (parsed.options.j && parsed.options.json === undefined) parsed.options.json = true;
  if (parsed.options.r && parsed.options.raw === undefined) parsed.options.raw = true;

  return { command, commandTokens, global: parsed.options };
}

export function parseToolParams(commandArgs: string[], schema: ZodTypeAny | undefined): { params: Record<string, any>; extra: string[] } {
  const shape = schemaShape(schema);
  const required = Object.keys(shape).filter(key => !isOptional(shape[key]));
  const boolHints = new Set<string>();

  for (const [name, fieldSchema] of Object.entries(shape)) {
    const baseKind = schemaKind(unwrapSchema(fieldSchema));
    if (baseKind && ['ZodBoolean', 'boolean'].includes(baseKind)) boolHints.add(name);
  }

  const { options, positional } = parseOptionTokens(commandArgs, boolHints);
  const params: Record<string, any> = {};

  for (const [key, value] of Object.entries(options)) {
    if (shape[key]) {
      params[key] = coerceValueBySchema(value, shape[key]);
    } else {
      params[key] = value;
    }
  }

  // Fill required params first, then optional params, from positional args
  const optional = Object.keys(shape).filter(key => isOptional(shape[key]));
  for (const key of [...required, ...optional]) {
    if (params[key] === undefined && positional.length > 0) {
      params[key] = coerceValueBySchema(positional.shift(), shape[key]);
    }
  }

  return { params, extra: positional };
}

function createOutput(): CliOutput {
  return { stdout: [], stderr: [] };
}

function extractGlobalFlags(argv: string[]): { flags: GlobalFlags; tokens: string[] } {
  const flags: GlobalFlags = {};
  const tokens: string[] = [];
  let passthrough = false;

  for (const token of argv) {
    if (passthrough) {
      tokens.push(token);
      continue;
    }

    if (token === '--') {
      passthrough = true;
      tokens.push(token);
      continue;
    }

    const normalized = normalizeFlagName(token);
    if (!token.startsWith('-') || !GLOBAL_BOOL_FLAGS.has(normalized)) {
      tokens.push(token);
      continue;
    }

    flags[normalized as keyof GlobalFlags] = true;
    if (normalized === 'h') flags.help = true;
    if (normalized === 'v') flags.version = true;
    if (normalized === 'j') flags.json = true;
    if (normalized === 'r') flags.raw = true;
  }

  return { flags, tokens };
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, '');
}

function visibleLength(text: string): number {
  return stripAnsi(text).length;
}

function truncate(text: string, width: number): string {
  if (width <= 0) return '';
  const plain = stripAnsi(text);
  if (plain.length <= width) return text;
  if (width <= 1) return plain.slice(0, width);
  return `${plain.slice(0, width - 1)}…`;
}

function pad(text: string, width: number, alignment: Alignment = 'left'): string {
  const shown = truncate(text, width);
  const diff = Math.max(0, width - visibleLength(shown));
  return alignment === 'right' ? `${' '.repeat(diff)}${shown}` : `${shown}${' '.repeat(diff)}`;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function renderTable(headers: string[], rows: string[][], alignments: Alignment[] = []): string[] {
  if (headers.length === 0) return [];

  const maxWidth = Math.max(80, (process.stdout.columns ?? 110) - 2);
  const widths = headers.map((header, columnIndex) => {
    const cells = rows.map(row => row[columnIndex] ?? '');
    return Math.max(visibleLength(header), ...cells.map(visibleLength), 3);
  });
  const minWidths = headers.map(header => Math.max(3, Math.min(visibleLength(header), 12)));
  const separatorWidth = (headers.length - 1) * 2;

  while (sum(widths) + separatorWidth > maxWidth) {
    let largest = -1;
    let largestIndex = -1;
    for (let index = 0; index < widths.length; index++) {
      if (widths[index] > minWidths[index] && widths[index] > largest) {
        largest = widths[index];
        largestIndex = index;
      }
    }
    if (largestIndex < 0) break;
    widths[largestIndex]--;
  }

  const headerLine = headers.map((header, index) => pad(`${c.bold}${header}${c.reset}`, widths[index], alignments[index] ?? 'left')).join('  ');
  const ruleLine = widths.map(width => `${c.dim}${'-'.repeat(width)}${c.reset}`).join('  ');
  const bodyLines = rows.map(row =>
    row.map((cell, index) => pad(String(cell ?? ''), widths[index], alignments[index] ?? 'left')).join('  ')
  );

  return [headerLine, ruleLine, ...bodyLines];
}

function formatCurrency(value: number | null | undefined, decimals = 2): string {
  if (value == null || Number.isNaN(value)) return 'N/A';
  return `$${value.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })}`;
}

function formatNumber(value: number | null | undefined, decimals = 4): string {
  if (value == null || Number.isNaN(value)) return 'N/A';
  return value.toLocaleString('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: decimals,
  });
}

function formatCompact(value: number | null | undefined): string {
  if (value == null || Number.isNaN(value)) return 'N/A';
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`;
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return formatNumber(value, 2);
}

function formatPercent(value: number | null | undefined, decimals = 2, fromWhole = true): string {
  if (value == null || Number.isNaN(value)) return 'N/A';
  const scaled = fromWhole ? value : value * 100;
  const rendered = `${scaled.toFixed(decimals)}%`;
  if (!colorsEnabled) return rendered;
  if (scaled > 0) return `${c.green}${rendered}${c.reset}`;
  if (scaled < 0) return `${c.red}${rendered}${c.reset}`;
  return rendered;
}

function formatTimestamp(value: string | number | null | undefined): string {
  if (value == null) return 'N/A';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatStatus(value: string | number | null | undefined): string {
  if (value == null) return 'N/A';
  const text = String(value);
  if (!colorsEnabled) return text;
  const upper = text.toUpperCase();
  if (['OPEN', 'PLACED', 'FILLED', 'SUCCESS', 'ACTIVE'].includes(upper)) {
    return `${c.green}${text}${c.reset}`;
  }
  if (['CANCELED', 'CANCELLED', 'REJECTED', 'FAILED', 'ERROR'].includes(upper)) {
    return `${c.red}${text}${c.reset}`;
  }
  return `${c.yellow}${text}${c.reset}`;
}

const ICONS: Record<string, string> = {
  BTC: '₿', ETH: 'Ξ', SOL: '◎', USDC: '💵', USDT: '₮',
  DOGE: 'Ð', LTC: 'Ł', XRP: '✕', ADA: '₳', DOT: '●',
  AVAX: 'Ⓐ', MATIC: '⬡', ATOM: '⚛', LINK: '⬡', UNI: '🦄',
  AAVE: '👻', APT: '❖', SUI: '💧', TAO: 'τ', BONK: '🐕',
  PENGU: '🐧', TRUMP: '🇺🇸', FARTCOIN: '💨', JUP: '♃', PYTH: '🔮',
  RAY: '☀', HNT: '📡', ORCA: '🐋', DEEP: '🌊', WAL: '🐘',
  CHZ: '⚽', MNDE: '⛏', RUNES: '᚛', JTO: '🏗', JitoSOL: '◎',
};

/** Strip staging t-prefix (tSOLt → SOL, tBTCt → BTC) and look up icon */
function assetLabel(symbol: string): string {
  let canonical = symbol;
  if (/^t[A-Z].*t$/i.test(symbol)) canonical = symbol.slice(1, -1);
  else if (/^t[A-Z]/i.test(symbol)) canonical = symbol.slice(1);
  const icon = ICONS[canonical.toUpperCase()] ?? ICONS[symbol.toUpperCase()];
  return icon ? `${icon}  ${symbol}` : symbol;
}

function renderKeyValues(entries: Array<[string, string]>): string[] {
  const width = Math.max(...entries.map(([label]) => label.length), 10);
  return entries.map(([label, value]) => `${c.dim}${label.padEnd(width)}${c.reset}  ${value}`);
}

function section(title: string): string {
  return `${c.bold}${title}${c.reset}`;
}

async function confirmIfNeeded(spec: CliCommandSpec, flags: GlobalFlags): Promise<boolean> {
  if (!spec.destructive || flags.yes) return true;
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;

  const rl = createInterface({ input, output: terminalOutput });
  try {
    const answer = await rl.question(`${c.yellow}This is a live trading action. Proceed? [y/N] ${c.reset}`);
    return ['y', 'yes'].includes(answer.trim().toLowerCase());
  } finally {
    rl.close();
  }
}

function runLegacy(script: 'device-login' | 'status' | 'logout', args: string[]): number {
  const baseDir = dirname(fileURLToPath(import.meta.url));
  const isCompiled = fileURLToPath(import.meta.url).endsWith('.js');
  const scriptName = isCompiled ? `${script}.js` : `${script}.ts`;
  const scriptPath = resolve(baseDir, scriptName);

  if (!existsSync(scriptPath)) {
    throw new Error(`Cannot locate CLI script: ${scriptPath}`);
  }

  const cmd = isCompiled ? process.execPath : resolveTsxCliPath();
  const result = spawnSync(cmd, [scriptPath, ...args], {
    stdio: 'inherit',
    env: process.env,
  });
  if (result.error) throw result.error;
  return result.status ?? 0;
}

function runMcpServer(): number {
  const baseDir = dirname(fileURLToPath(import.meta.url));
  const isCompiled = fileURLToPath(import.meta.url).endsWith('.js');
  const scriptPath = resolve(baseDir, isCompiled ? '../index.js' : '../index.ts');
  const cmd = isCompiled ? process.execPath : resolveTsxCliPath();
  const result = spawnSync(cmd, [scriptPath], {
    stdio: 'inherit',
    env: process.env,
  });
  if (result.error) throw result.error;
  return result.status ?? 0;
}

export function createCatalog(overrides: {
  iridium?: Partial<IridiumClient>;
  mendelev?: Partial<MendelevClient>;
  osmium?: Partial<OsmiumClient>;
} = {}): Catalog {
  const iridium = (overrides.iridium as IridiumClient) ?? new IridiumClient();
  const mendelev = (overrides.mendelev as MendelevClient) ?? new MendelevClient();
  const osmium = (overrides.osmium as OsmiumClient) ?? new OsmiumClient();

  const tools = new Map<string, CapturedTool>();
  const resources = new Map<string, CapturedResource>();

  const fakeServer = {
    tool: (
      name: string,
      description: string,
      schemaOrHandler: SchemaLike | ToolInputHandler,
      handlerOrUndefined?: ToolInputHandler,
    ) => {
      const rawSchema = typeof schemaOrHandler === 'function' ? undefined : schemaOrHandler;
      const schema = normalizeToolSchema(rawSchema);
      const handler = typeof schemaOrHandler === 'function' ? schemaOrHandler : handlerOrUndefined!;
      tools.set(name, { name, description, schema, handler });
    },
    resource: (
      name: string,
      uri: string,
      options: { description?: string; mimeType?: string },
      handler: ResourceHandler,
    ) => {
      resources.set(name, {
        name,
        uri,
        description: options.description,
        mimeType: options.mimeType,
        handler,
      });
    },
  } as any;

  registerOrderTools(fakeServer, osmium as unknown as OsmiumClient, iridium as unknown as IridiumClient);
  registerMarketDataTools(fakeServer, iridium as unknown as IridiumClient, mendelev as unknown as MendelevClient);
  registerAccountTools(fakeServer, iridium as unknown as IridiumClient);
  registerRiskTools(fakeServer, iridium as unknown as IridiumClient);
  registerAnalysisTools(fakeServer, iridium as unknown as IridiumClient);
  registerTradingTools(fakeServer, iridium as unknown as IridiumClient, osmium as unknown as OsmiumClient);
  registerMarketResources(fakeServer, iridium as unknown as IridiumClient);
  registerPortfolioResources(fakeServer, iridium as unknown as IridiumClient);

  return {
    tools,
    resources,
    clients: { iridium, mendelev, osmium },
  };
}

function listPublicGroups(): string[] {
  const groups = Array.from(new Set(PUBLIC_COMMANDS.map(spec => spec.path[0])));
  return groups.sort();
}

function findSpecByPath(tokens: string[]): { spec?: CliCommandSpec; args: string[] } {
  const sorted = [...PUBLIC_COMMANDS].sort((left, right) => right.path.length - left.path.length);
  for (const spec of sorted) {
    if (spec.path.every((segment, index) => tokens[index] === segment)) {
      return { spec, args: tokens.slice(spec.path.length) };
    }
  }
  return { spec: undefined, args: tokens };
}

function findSpecByTarget(targetName: string): CliCommandSpec | undefined {
  return PUBLIC_COMMANDS.find(spec => spec.targetName === targetName);
}

function preferredPath(spec: CliCommandSpec): string {
  return `cube ${spec.path.join(' ')}`;
}

function resolveLegacyTool(name: string): CliCommandSpec {
  const publicSpec = findSpecByTarget(name);
  if (publicSpec) return publicSpec;
  return {
    path: ['mcp', 'run', name],
    summary: `Run MCP tool ${name}.`,
    targetKind: 'tool',
    targetName: name,
    renderer: LEGACY_TARGET_RENDERERS[name] ?? 'generic',
    hidden: true,
  };
}

function resolveLegacyResource(name: string): CliCommandSpec {
  return {
    path: ['mcp', 'resources', name],
    summary: `Read MCP resource ${name}.`,
    targetKind: 'resource',
    targetName: name,
    renderer: LEGACY_TARGET_RENDERERS[name] ?? 'generic',
    hidden: true,
  };
}

function resolveCommand(tokens: string[], catalog: Catalog): ResolvedCommand {
  if (tokens.length === 0) return { args: [] };

  if (tokens[0] === 'tools') {
    if (!tokens[1]) return { args: [], mode: 'legacy-tools-list' };
    const spec = resolveLegacyTool(tokens[1]);
    return {
      spec,
      args: tokens.slice(2),
      deprecatedMessage: `\`cube tools ${tokens[1]}\` is deprecated. Use \`${preferredPath(spec)}\`.`,
      exactToolName: tokens[1],
    };
  }

  if (tokens[0] === 'resources') {
    if (!tokens[1]) return { args: [], mode: 'legacy-resources-list' };
    const spec = resolveLegacyResource(tokens[1]);
    return {
      spec,
      args: tokens.slice(2),
      deprecatedMessage: `\`cube resources ${tokens[1]}\` is deprecated. Use \`cube mcp resources ${tokens[1]}\` or the public command where available.`,
      exactResourceName: tokens[1],
    };
  }

  if (tokens[0] === 'mcp') {
    if (tokens[1] === 'tools') {
      return { args: tokens.slice(2), mode: 'mcp-tools-list' };
    }
    if (tokens[1] === 'resources') {
      if (tokens[2]) {
        return {
          spec: resolveLegacyResource(tokens[2]),
          args: tokens.slice(3),
          exactResourceName: tokens[2],
        };
      }
      return { args: tokens.slice(2), mode: 'mcp-resources-list' };
    }
    if (tokens[1] === 'run' && tokens[2]) {
      return {
        spec: resolveLegacyTool(tokens[2]),
        args: tokens.slice(3),
        exactToolName: tokens[2],
      };
    }
  }

  const pathMatch = findSpecByPath(tokens);
  if (pathMatch.spec) return { spec: pathMatch.spec, args: pathMatch.args };

  if (catalog.tools.has(tokens[0])) {
    const spec = resolveLegacyTool(tokens[0]);
    return {
      spec,
      args: tokens.slice(1),
      deprecatedMessage: `\`cube ${tokens[0]}\` is deprecated. Use \`${preferredPath(spec)}\`.`,
      exactToolName: tokens[0],
    };
  }

  if (catalog.resources.has(tokens[0])) {
    const spec = resolveLegacyResource(tokens[0]);
    return {
      spec,
      args: tokens.slice(1),
      deprecatedMessage: `Direct MCP resource access is deprecated. Use \`cube mcp resources ${tokens[0]}\`.`,
      exactResourceName: tokens[0],
    };
  }

  return { args: tokens };
}

function fieldTypeLabel(schema: ZodTypeAny): string {
  const base = unwrapSchema(schema);
  const kind = schemaKind(base) ?? 'unknown';
  if (kind.includes('String') || kind === 'string') return 'string';
  if (kind.includes('Number') || kind === 'number') return 'number';
  if (kind.includes('Boolean') || kind === 'boolean') return 'boolean';
  if (kind.includes('Array') || kind === 'array') return 'array';
  if (kind.includes('Enum') || kind === 'enum') return 'enum';
  if (kind.includes('Record') || kind === 'record') return 'record';
  if (kind.includes('Object') || kind === 'object') return 'object';
  return kind.replace(/^Zod/, '').toLowerCase();
}

function printMainHelp(output: CliOutput): void {
  output.stdout.push(`${c.bold}${packageJson.name}${c.reset} ${c.dim}${packageJson.version}${c.reset}`);
  output.stdout.push('');
  output.stdout.push('Usage');
  output.stdout.push('  cube <group> <command> [options]');
  output.stdout.push('  cube login|status|logout');
  output.stdout.push('  cube start');
  output.stdout.push('');

  for (const group of listPublicGroups()) {
    output.stdout.push(section(group));
    output.stdout.push(`  ${GROUP_SUMMARIES[group]}`);
    const rows = PUBLIC_COMMANDS
      .filter(spec => spec.path[0] === group)
      .map(spec => [`cube ${spec.path.join(' ')}`, spec.summary]);
    output.stdout.push(...renderTable(['Command', 'Description'], rows));
    output.stdout.push('');
  }

  output.stdout.push(section('Top-level'));
  output.stdout.push('  cube login');
  output.stdout.push('  cube status');
  output.stdout.push('  cube logout');
  output.stdout.push('  cube start');
  output.stdout.push('  cube version');
  output.stdout.push('  cube help [group|command]');
  output.stdout.push('');

  output.stdout.push(section('Legacy aliases (deprecated)'));
  output.stdout.push('  cube get_positions');
  output.stdout.push('  cube tools get_positions');
  output.stdout.push('  cube resources portfolio');
  output.stdout.push(`  ${c.dim}Exact MCP inspection remains available under hidden commands such as \`cube mcp tools\`.${c.reset}`);
}

function printGroupHelp(group: string, output: CliOutput): void {
  output.stdout.push(section(`cube ${group}`));
  output.stdout.push(GROUP_SUMMARIES[group] ?? 'Grouped commands.');
  output.stdout.push('');
  const rows = PUBLIC_COMMANDS
    .filter(spec => spec.path[0] === group)
    .map(spec => [`cube ${spec.path.join(' ')}`, spec.summary]);
  output.stdout.push(...renderTable(['Command', 'Description'], rows));
}

function printCommandHelp(spec: CliCommandSpec, catalog: Catalog, output: CliOutput): void {
  output.stdout.push(section(preferredPath(spec)));
  output.stdout.push(spec.summary);
  output.stdout.push('');

  if (spec.destructive) {
    output.stdout.push(`${c.yellow}This command performs a live trading action. Use \`--yes\` to skip confirmation.${c.reset}`);
    output.stdout.push('');
  }

  if (spec.targetKind === 'resource') {
    output.stdout.push(`${c.dim}Backed by MCP resource:${c.reset} ${spec.targetName}`);
    return;
  }

  const target = catalog.tools.get(spec.targetName);
  output.stdout.push(`${c.dim}Backed by MCP tool:${c.reset} ${spec.targetName}`);
  const schema = target?.schema;
  const shape = schemaShape(schema);
  const fields = Object.entries(shape);

  if (fields.length === 0) {
    output.stdout.push('No parameters.');
    return;
  }

  output.stdout.push('');
  const rows = fields.map(([name, fieldSchema]) => {
    const required = !isOptional(fieldSchema);
    const flag = `--${name.replace(/_/g, '-')}`;
    const type = fieldTypeLabel(fieldSchema);
    const detail = schemaDescription(fieldSchema);
    return [flag, type, required ? 'required' : 'optional', detail || ''];
  });
  output.stdout.push(...renderTable(['Option', 'Type', 'Required', 'Description'], rows));
}

function printLegacyToolList(output: CliOutput, catalog: Catalog): void {
  output.stdout.push(`${c.yellow}Legacy MCP tool commands are deprecated.${c.reset}`);
  const rows = listLegacyTools(catalog).map(tool => [tool.name, tool.preferred, tool.description]);
  output.stdout.push(...renderTable(['Legacy tool', 'Preferred command', 'Description'], rows));
}

function printLegacyResourceList(output: CliOutput, catalog: Catalog): void {
  output.stdout.push(`${c.yellow}Legacy MCP resource commands are deprecated.${c.reset}`);
  const rows = listLegacyResources(catalog).map(resource => [resource.name, resource.uri, resource.description]);
  output.stdout.push(...renderTable(['Resource', 'URI', 'Description'], rows));
}

function printMcpToolList(output: CliOutput, catalog: Catalog): void {
  const rows = listMcpTools(catalog).map(tool => [tool.name, tool.description]);
  output.stdout.push(...renderTable(['MCP tool', 'Description'], rows));
}

function printMcpResourceList(output: CliOutput, catalog: Catalog): void {
  const rows = listMcpResources(catalog).map(resource => [resource.name, resource.uri, resource.description]);
  output.stdout.push(...renderTable(['MCP resource', 'URI', 'Description'], rows));
}

function listLegacyTools(catalog: Catalog): Array<{ name: string; preferred: string; description: string }> {
  return [...catalog.tools.values()]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map(tool => {
      const publicSpec = findSpecByTarget(tool.name);
      return {
        name: tool.name,
        preferred: publicSpec ? preferredPath(publicSpec) : 'mcp only',
        description: tool.description,
      };
    });
}

function listLegacyResources(catalog: Catalog): Array<{ name: string; uri: string; description: string }> {
  return [...catalog.resources.values()]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map(resource => ({
      name: resource.name,
      uri: resource.uri,
      description: resource.description ?? '',
    }));
}

function listMcpTools(catalog: Catalog): Array<{ name: string; description: string }> {
  return [...catalog.tools.values()]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map(tool => ({
      name: tool.name,
      description: tool.description,
    }));
}

function listMcpResources(catalog: Catalog): Array<{ name: string; uri: string; description: string }> {
  return [...catalog.resources.values()]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map(resource => ({
      name: resource.name,
      uri: resource.uri,
      description: resource.description ?? '',
    }));
}

function printWarning(message: string, output: CliOutput): void {
  output.stderr.push(`${c.yellow}warning:${c.reset} ${message}`);
}

function printError(message: string, output: CliOutput, errorCode = 1): number {
  output.stderr.push(`${c.red}${c.bold}error:${c.reset} ${message}`);
  return errorCode;
}

function normalizeResponseForOutput(response: ToolResponse | any): any {
  if (!response || typeof response !== 'object') return response;

  if (Array.isArray(response.content) && response.content.length === 1 && response.content[0]?.type === 'text') {
    try {
      return JSON.parse(response.content[0].text);
    } catch {
      return response.content[0].text;
    }
  }

  if (Array.isArray(response.contents) && response.contents.length === 1 && response.contents[0]?.text) {
    try {
      return JSON.parse(response.contents[0].text);
    } catch {
      return response.contents[0].text;
    }
  }

  return response;
}

async function getAssetContext(catalog: Catalog): Promise<{
  symbolByAssetId: Map<number, string>;
  priceBySymbol: Map<string, number>;
}> {
  const symbolByAssetId = new Map<number, string>();
  const priceBySymbol = new Map<string, number>();

  try {
    if (typeof (catalog.clients.iridium as any)?.getAssetRegistry === 'function') {
      const registry = await (catalog.clients.iridium as any).getAssetRegistry();
      if (registry?.allAssets) {
        for (const asset of registry.allAssets()) {
          symbolByAssetId.set(asset.assetId, asset.symbol);
        }
      }
    }
  } catch {
    // Best effort only.
  }

  try {
    if (typeof (catalog.clients.iridium as any)?.getTickers === 'function') {
      const tickers = await (catalog.clients.iridium as any).getTickers();
      if (Array.isArray(tickers)) {
        for (const ticker of tickers) {
          if (ticker?.symbol && ticker?.lastPrice != null) {
            priceBySymbol.set(ticker.symbol, Number(ticker.lastPrice));
          }
        }
      }
    }
  } catch {
    // Best effort only.
  }

  return { symbolByAssetId, priceBySymbol };
}

function hasMeaningfulPositions(rows: Array<{ amount: number }>): boolean {
  return rows.some(row => row.amount > 0);
}

async function renderPositions(data: any, catalog: Catalog): Promise<string[]> {
  const groups = Object.entries(data ?? {});
  if (groups.length === 0) return ['No positions found.'];

  const assetContext = await getAssetContext(catalog);
  const rows: Array<{ asset: string; accountingType: string; amount: number; pending: number; received: number; estValue: number | null }> = [];

  for (const [, group] of groups) {
    const inner = Array.isArray((group as any)?.inner) ? (group as any).inner : [];
    for (const entry of inner) {
      const symbol = entry.symbol ?? assetContext.symbolByAssetId.get(Number(entry.assetId)) ?? `ASSET-${entry.assetId}`;
      const amount = Number(entry.amount ?? 0);
      const pending = Number(entry.pendingDeposits ?? 0);
      const received = Number(entry.receivedAmount ?? 0);
      const isStable = ['USDC', 'USDT', 'tUSDC', 'tUSDT', 'gUSDC'].includes(symbol);
      const symbolTicker = assetContext.priceBySymbol.get(`${symbol}USDC`)
        ?? assetContext.priceBySymbol.get(`${symbol}tUSDC`);
      const usdRate = entry.usdRate ? entry.usdRate / 1e9 : null;
      const price = isStable ? 1 : (symbolTicker ?? usdRate);
      rows.push({
        asset: assetLabel(symbol),
        accountingType: String(entry.accountingType ?? (group as any)?.name ?? 'unknown'),
        amount,
        pending,
        received,
        estValue: price != null ? amount * price : null,
      });
    }
  }

  const nonZero = rows.filter(row => row.amount > 0 || row.pending > 0 || row.received > 0);
  if (!hasMeaningfulPositions(nonZero)) return ['No positions found.'];

  const totalValue = nonZero.reduce((total, row) => total + (row.estValue ?? 0), 0);
  const tableRows = nonZero
    .sort((left, right) => (right.estValue ?? 0) - (left.estValue ?? 0))
    .map(row => [
      row.asset,
      row.accountingType,
      formatNumber(row.amount, 8),
      formatNumber(row.pending, 8),
      formatNumber(row.received, 8),
      row.estValue != null ? formatCurrency(row.estValue) : 'N/A',
    ]);

  return [
    ...renderKeyValues([
      ['Positions', String(nonZero.length)],
      ['Estimated value', totalValue > 0 ? formatCurrency(totalValue) : 'N/A'],
    ]),
    '',
    ...renderTable(['Asset', 'Type', 'Amount', 'Pending', 'Received', 'Est. USD'], tableRows, ['left', 'left', 'right', 'right', 'right', 'right']),
  ];
}

function renderAccountSummary(data: any): string[] {
  const balances = Array.isArray(data?.balances) ? data.balances : [];
  if (balances.length === 0) return ['No balances found.'];

  const rows = balances.map((balance: any) => [
    assetLabel(balance.symbol ?? balance.asset ?? 'N/A'),
    formatNumber(Number(balance.amount ?? 0), 8),
    String(balance.usdPrice ?? 'N/A'),
    String(balance.usdValue ?? 'N/A'),
  ]);

  return [
    ...renderKeyValues([
      ['Total value', String(data.totalValue ?? 'N/A')],
      ['Assets', String(balances.length)],
    ]),
    '',
    ...renderTable(['Asset', 'Amount', 'Price', 'Value'], rows, ['left', 'right', 'right', 'right']),
  ];
}

function renderOrders(data: any): string[] {
  const rows = Array.isArray(data) ? data : [];
  if (rows.length === 0) return ['No orders found.'];

  const tableRows = rows.map((order: any) => [
    order.symbol ?? order.market ?? 'N/A',
    String(order.side ?? 'N/A'),
    String(order.orderType ?? order.type ?? 'N/A'),
    formatStatus(order.status ?? 'N/A'),
    String(order.price ?? 'N/A'),
    String(order.quantity ?? order.size ?? 'N/A'),
    String(order.filledQuantity ?? order.filled ?? 'N/A'),
    formatTimestamp(order.createdAt ?? order.timestamp),
  ]);

  return renderTable(
    ['Symbol', 'Side', 'Type', 'Status', 'Price', 'Qty', 'Filled', 'Time'],
    tableRows,
    ['left', 'left', 'left', 'left', 'right', 'right', 'right', 'left'],
  );
}

function renderFills(data: any): string[] {
  const rows = Array.isArray(data) ? data : [];
  if (rows.length === 0) return ['No fills found.'];

  const tableRows = rows.map((fill: any) => [
    fill.symbol ?? 'N/A',
    String(fill.side ?? 'N/A'),
    String(fill.price ?? 'N/A'),
    String(fill.quantity ?? 'N/A'),
    fill.feeAsset ? `${fill.fee ?? 'N/A'} ${fill.feeAsset}` : String(fill.fee ?? 'N/A'),
    formatTimestamp(fill.timestamp),
  ]);

  return renderTable(
    ['Symbol', 'Side', 'Price', 'Qty', 'Fee', 'Time'],
    tableRows,
    ['left', 'left', 'right', 'right', 'right', 'left'],
  );
}

function renderSubaccounts(data: any): string[] {
  const ids = Array.isArray(data?.ids) ? data.ids : Array.isArray(data) ? data : [];
  if (ids.length === 0) return ['No subaccounts found.'];
  const rows = ids.map((id: any, index: number) => [String(id), index === 0 ? 'default' : '']);
  return renderTable(['Subaccount ID', 'Role'], rows);
}

async function renderMarketList(data: any, catalog: Catalog): Promise<string[]> {
  const markets = Array.isArray(data) ? data : [];
  if (markets.length === 0) return ['No markets found.'];

  const assetContext = await getAssetContext(catalog);
  const rows = markets.map((market: any) => [
    market.symbol ?? 'N/A',
    assetContext.symbolByAssetId.get(Number(market.baseAssetId)) ?? String(market.baseAssetId ?? 'N/A'),
    assetContext.symbolByAssetId.get(Number(market.quoteAssetId)) ?? String(market.quoteAssetId ?? 'N/A'),
    String(market.marketId ?? 'N/A'),
    String(market.priceTickSize ?? 'N/A'),
    String(market.quantityTickSize ?? 'N/A'),
    formatStatus(market.status ?? 'N/A'),
  ]);

  return renderTable(
    ['Symbol', 'Base', 'Quote', 'Market ID', 'Price Tick', 'Qty Tick', 'Status'],
    rows,
    ['left', 'left', 'left', 'right', 'right', 'right', 'left'],
  );
}

function renderTickers(data: any): string[] {
  const tickers = Array.isArray(data) ? data : [];
  if (tickers.length === 0) return ['No tickers available.'];

  const rows = tickers
    .slice()
    .sort((left: any, right: any) => Number(right.quoteVolume24h ?? 0) - Number(left.quoteVolume24h ?? 0))
    .map((ticker: any) => [
      ticker.symbol ?? 'N/A',
      formatNumber(Number(ticker.lastPrice), 6),
      formatPercent(Number(ticker.change24h), 2, true),
      formatNumber(Number(ticker.bidPrice), 6),
      formatNumber(Number(ticker.askPrice), 6),
      formatCompact(Number(ticker.quoteVolume24h ?? 0)),
    ]);

  return renderTable(
    ['Symbol', 'Last', '24h', 'Bid', 'Ask', '24h Quote Vol'],
    rows,
    ['left', 'right', 'right', 'right', 'right', 'right'],
  );
}

function renderOrderBook(data: any): string[] {
  if (!data || typeof data !== 'object') return [String(data)];
  const bids = Array.isArray(data.bids) ? data.bids : [];
  const asks = Array.isArray(data.asks) ? data.asks : [];

  if (bids.length === 0 && asks.length === 0) return ['Order book is empty.'];

  const bestBid = bids[0]?.[0] ?? null;
  const bestAsk = asks[0]?.[0] ?? null;
  const spread = bestBid != null && bestAsk != null ? bestAsk - bestBid : null;
  const lines = [
    ...renderKeyValues([
      ['Market', String(data.ticker_id ?? 'N/A')],
      ['Updated', formatTimestamp(data.timestamp)],
      ['Best bid', bestBid != null ? formatNumber(bestBid, 6) : 'N/A'],
      ['Best ask', bestAsk != null ? formatNumber(bestAsk, 6) : 'N/A'],
      ['Spread', spread != null ? formatNumber(spread, 6) : 'N/A'],
    ]),
    '',
    section('Asks'),
    ...renderTable(
      ['Price', 'Size'],
      asks.slice(0, 10).map(([price, size]: [number, number]) => [formatNumber(price, 6), formatNumber(size, 6)]),
      ['right', 'right'],
    ),
    '',
    section('Bids'),
    ...renderTable(
      ['Price', 'Size'],
      bids.slice(0, 10).map(([price, size]: [number, number]) => [formatNumber(price, 6), formatNumber(size, 6)]),
      ['right', 'right'],
    ),
  ];
  return lines;
}

function renderPortfolio(data: any): string[] {
  const positions = Array.isArray(data?.positions) ? data.positions : [];
  if (positions.length === 0) return ['No portfolio holdings found.'];

  const rows = positions.map((position: any) => [
    assetLabel(position.asset ?? position.label ?? 'N/A'),
    formatNumber(Number(position.amount), 8),
    typeof position.price === 'number' ? formatCurrency(position.price, 4) : String(position.price ?? 'N/A'),
    typeof position.value === 'number' ? formatCurrency(position.value) : String(position.value ?? 'N/A'),
    String(position.allocation ?? 'N/A'),
  ]);

  return [
    ...renderKeyValues([
      ['Total value', String(data.totalPortfolioValue ?? 'N/A')],
      ['Positions', String(data.positionCount ?? positions.length)],
    ]),
    '',
    ...renderTable(['Asset', 'Amount', 'Price', 'Value', 'Allocation'], rows, ['left', 'right', 'right', 'right', 'right']),
  ];
}

function renderGenericObject(data: Record<string, any>, depth = 0): string[] {
  const lines: string[] = [];
  const prefix = ' '.repeat(depth * 2);

  for (const [key, value] of Object.entries(data)) {
    if (value == null || typeof value !== 'object') {
      lines.push(`${prefix}${c.dim}${key}${c.reset}  ${String(value)}`);
      continue;
    }

    if (Array.isArray(value)) {
      lines.push(`${prefix}${section(key)}`);
      if (value.length === 0) {
        lines.push(`${prefix}  (empty)`);
      } else if (value.every(item => item && typeof item === 'object' && !Array.isArray(item))) {
        lines.push(...renderGenericTable(value).map(line => `${prefix}${line}`));
      } else {
        for (const item of value) lines.push(`${prefix}  - ${String(item)}`);
      }
      continue;
    }

    lines.push(`${prefix}${section(key)}`);
    lines.push(...renderGenericObject(value, depth + 1));
  }

  return lines;
}

function renderGenericTable(rows: Record<string, any>[]): string[] {
  if (rows.length === 0) return ['(empty)'];
  const keys = Object.keys(rows[0]).slice(0, 6);
  const tableRows = rows.map(row => keys.map(key => String(row[key] ?? '')));
  return renderTable(keys.map(key => key.replace(/_/g, ' ')), tableRows);
}

function renderDeposit(data: any): string[] {
  if (!data || typeof data !== 'object') return ['No deposit data.'];
  const lines: string[] = [];
  lines.push('');
  lines.push(`  ${c.bold}Deposit ${data.asset ?? ''}${c.reset}`);
  lines.push('');
  if (data.amount) {
    lines.push(`    ${c.dim}Amount${c.reset}       ${data.amount} ${data.asset ?? ''}`);
  }
  if (data.label) {
    lines.push(`    ${c.dim}Agent${c.reset}        ${data.label}`);
  }
  lines.push('');
  lines.push(`  ${c.cyan}${data.depositUrl}${c.reset}`);
  lines.push('');
  lines.push(`  ${c.dim}Open this link to complete your deposit.${c.reset}`);
  lines.push('');
  return lines;
}

function renderGeneric(data: any): string[] {
  if (data == null) return ['No data returned.'];
  if (typeof data === 'string') return [data];
  if (Array.isArray(data)) {
    if (data.length === 0) return ['No data returned.'];
    if (data.every(item => item && typeof item === 'object' && !Array.isArray(item))) {
      return renderGenericTable(data as Record<string, any>[]);
    }
    return data.map(item => `- ${String(item)}`);
  }
  if (typeof data === 'object') return renderGenericObject(data);
  return [String(data)];
}

async function renderHuman(spec: CliCommandSpec, data: any, catalog: Catalog): Promise<string[]> {
  switch (spec.renderer) {
    case 'positions':
      return renderPositions(data, catalog);
    case 'accountSummary':
      return renderAccountSummary(data);
    case 'orders':
      return renderOrders(data);
    case 'fills':
      return renderFills(data);
    case 'subaccounts':
      return renderSubaccounts(data);
    case 'portfolio':
      return renderPortfolio(data);
    case 'marketList':
      return renderMarketList(data, catalog);
    case 'tickers':
      return renderTickers(data);
    case 'orderBook':
      return renderOrderBook(data);
    case 'deposit':
      return renderDeposit(data);
    case 'generic':
    default:
      return renderGeneric(data);
  }
}

async function executeTool(tool: CapturedTool, args: string[], output: CliOutput): Promise<{ response?: ToolResponse; code: number }> {
  const { params, extra } = parseToolParams(args, tool.schema);
  if (extra.length > 0) {
    return {
      code: printError(`Unexpected argument(s): ${extra.join(', ')}`, output),
    };
  }

  if (tool.schema) {
    const parsed = tool.schema.safeParse(params);
    if (!parsed.success) {
      output.stderr.push(`${c.red}Invalid arguments:${c.reset}`);
      for (const issue of parsed.error.issues) {
        output.stderr.push(`  - ${issue.path.join('.') || '(root)'}: ${issue.message}`);
      }
      return { code: 1 };
    }

    try {
      const response = await tool.handler(parsed.data);
      return { response, code: response.isError ? 1 : 0 };
    } catch (error: any) {
      return {
        code: printError(`Failed to run "${tool.name}": ${error.message || error}`, output),
      };
    }
  }

  try {
    const response = await tool.handler(params);
    return { response, code: response.isError ? 1 : 0 };
  } catch (error: any) {
    return {
      code: printError(`Failed to run "${tool.name}": ${error.message || error}`, output),
    };
  }
}

async function executeResource(resource: CapturedResource, output: CliOutput): Promise<{ response?: any; code: number }> {
  try {
    const response = await resource.handler();
    return { response, code: 0 };
  } catch (error: any) {
    return {
      code: printError(`Failed to read resource "${resource.name}": ${error.message || error}`, output),
    };
  }
}

async function emitResult(
  spec: CliCommandSpec,
  response: any,
  catalog: Catalog,
  output: CliOutput,
  flags: GlobalFlags,
): Promise<number> {
  const normalized = normalizeResponseForOutput(response);

  if (response?.isError) {
    const message = typeof normalized === 'string' ? normalized : JSON.stringify(normalized, null, 2);
    output.stderr.push(`${c.red}${message}${c.reset}`);
    return 1;
  }

  if (flags.json) {
    output.stdout.push(JSON.stringify(normalized, null, 2));
    return 0;
  }

  if (flags.raw) {
    if (typeof normalized === 'string') {
      output.stdout.push(normalized);
    } else {
      output.stdout.push(JSON.stringify(normalized, null, 2));
    }
    return 0;
  }

  const lines = await renderHuman(spec, normalized, catalog);
  for (const line of lines) output.stdout.push(line);

  // Auto-open deposit URL in browser
  if (spec.renderer === 'deposit' && normalized?.depositUrl) {
    try {
      const open = ((await import('open' as string)) as { default: (url: string) => Promise<unknown> }).default;
      await open(normalized.depositUrl);
    } catch {
      const { exec } = await import('node:child_process');
      const cmd = process.platform === 'darwin' ? 'open'
        : process.platform === 'win32' ? 'start'
        : 'xdg-open';
      exec(`${cmd} "${normalized.depositUrl}"`);
    }
  }

  return 0;
}

export async function runCli(
  argv: string[] = process.argv.slice(2),
  catalogOverride?: Catalog,
): Promise<{ code: number; output: CliOutput }> {
  const output = createOutput();
  const catalog = catalogOverride ?? createCatalog();
  const extracted = extractGlobalFlags(argv);
  const flags = extracted.flags;
  colorsEnabled = process.stdout.isTTY && !process.env.NO_COLOR && !Boolean(flags.no_color);

  if (flags.version || flags.v) {
    output.stdout.push(`${packageJson.name} ${packageJson.version}`);
    return { code: 0, output };
  }

  const tokens = extracted.tokens;
  const command = tokens[0];
  const showHelp = Boolean(flags.help || flags.h);

  if (!command) {
    printMainHelp(output);
    return { code: 0, output };
  }

  if (command === 'help') {
    const target = tokens.slice(1);
    if (target.length === 0) {
      printMainHelp(output);
      return { code: 0, output };
    }

    if (target.length === 1 && listPublicGroups().includes(target[0])) {
      printGroupHelp(target[0], output);
      return { code: 0, output };
    }

    const resolved = resolveCommand(target, catalog);
    if (resolved.spec) {
      printCommandHelp(resolved.spec, catalog, output);
      return { code: 0, output };
    }

    return { code: printError(`Unknown command path "${target.join(' ')}".`, output), output };
  }

  if (command === 'login') return { code: runLegacy('device-login', tokens.slice(1)), output };
  if (command === 'status') return { code: runLegacy('status', tokens.slice(1)), output };
  if (command === 'logout') return { code: runLegacy('logout', tokens.slice(1)), output };
  if (command === 'start' || command === 'mcp-server') return { code: runMcpServer(), output };
  if (command === 'version') {
    output.stdout.push(`${packageJson.name} ${packageJson.version}`);
    return { code: 0, output };
  }

  const resolved = resolveCommand(tokens, catalog);

  if (resolved.mode === 'legacy-tools-list') {
    if (flags.json || flags.raw) {
      output.stdout.push(JSON.stringify(listLegacyTools(catalog), null, 2));
      return { code: 0, output };
    }
    printLegacyToolList(output, catalog);
    return { code: 0, output };
  }
  if (resolved.mode === 'legacy-resources-list') {
    if (flags.json || flags.raw) {
      output.stdout.push(JSON.stringify(listLegacyResources(catalog), null, 2));
      return { code: 0, output };
    }
    printLegacyResourceList(output, catalog);
    return { code: 0, output };
  }
  if (resolved.mode === 'mcp-tools-list') {
    if (flags.json || flags.raw) {
      output.stdout.push(JSON.stringify(listMcpTools(catalog), null, 2));
      return { code: 0, output };
    }
    printMcpToolList(output, catalog);
    return { code: 0, output };
  }
  if (resolved.mode === 'mcp-resources-list') {
    if (flags.json || flags.raw) {
      output.stdout.push(JSON.stringify(listMcpResources(catalog), null, 2));
      return { code: 0, output };
    }
    printMcpResourceList(output, catalog);
    return { code: 0, output };
  }

  if (!resolved.spec) {
    if (listPublicGroups().includes(command)) {
      printGroupHelp(command, output);
      return { code: 0, output };
    }
    return { code: printError(`Unknown command "${command}". Run \`cube help\`.`, output), output };
  }

  if (resolved.deprecatedMessage) printWarning(resolved.deprecatedMessage, output);

  if (showHelp) {
    printCommandHelp(resolved.spec, catalog, output);
    return { code: 0, output };
  }

  if (resolved.spec.destructive) {
    const confirmed = await confirmIfNeeded(resolved.spec, flags);
    if (!confirmed) {
      return {
        code: printError(`Confirmation required for live action. Re-run with \`--yes\` to skip the prompt.`, output),
        output,
      };
    }
  }

  if (resolved.exactToolName) {
    const tool = catalog.tools.get(resolved.exactToolName);
    if (!tool) return { code: printError(`Unknown MCP tool "${resolved.exactToolName}".`, output), output };
    const result = await executeTool(tool, resolved.args, output);
    if (!result.response) return { code: result.code, output };
    const code = await emitResult(resolved.spec, result.response, catalog, output, flags);
    return { code, output };
  }

  if (resolved.exactResourceName) {
    const resource = catalog.resources.get(resolved.exactResourceName);
    if (!resource) return { code: printError(`Unknown MCP resource "${resolved.exactResourceName}".`, output), output };
    const result = await executeResource(resource, output);
    if (!result.response) return { code: result.code, output };
    const code = await emitResult(resolved.spec, result.response, catalog, output, flags);
    return { code, output };
  }

  if (resolved.spec.targetKind === 'tool') {
    const tool = catalog.tools.get(resolved.spec.targetName);
    if (!tool) return { code: printError(`Missing tool handler for "${resolved.spec.targetName}".`, output), output };
    const result = await executeTool(tool, resolved.args, output);
    if (!result.response) return { code: result.code, output };
    const code = await emitResult(resolved.spec, result.response, catalog, output, flags);
    return { code, output };
  }

  const resource = catalog.resources.get(resolved.spec.targetName);
  if (!resource) return { code: printError(`Missing resource handler for "${resolved.spec.targetName}".`, output), output };
  const result = await executeResource(resource, output);
  if (!result.response) return { code: result.code, output };
  const code = await emitResult(resolved.spec, result.response, catalog, output, flags);
  return { code, output };
}

if (resolve(process.argv[1] ?? '') === resolve(fileURLToPath(import.meta.url))) {
  runCli(process.argv.slice(2))
    .then(({ code, output }) => {
      for (const line of output.stdout) process.stdout.write(`${line}\n`);
      for (const line of output.stderr) process.stderr.write(`${line}\n`);
      process.exit(code);
    })
    .catch(error => {
      process.stderr.write(`${c.red}fatal:${c.reset} ${error.message ?? error}\n`);
      process.exit(1);
    });
}
