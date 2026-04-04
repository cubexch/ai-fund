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
  'get_account_deposit',
  'get_portfolio',
  'calculate_position_size',
  'detect_confluence',
  'detect_bb_squeeze',
  'assess_portfolio_risk',
  'simulate_stress_test',
  'plan_twap',
  'plan_vwap',
  'plan_iceberg',
  'analyze_sniper',
  'compare_execution_plans',
  'simulate_market_impact',
  'get_market_microstructure',
  'search_assets',
  'get_trending',
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

  it('skips optional number params when positional is non-numeric', () => {
    const schema = z.object({
      side: z.enum(['Bid', 'Ask']),
      price: z.number(),
      subaccountId: z.number().optional(),
      symbol: z.string().optional(),
      quantity: z.number().optional(),
    });

    const result = parseToolParams(['Bid', '90', 'SOL', '1'], schema);

    expect(result.params).toMatchObject({
      side: 'Bid',
      price: 90,
      symbol: 'SOL',
      quantity: 1,
    });
    expect(result.params.subaccountId).toBeUndefined();
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

  it('normalizes plain object tool schemas into real zod schemas', () => {
    const catalog = makeMinimalCatalog();
    const tool = catalog.tools.get('get_positions');

    expect(tool).toBeDefined();
    expect(typeof tool?.schema?.safeParse).toBe('function');
  });
});

describe('cube runCli execution contract', () => {
  it('handles --version without touching MCP runtime', async () => {
    const result = await runCli(['--version'], makeMinimalCatalog());

    expect(result.code).toBe(0);
    expect(result.output.stdout[0]).toBe(`${packageJson.name} ${packageJson.version}`);
  });

  it('renders main help with product groups and top-level auth commands', async () => {
    const result = await runCli(['help'], makeMinimalCatalog());
    const body = result.output.stdout.join('\n');

    expect(result.code).toBe(0);
    expect(body).toContain('cube account positions');
    expect(body).toContain('cube market tickers');
    expect(body).toContain('cube login');
    expect(body).toContain('Legacy aliases (deprecated)');
  });

  it('routes `cube account positions` to the positions tool and renders a table', async () => {
    const catalog = makeMinimalCatalog();
    catalog.tools.set('get_positions', {
      name: 'get_positions',
      description: 'positions',
      schema: z.object({
        subaccountId: z.number().optional(),
      }),
      handler: async () => ({
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              spot: {
                name: 'spot',
                inner: [
                  {
                    assetId: 1,
                    accountingType: 'spot',
                    amount: '1.5',
                    receivedAmount: '0',
                    pendingDeposits: '0',
                  },
                ],
              },
            }),
          },
        ],
      }),
    });

    const result = await runCli(['account', 'positions'], catalog);
    const body = result.output.stdout.join('\n');

    expect(result.code).toBe(0);
    expect(body).toContain('Positions');
    expect(body).toContain('ASSET-1');
    expect(body).toContain('Est. USD');
  });

  it('renders explicit empty state for authenticated positions reads', async () => {
    const catalog = makeMinimalCatalog();
    catalog.tools.set('get_positions', {
      name: 'get_positions',
      description: 'positions',
      schema: z.object({
        subaccountId: z.number().optional(),
      }),
      handler: async () => ({
        content: [
          {
            type: 'text',
            text: JSON.stringify({ spot: { name: 'spot', inner: [] } }),
          },
        ],
      }),
    });

    const result = await runCli(['account', 'positions'], catalog);

    expect(result.code).toBe(0);
    expect(result.output.stdout.join('\n')).toContain('No positions found');
  });

  it('executes direct MCP aliases with a deprecation warning', async () => {
    const catalog = makeMinimalCatalog();
    catalog.tools.set('get_positions', {
      name: 'get_positions',
      description: 'positions',
      schema: z.object({}),
      handler: async () => ({
        content: [{ type: 'text', text: JSON.stringify({ spot: { name: 'spot', inner: [] } }) }],
      }),
    });

    const result = await runCli(['get_positions'], catalog);

    expect(result.code).toBe(0);
    expect(result.output.stderr.join('\n')).toContain('deprecated');
    expect(result.output.stdout.join('\n')).toContain('No positions found');
  });

  it('executes `cube tools get_positions` instead of showing tool help', async () => {
    const catalog = makeMinimalCatalog();
    catalog.tools.set('get_positions', {
      name: 'get_positions',
      description: 'positions',
      schema: z.object({}),
      handler: async () => ({
        content: [{ type: 'text', text: JSON.stringify({ spot: { name: 'spot', inner: [] } }) }],
      }),
    });

    const result = await runCli(['tools', 'get_positions'], catalog);

    expect(result.code).toBe(0);
    expect(result.output.stderr.join('\n')).toContain('deprecated');
    expect(result.output.stdout.join('\n')).toContain('No positions found');
    expect(result.output.stdout.join('\n')).not.toContain('No parameters.');
  });

  it('renders market ticker data as a readable table', async () => {
    const catalog = makeMinimalCatalog();
    catalog.tools.set('get_tickers', {
      name: 'get_tickers',
      description: 'tickers',
      schema: z.object({}),
      handler: async () => ({
        content: [
          {
            type: 'text',
            text: JSON.stringify([
              {
                symbol: 'BTCUSDC',
                lastPrice: 60000,
                change24h: 2.5,
                bidPrice: 59990,
                askPrice: 60010,
                quoteVolume24h: 123456789,
              },
            ]),
          },
        ],
      }),
    });

    const result = await runCli(['market', 'tickers'], catalog);
    const body = result.output.stdout.join('\n');

    expect(result.code).toBe(0);
    expect(body).toContain('BTCUSDC');
    expect(body).toContain('24h Quote Vol');
  });

  it('preserves machine-readable output with --json', async () => {
    const catalog = makeMinimalCatalog();
    catalog.tools.set('get_positions', {
      name: 'get_positions',
      description: 'positions',
      schema: z.object({}),
      handler: async () => ({
        content: [
          {
            type: 'text',
            text: JSON.stringify({ spot: { name: 'spot', inner: [] } }),
          },
        ],
      }),
    });

    const result = await runCli(['--json', 'account', 'positions'], catalog);
    const body = JSON.parse(result.output.stdout[0]);

    expect(result.code).toBe(0);
    expect(body.spot.name).toBe('spot');
  });

  it('lists legacy MCP tools in JSON with `cube mcp tools`', async () => {
    const catalog = makeMinimalCatalog();
    const result = await runCli(['--json', 'mcp', 'tools'], catalog);

    expect(result.code).toBe(0);
    const body = JSON.parse(result.output.stdout[0]);
    expect(body).toBeInstanceOf(Array);
    expect(body.some((entry: any) => entry.name === 'get_positions')).toBe(true);
  });
});
