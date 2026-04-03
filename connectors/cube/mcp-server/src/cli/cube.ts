#!/usr/bin/env node
/**
 * Fully installed cube CLI.
 *
 * Exposes every MCP tool and resource from this package with a clean command-line
 * interface:
 *   - `cube <tool-name> ...` executes MCP tools directly
 *   - `cube tools` lists tool surface
 *   - `cube resources` lists MCP resources
 *   - `cube login|status|logout` for auth helpers
 *   - `cube mcp-server` to run the stdio MCP server
 *
 * The implementation reuses the existing MCP registration functions to avoid any
 * drift from tool logic and keep CLI behavior identical to server behavior.
 */

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import type { ZodTypeAny } from 'zod';
import { z } from 'zod';

import { IridiumClient } from '../client/iridium';
import { MendelevClient } from '../client/mendelev';
import { OsmiumClient } from '../client/osmium';

import { registerOrderTools } from '../tools/orders';
import { registerMarketDataTools } from '../tools/market-data';
import { registerAccountTools } from '../tools/account';
import { registerRiskTools } from '../tools/risk';
import { registerAnalysisTools } from '../tools/analysis';
import { registerTradingTools } from '../tools/defi';
import { registerMarketResources } from '../resources/markets';
import { registerPortfolioResources } from '../resources/portfolio';

import packageJson from '../../package.json';

interface CliOutput {
  stdout: string[];
  stderr: string[];
}

interface CliContext {
  command: string;
  commandTokens: string[];
}

interface ToolResponse {
  content?: { type: string; text: string }[];
  isError?: boolean;
  [key: string]: any;
}

