import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import packageJson from '../package.json';
import { createCatalog, parseToolParams, parseTopLevel, runCli } from '../src/cli/cube';

const expectedTools = [
  'place_order',
  'cancel_order',
  'modify_order',
  'cancel_all_orders',
  'get_orders',
  'close_position',
  'get_assets',
  'get_tickers',
  'get_order_book',
  'get_trades',
  'get_bars',
  'get_fees',
  'get_technical_analysis',
  'get_positions',
  'get_account',
  'get_order_history',
  'get_fills',
  'get_subaccounts',
  'get_deposit_address',
  'get_portfolio',
  'calculate_position_size',
  'detect_confluence',
  'detect_bb_squeeze',
  'assess_portfolio_risk',
  'simulate_stress_test',
  'plan_twap',
  'simulate_market_impact',
  'get_market_microstructure',
  'search_assets',
  'get_trending',
  'get_quote',
  'compare_venues',
  'swap',
  'execute_trade',
].sort();

const expectedResources = ['markets', 'portfolio', 'tickers'].sort();

function makeMinimalCatalog() {
  return createCatalog({
    iridium: {},
    mendelev: {},
    osmium: {},
  } as any);
}

describe('cube CLI parser helpers', () => {
  it('parses top-level help/version flags', () => {
    expect(parseTopLevel(['--help']).global).toMatchObject({ help: true });
    expect(parseTopLevel(['--version']).global).toMatchObject({ version: true });
    expect(parseTopLevel(['-h']).global).toMatchObject({ h: true, help: true });
    expect(parseTopLevel(['-v', 'tools']).global).toMatchObject({ v: true, version: true });
    expect(parseTopLevel(['echo', '--json', '--count', '2'])).toMatchObject({
      command: 'echo',
      commandTokens: ['--json', '--count', '2'],
      global: {},
    });
  });

  it('parses tool params with typed coercion', () => {
    const schema = z.object({
      debug: z.boolean().default(false),
      count: z.number().default(1),
      include: z.array(z.string()).default([]),
      tags: z.record(z.string(), z.number()).default({}),
    });

    const result = parseToolParams([
      '--debug=false',
      '--count',
      '2',
      '--include',
      'a,b,c',
      '--tags',
      'alpha=10,beta=20',
      'fallback',
    ], schema);

    expect(result.params).toMatchObject({
      debug: false,
      count: 2,
      include: ['a', 'b', 'c'],
      tags: { alpha: 10, beta: 20 },
    });
    expect(result.extra).toEqual(['fallback']);
  });

  it('supports boolean values passed as separate tokens', () => {
    const schema = z.object({
      dry_run: z.boolean().default(true),
      count: z.number().default(1),
    });

    const result = parseToolParams(['--dry-run', 'false', '--count', '3'], schema);

    expect(result.params).toMatchObject({
      dry_run: false,
      count: 3,
    });
    expect(result.extra).toEqual([]);
  });
});

describe('cube CLI catalog surface', () => {
  it('registers the full MCP tool surface', () => {
    const catalog = makeMinimalCatalog();
    const names = [...catalog.tools.keys()].sort();

    expect(names).toEqual(expectedTools);
  });

  it('registers the full MCP resource surface', () => {
    const catalog = makeMinimalCatalog();
    const names = [...catalog.resources.keys()].sort();

    expect(names).toEqual(expectedResources);
  });
});

describe('cube runCli execution contract', () => {
  it('handles --version without touching MCP runtime', async () => {
    const result = await runCli(['--version'], makeMinimalCatalog());

    expect(result.code).toBe(0);
    expect(result.output.stdout[0]).toBe(`${packageJson.name} ${packageJson.version}`);
  });

  it('executes tool handlers with clean output', async () => {
    const catalog = makeMinimalCatalog();
    catalog.tools.set('ping', {
      name: 'ping',
      description: 'Return a pong payload.',
      schema: z.object({
        message: z.string().default('pong'),
      }),
      handler: async params => ({
        content: [
          {
            type: 'text',
            text: JSON.stringify({ code: 'pong', message: params.message }, null, 2),
          },
        ],
      }),
    });

    const result = await runCli(['ping', '--message', 'alpha'], catalog);

    expect(result.code).toBe(0);
    expect(result.output.stdout.join('\n')).toContain('code: pong');
  });

  it('errors on unknown top-level command', async () => {
    const catalog = makeMinimalCatalog();
    const result = await runCli(['not-a-command'], catalog);

    expect(result.code).toBe(1);
    expect(result.output.stderr.join('\n')).toContain('Unknown command');
  });

  it('prints resource content via `resources <name>`', async () => {
    const catalog = makeMinimalCatalog();
    catalog.resources.set('hello', {
      name: 'hello',
      uri: 'cube://hello',
      description: 'hello resource',
      handler: () => ({
        contents: [
          {
            uri: 'cube://hello',
            mimeType: 'text/plain',
            text: 'hello world',
          },
        ],
      }),
    });

    const result = await runCli(['resources', 'hello'], catalog);

    expect(result.code).toBe(0);
    expect(result.output.stdout.join('\n')).toContain('hello world');
  });

  it('formats tool list in JSON with --json', async () => {
    const catalog = makeMinimalCatalog();
    const result = await runCli(['tools', '--json'], catalog);

    expect(result.code).toBe(0);
    const body = JSON.parse(result.output.stdout[0]);

    expect(body).toBeInstanceOf(Array);
    expect(body.some((entry: any) => entry.name === 'get_positions')).toBe(true);
  });

  it('formats tool list in JSON with short `-j` flag', async () => {
    const catalog = makeMinimalCatalog();
    const result = await runCli(['-j', 'tools'], catalog);

    expect(result.code).toBe(0);
    const body = JSON.parse(result.output.stdout[0]);

    expect(body).toBeInstanceOf(Array);
    expect(body.some((entry: any) => entry.name === 'place_order')).toBe(true);
  });

  it('formats resources in JSON with short `-j` flag', async () => {
    const catalog = makeMinimalCatalog();
    const result = await runCli(['-j', 'resources'], catalog);

    expect(result.code).toBe(0);
    const body = JSON.parse(result.output.stdout[0]);

    expect(body).toBeInstanceOf(Array);
    expect(body.some((entry: any) => entry.name === 'portfolio')).toBe(true);
  });
});