interface ToolInputHandler {
  (params: any): Promise<ToolResponse> | ToolResponse;
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
  handler: () => Promise<any> | any;
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

const requireFromCurrent = createRequire(import.meta.url);

function resolveTsxCliPath(): string {
  const tsxPackageJson = requireFromCurrent.resolve('tsx/package.json');
  return resolve(dirname(tsxPackageJson), 'dist', 'cli.mjs');
}

type OptionMap = Record<string, string | boolean>;

const colorEnabled = process.stdout.isTTY && !process.env.NO_COLOR;
const c = {
  reset: colorEnabled ? '\x1b[0m' : '',
  bold: colorEnabled ? '\x1b[1m' : '',
  dim: colorEnabled ? '\x1b[2m' : '',
  cyan: colorEnabled ? '\x1b[36m' : '',
  green: colorEnabled ? '\x1b[32m' : '',
  yellow: colorEnabled ? '\x1b[33m' : '',
  red: colorEnabled ? '\x1b[31m' : '',
};

const GLOBAL_BOOL_FLAGS = new Set(['h', 'help', 'j', 'json', 'r', 'raw', 'v', 'version']);

const TOOL_GROUPS: Array<[string, string[]]> = [
  ['Orders', [
    'place_order',
    'cancel_order',
    'modify_order',
    'cancel_all_orders',
    'close_position',
    'get_orders',
  ]],
  ['Market Data', [
    'get_assets',
    'get_tickers',
    'get_order_book',
    'get_trades',
    'get_bars',
    'get_fees',
    'get_technical_analysis',
  ]],
  ['Account', [
    'get_positions',
    'get_account',
    'get_order_history',
    'get_fills',
    'get_subaccounts',
    'get_deposit_address',
  ]],
  ['Risk', [
    'get_portfolio',
    'calculate_position_size',
  ]],
  ['Analysis', [
    'detect_confluence',
    'detect_bb_squeeze',
    'assess_portfolio_risk',
    'simulate_stress_test',
    'plan_twap',
    'simulate_market_impact',
    'get_market_microstructure',
  ]],
  ['DeFi', [
    'search_assets',
    'get_trending',
    'get_quote',
    'compare_venues',
    'swap',
    'execute_trade',
  ]],
];

const CATALOG_TOOL_SET = new Set(TOOL_GROUPS.flatMap(([, names]) => names));

function normalizeFlagName(name: string): string {
  return name.replace(/^--?/, '').replace(/-/g, '_');
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

function toBoolean(value: string | boolean): boolean {
  if (typeof value === 'boolean') return value;
  const text = String(value).toLowerCase().trim();
  if (text === '1' || text === 'true' || text === 'yes' || text === 'on') return true;
  if (text === '0' || text === 'false' || text === 'no' || text === 'off') return false;
  return text.length > 0;
}

function unwrapSchema(schema?: ZodTypeAny): ZodTypeAny | undefined {
  let current = schema;
  while (current && schemaDef(current) && (
    schemaKind(current) === 'ZodOptional' ||
    schemaKind(current) === 'ZodDefault' ||
    schemaKind(current) === 'ZodNullable' ||
    schemaKind(current) === 'optional' ||
    schemaKind(current) === 'default' ||
    schemaKind(current) === 'nullable'
  )) {
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

function coerceValueBySchema(raw: any, schema: ZodTypeAny | undefined): any {
  if (schema == null) return raw;
  const base = unwrapSchema(schema);
  if (!base) return raw;

  const type = schemaDef(base)?.typeName;
  const kind = schemaKind(base);

  if (kind === 'ZodBoolean' || kind === 'boolean') return toBoolean(raw);
  if (kind === 'ZodNumber' || kind === 'number') return Number(raw);
  if (kind === 'ZodString' || kind === 'string') return String(raw);
  if (kind === 'ZodArray' || kind === 'array') {
    const inner = unwrapSchema(schemaDef(base)?.type);
    const list = Array.isArray(raw) ? raw : String(raw).split(',').map(v => v.trim()).filter(Boolean);
    return list.map(v => coerceValueBySchema(v, inner));
  }
  if (kind === 'ZodRecord' || kind === 'record') {
    const valueType = unwrapSchema(schemaDef(base)?.valueType);
    if (typeof raw === 'string' && raw.trim().startsWith('{')) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          const out: Record<string, any> = {};
          for (const [k, v] of Object.entries(parsed)) {
            out[k] = coerceValueBySchema(v, valueType);
          }
          return out;
        }
      } catch {
        // fall through to best-effort parser below
      }
    }
    if (typeof raw === 'string' && raw.includes(',')) {
      const out: Record<string, number> = {};
      for (const chunk of raw.split(',').map(v => v.trim()).filter(Boolean)) {
        const [k, v] = chunk.split('=').map(part => part.trim());
        if (k) out[k] = Number(v ?? '0');
      }
      return out;
    }
    if (typeof raw === 'object' && raw !== null) {
      const out: Record<string, any> = {};
      for (const [k, v] of Object.entries(raw as Record<string, any>)) {
        out[k] = coerceValueBySchema(v, valueType);
      }
      return out;
    }
    return raw;
  }
  if (type === 'ZodEnum' || type === 'enum') {
    if (typeof raw === 'string') return raw;
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
    if (token === '-' ) {
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

  const booleanGlobalHints = GLOBAL_BOOL_FLAGS;
  const parsed = parseOptionTokens(leading, booleanGlobalHints);
  if (command === '--help' || command === '--version' || command === '-h' || command === '-v') {
    const normalized = normalizeFlagName(command);
    parsed.options[normalized] = true;
    if (normalized === 'h') parsed.options.help = true;
    if (normalized === 'v') parsed.options.version = true;
  }
  if (parsed.options.h && parsed.options.help === undefined) parsed.options.help = true;
  if (parsed.options.v && parsed.options.version === undefined) parsed.options.version = true;

  return {
    command,
    commandTokens,
    global: parsed.options,
  };
}

export function parseToolParams(commandArgs: string[], schema: ZodTypeAny | undefined): { params: Record<string, any>; extra: string[]; } {
  const shape = schemaShape(schema);
  const required = Object.keys(shape).filter(key => !isOptional(shape[key]));
  const boolHints = new Set<string>();
  for (const [name, s] of Object.entries(shape)) {
    const base = unwrapSchema(s as ZodTypeAny);
    const baseKind = schemaKind(base);
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

  for (const req of required) {
    if (params[req] === undefined && positional.length > 0) {
      params[req] = coerceValueBySchema(positional.shift(), shape[req]);
    }
  }

  return { params, extra: positional };
}

function normalizeResponseForOutput(response: ToolResponse): any {
  if (!response || typeof response !== 'object') return response;

  if (Array.isArray(response.content) && response.content.length === 1 && response.content[0]?.type === 'text') {
    try {
      return JSON.parse(response.content[0].text);
    } catch {
      return response.content[0].text;
    }
  }

  return response;
}

function formatObjectForHuman(data: any, out: (line: string) => void, indent = 0): void {
  const prefix = ' '.repeat(indent);
  if (Array.isArray(data)) {
    if (data.every(item => item && typeof item === 'object' && !Array.isArray(item))) {
      for (const item of data) {
        if (typeof item === 'object' && item !== null) {
          const fields = Object.entries(item as Record<string, any>);
          const line = fields.map(([k, v]) => `${k}: ${String(v)}`).join(' · ');
          out(`${prefix}- ${line}`);
        }
      }
      return;
    }
    out(`${prefix}${JSON.stringify(data, null, 2)}`);
    return;
  }

  if (typeof data === 'object' && data !== null) {
    for (const [key, value] of Object.entries(data as Record<string, any>)) {
      if (value === null || typeof value !== 'object') {
        out(`${prefix}${c.cyan}${key}${c.reset}: ${value}`);
      } else {
        out(`${prefix}${c.cyan}${key}${c.reset}:`);
        formatObjectForHuman(value, out, indent + 2);
      }
    }
    return;
  }

  out(`${prefix}${String(data)}`);
}

function formatResult(response: ToolResponse, output: CliOutput, jsonMode: boolean, rawMode: boolean): number {
  const normalized = normalizeResponseForOutput(response);
  if (jsonMode) {
    output.stdout.push(JSON.stringify(normalized, null, 2));
    return response.isError ? 1 : 0;
  }

  if (!rawMode && typeof normalized === 'object' && normalized !== null) {
    formatObjectForHuman(normalized, line => output.stdout.push(line));
    return response.isError ? 1 : 0;
  }

  if (Array.isArray(response.content)) {
    for (const chunk of response.content) {
      if (chunk?.type === 'text') output.stdout.push(chunk.text);
    }
  } else {
    output.stdout.push(String(response.content ?? normalized));
  }

  return response.isError ? 1 : 0;
}

function printSection(title: string, output: CliOutput): void {
  output.stdout.push('');
  output.stdout.push(`${c.bold}${c.cyan}▸ ${title}${c.reset}`);
}

function printUsage(output: CliOutput): void {
  printSection('USAGE', output);
  output.stdout.push(`  ${c.bold}cube${c.reset} [--json] <command> [options]`);
  output.stdout.push('');
  output.stdout.push('  Login/Auth:');
  output.stdout.push('    cube login                Run device login flow');
  output.stdout.push('    cube status               Show auth status');
  output.stdout.push('    cube logout               Remove stored credentials');
  output.stdout.push('');
  output.stdout.push('  Services:');
  output.stdout.push('    cube start                Start MCP stdio server');
  output.stdout.push('    cube mcp-server           Alias for `cube start`');
  output.stdout.push('    cube tools                List all MCP tools');
  output.stdout.push('    cube resources            List resource URIs');
}

function printToolUsage(tool: CapturedTool, output: CliOutput): void {
  printSection(`tool: ${tool.name}`, output);
  output.stdout.push(tool.description || '');
  const shape = schemaShape(tool.schema);
  const keys = Object.keys(shape);
  if (keys.length === 0) {
    output.stdout.push('No parameters.');
    return;
  }
  output.stdout.push(`${c.dim}Parameters:${c.reset}`);
  for (const key of keys) {
    const schema = shape[key];
    const base = unwrapSchema(schema) as any;
    const required = !isOptional(schema as ZodTypeAny);
    const type = schemaKind(base) ?? 'unknown';
    const requiredLabel = required ? '<required>' : '[optional]';
    output.stdout.push(`  ${key} (${type}) ${requiredLabel}`);
  }
}

function printCatalog(output: CliOutput, catalog: Catalog): void {
  printSection('COMMANDS', output);
  for (const [groupName, names] of TOOL_GROUPS) {
    const registered = names.filter(name => catalog.tools.has(name));
    if (registered.length === 0) continue;
    output.stdout.push(`${c.bold}${groupName}${c.reset}`);
    for (const name of registered) {
      const tool = catalog.tools.get(name)!;
      output.stdout.push(`  ${c.green}${name}${c.reset}  ${tool.description}`);
    }
    output.stdout.push('');
  }

  const remaining = [...catalog.tools.keys()]
    .filter(name => !CATALOG_TOOL_SET.has(name))
    .sort();
  if (remaining.length > 0) {
    output.stdout.push(`${c.bold}Other${c.reset}`);
    for (const name of remaining) {
      const tool = catalog.tools.get(name)!;
      output.stdout.push(`  ${c.green}${name}${c.reset}  ${tool.description}`);
    }
  }

  printSection('RESOURCES', output);
  for (const resource of catalog.resources.values()) {
    output.stdout.push(`  ${c.green}${resource.name}${c.reset}  ${resource.uri}${resource.description ? `  ${resource.description}` : ''}`);
  }
  output.stdout.push('');
  output.stdout.push(`${c.dim}Tip:${c.reset} run ${c.bold}cube <tool-name> --help${c.reset} for parameter details`);
}

function printError(message: string, output: CliOutput, errorCode = 1): number {
  output.stderr.push(`${c.red}${c.bold}error:${c.reset} ${message}`);
  return errorCode;
}

async function printResource(catalog: Catalog, resourceName: string, output: CliOutput, jsonMode: boolean, rawMode: boolean): Promise<number> {
  const resource = catalog.resources.get(resourceName);
  if (!resource) {
    return printError(`Unknown resource "${resourceName}". Run ${c.bold}cube resources${c.reset}.`, output, 1);
  }

  const result = await resource.handler();
  if (result?.contents?.[0]?.text) {
    const text = result.contents[0].text;
    const response = { content: [{ type: 'text', text }] };
    return formatResult(response, output, jsonMode, rawMode);
  }

  const normalized = normalizeResponseForOutput(result);
  output.stdout.push(JSON.stringify(normalized, null, 2));
  return 0;
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
  const result = spawnSync(cmd, [scriptPath], { stdio: 'inherit', env: process.env });
  if (result.error) throw result.error;
  return result.status ?? 0;
}

function createOutput(): CliOutput {
  return { stdout: [], stderr: [] };
}

export function createCatalog(overrides: { iridium?: Partial<IridiumClient>; mendelev?: Partial<MendelevClient>; osmium?: Partial<OsmiumClient> } = {}): Catalog {
  const iridium = (overrides.iridium as IridiumClient) ?? new IridiumClient();
  const mendelev = (overrides.mendelev as MendelevClient) ?? new MendelevClient();
  const osmium = (overrides.osmium as OsmiumClient) ?? new OsmiumClient();

  const tools = new Map<string, CapturedTool>();
  const resources = new Map<string, CapturedResource>();

  const fakeServer = {
    tool: (name: string, description: string, schemaOrHandler: ZodTypeAny | ToolInputHandler, handlerOrUndefined?: ToolInputHandler) => {
      const schema = typeof schemaOrHandler === 'function' ? undefined : schemaOrHandler;
      const handler = typeof schemaOrHandler === 'function' ? schemaOrHandler : handlerOrUndefined!;
      tools.set(name, { name, description, schema, handler });
    },
    resource: (name: string, uri: string, options: { description?: string; mimeType?: string }, handler: () => Promise<any> | any) => {
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
    clients: {
      iridium: iridium,
      mendelev: mendelev,
      osmium: osmium,
    },
  };
}

export async function runCli(argv: string[] = process.argv.slice(2), catalogOverride?: Catalog): Promise<{ code: number; output: CliOutput }> {
  const output = createOutput();
  const catalog = catalogOverride ?? createCatalog();
  const { command, commandTokens, global } = parseTopLevel(argv);

  const showJson = Boolean(global.json || global.j);
  const showRaw = Boolean(global.raw || global.r);
  const showHelp = Boolean(global.help || global.h || (!command && argv.includes('--help')));
  const showVersion = Boolean(global.version || global.v);

  if (showVersion) {
    output.stdout.push(`${packageJson.name} ${packageJson.version}`);
    return { code: 0, output };
  }

  if (!command || showHelp) {
    printUsage(output);
    printCatalog(output, catalog);
    return { code: showHelp ? 0 : 1, output };
  }

  if (command === 'tools') {
    const subcommand = commandTokens[0];
    if (subcommand && catalog.tools.has(subcommand) && !showJson && !showRaw && !subcommand.startsWith('-')) {
      printToolUsage(catalog.tools.get(subcommand)!, output);
      return { code: 0, output };
    }

    if (showJson || subcommand === '--json' || subcommand === '-j') {
      output.stdout.push(JSON.stringify(Array.from(catalog.tools.values()), null, 2));
      return { code: 0, output };
    }
    printCatalog(output, catalog);
    return { code: 0, output };
  }

  if (command === 'resources') {
    const subresource = commandTokens[0];
    if (showJson || subresource === '--json' || subresource === '-j') {
      output.stdout.push(JSON.stringify(Array.from(catalog.resources.values()), null, 2));
      return { code: 0, output };
    }
    if (subresource && catalog.resources.has(subresource)) {
      const code = await printResource(catalog, subresource, output, showJson, showRaw);
      return { code, output };
    }
    output.stdout.push(`${c.bold}Resources${c.reset}`);
    for (const resource of catalog.resources.values()) {
      output.stdout.push(`  ${c.green}${resource.name}${c.reset}  ${resource.uri}`);
      if (resource.description) output.stdout.push(`    ${resource.description}`);
    }
    return { code: 0, output };
  }

  if (command === 'login') {
    const code = runLegacy('device-login', commandTokens);
    return { code, output };
  }
  if (command === 'status') {
    const code = runLegacy('status', commandTokens);
    return { code, output };
  }
  if (command === 'logout') {
    const code = runLegacy('logout', commandTokens);
    return { code, output };
  }
  if (command === 'start' || command === 'mcp-server') {
    const code = runMcpServer();
    return { code, output };
  }
  if (command === 'help') {
    const target = commandTokens[0];
    if (target && catalog.tools.has(target)) {
      printToolUsage(catalog.tools.get(target)!, output);
      return { code: 0, output };
    }
    printUsage(output);
    return { code: 0, output };
  }

  if (command === 'version') {
    output.stdout.push(`${packageJson.name} ${packageJson.version}`);
    return { code: 0, output };
  }

  if (!catalog.tools.has(command)) {
    return { code: printError(`Unknown command "${command}". Use ${c.bold}cube tools${c.reset} to list commands.`, output), output };
  }

  const tool = catalog.tools.get(command)!;
  const commandHelp = commandTokens.includes('--help') || commandTokens.includes('-h');
  if (commandHelp) {
    printToolUsage(tool, output);
    return { code: 0, output };
  }

  const { params, extra } = parseToolParams(commandTokens, tool.schema);
  if (extra.length > 0) {
    return { code: printError(`Unexpected argument(s): ${extra.join(', ')}`, output), output };
  }

  if (tool.schema) {
    const parsed = tool.schema.safeParse(params);
    if (!parsed.success) {
      const lines = parsed.error.issues.map((issue: any) => `  - ${issue.path.join('.')}: ${issue.message}`);
      output.stderr.push(`${c.red}Invalid arguments${c.reset}:`);
      for (const line of lines) output.stderr.push(line);
      return { code: 1, output };
    }

    try {
      const result = await tool.handler(parsed.data);
      const code = formatResult(result, output, showJson, showRaw);
      return { code, output };
    } catch (error: any) {
      return { code: printError(`Failed to run "${command}": ${error.message || error}`, output), output };
    }
  }

  try {
    const result = await tool.handler(params);
    const code = formatResult(result, output, showJson, showRaw);
    return { code, output };
  } catch (error: any) {
    return { code: printError(`Failed to run "${command}": ${error.message || error}`, output), output };
  }
}

if (resolve(process.argv[1] ?? '') === resolve(fileURLToPath(import.meta.url))) {
  runCli(process.argv.slice(2))
    .then(({ code, output }) => {
      for (const line of output.stdout) process.stdout.write(`${line}\n`);
      for (const line of output.stderr) process.stderr.write(`${line}\n`);
      process.exit(code);
    })
    .catch((error) => {
      process.stderr.write(`${c.red}fatal:${c.reset} ${error.message ?? error}\n`);
      process.exit(1);
    });
}
