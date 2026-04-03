import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ExchangeClient } from '../client/exchange';
import { handler } from './handler';
import { MarketDataStore, type OHLCVRow } from '@ai-fund/lib/datastore';
import type { TradeJournal } from '../client/trade-journal';
import {
  sma, ema, rsi, bollingerBands, atr, obv, type OHLCV,
} from '@ai-fund/lib/indicators';
import {
  correlation, correlationMatrix, returns, mean, standardDeviation,
  sharpeRatio, sortinoRatio, maxDrawdown, winRate, profitFactor,
} from '@ai-fund/lib/math';

// Cast schemas to any to avoid TS2589 "excessively deep type instantiation" with zod + MCP SDK
/* eslint-disable @typescript-eslint/no-explicit-any */

export function registerDatastoreTools(server: McpServer, client: ExchangeClient) {
  const store = client.store;

  server.tool(
    'ingest_history',
    `Bulk ingest historical OHLCV data from ${client.name} into the local DuckDB cache. Fetches candles and stores them for fast SQL analytics. Run this before cross-symbol analysis.`,
    {
      symbols: z.string().describe('Comma-separated trading pairs (e.g., "BTC/USDT,ETH/USDT")'),
      timeframe: z.string().default('1d').describe('Candle timeframe (1m, 5m, 15m, 1h, 4h, 1d)'),
      limit: z.number().default(500).describe('Max candles per symbol to fetch'),
    } as any,
    handler(async (params: any) => {
      if (!store) throw new Error('DuckDB datastore not configured. Restart with data caching enabled.');

      const symbols = params.symbols.split(',').map((s: string) => s.trim()).filter(Boolean);
      const results: { symbol: string; rows: number; error?: string }[] = [];

      for (const symbol of symbols) {
        try {
          const lastTs = await store.lastTimestamp(symbol, params.timeframe, client.exchangeId);
          const since = lastTs ? lastTs.getTime() + 1 : undefined;
          const bars = await client.getBars(symbol, params.timeframe, since, params.limit);

          if (bars.length === 0) {
            results.push({ symbol, rows: 0 });
            continue;
          }

          const rows: OHLCVRow[] = bars.map(b => ({
            symbol,
            exchange: client.exchangeId,
            asset_type: 'crypto',
            interval: params.timeframe,
            ts: new Date(b.timestamp),
            open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume,
          }));

          const inserted = await store.insertOHLCV(rows);
          results.push({ symbol, rows: inserted });
        } catch (err: any) {
          results.push({ symbol, rows: 0, error: err.message });
        }
      }

      const totalRows = results.reduce((sum, r) => sum + r.rows, 0);
      return { exchange: client.exchangeId, timeframe: params.timeframe, totalRows, symbols: results };
    }),
  );

  server.tool(
    'query_market_data',
    `Run a SQL query against the local DuckDB market data cache. The ohlcv table has columns: symbol, exchange, asset_type, interval, ts, open, high, low, close, volume. Use for VWAP, volume profiles, cross-symbol analysis — like kdb+ for crypto.`,
    {
      sql: z.string().describe('SQL query against the ohlcv table (SELECT only)'),
    } as any,
    handler(async (params: any) => {
      if (!store) throw new Error('DuckDB datastore not configured. Restart with data caching enabled.');

      const query = params.sql.trim();
      // Security: only allow SELECT queries
      if (!/^SELECT\b/i.test(query)) {
        throw new Error('Only SELECT queries are allowed. Use ingest_history to insert data.');
      }
      // Block dangerous patterns
      if (/\b(DROP|DELETE|UPDATE|INSERT|ALTER|CREATE|ATTACH|COPY|EXPORT)\b/i.test(query)) {
        throw new Error('Write operations are not allowed. Use ingest_history to manage data.');
      }

      const rows = await store.sql(query);
      return { rowCount: rows.length, rows: rows.slice(0, 1000) }; // cap at 1000 rows
    }),
  );

  server.tool(
    'get_cached_symbols',
    `List all symbols cached in the local DuckDB market data store. Shows available exchanges, intervals, date ranges, and row counts.`,
    {} as any,
    handler(async () => {
      if (!store) throw new Error('DuckDB datastore not configured. Restart with data caching enabled.');

      const symbols = await store.symbols();
      const totalRows = await store.count();
      return { totalRows, symbols };
    }),
  );

  server.tool(
    'analyze_cross_symbol',
    `Cross-symbol statistical analysis using cached DuckDB data. Computes correlation matrix, relative returns, Sharpe ratios, and max drawdowns across multiple symbols — essential for pairs trading and portfolio construction.`,
    {
      symbols: z.string().describe('Comma-separated trading pairs (e.g., "BTC/USDT,ETH/USDT,SOL/USDT")'),
      timeframe: z.string().default('1d').describe('Candle timeframe to analyze'),
      period: z.number().default(90).describe('Number of candles to analyze'),
    } as any,
    handler(async (params: any) => {
      if (!store) throw new Error('DuckDB datastore not configured. Restart with data caching enabled.');

      const symbolList = params.symbols.split(',').map((s: string) => s.trim()).filter(Boolean);
      if (symbolList.length < 2) throw new Error('Need at least 2 symbols for cross-symbol analysis.');

      // Fetch close prices for each symbol from cache
      const seriesMap: Record<string, number[]> = {};
      const statsMap: Record<string, any> = {};

      for (const symbol of symbolList) {
        const candles = await store.query({
          symbol,
          interval: params.timeframe,
          exchange: client.exchangeId,
          limit: params.period,
        });

        if (candles.length < 10) {
          throw new Error(`Insufficient cached data for ${symbol} (${candles.length} candles). Run ingest_history first.`);
        }

        const closes = candles.map((c: any) => c.close);
        const rets = returns(closes);
        seriesMap[symbol] = closes;

        const dd = maxDrawdown(closes);
        statsMap[symbol] = {
          candles: candles.length,
          firstPrice: closes[0],
          lastPrice: closes[closes.length - 1],
          totalReturn: Math.round(((closes[closes.length - 1] / closes[0]) - 1) * 10000) / 100,
          avgDailyReturn: Math.round(mean(rets) * 10000) / 100,
          volatility: Math.round(standardDeviation(rets) * 10000) / 100,
          sharpe: Math.round(sharpeRatio(rets) * 100) / 100,
          sortino: Math.round(sortinoRatio(rets) * 100) / 100,
          maxDrawdown: Math.round(dd.maxDrawdown * 10000) / 100,
        };
      }

      // Correlation matrix
      const returnSeries = symbolList.map((s: string) => returns(seriesMap[s]));
      // Align lengths to shortest
      const minLen = Math.min(...returnSeries.map((r: number[]) => r.length));
      const aligned = returnSeries.map((r: number[]) => r.slice(r.length - minLen));
      const corrResult = correlationMatrix(aligned, symbolList);

      // Format as labeled matrix
      const correlations: Record<string, Record<string, number>> = {};
      for (let i = 0; i < symbolList.length; i++) {
        correlations[symbolList[i]] = {};
        for (let j = 0; j < symbolList.length; j++) {
          correlations[symbolList[i]][symbolList[j]] =
            Math.round(corrResult.matrix[i][j] * 1000) / 1000;
        }
      }

      return {
        exchange: client.exchangeId,
        timeframe: params.timeframe,
        period: params.period,
        stats: statsMap,
        correlations,
      };
    }),
  );

  server.tool(
    'get_volume_profile',
    `Compute volume profile (price-weighted volume distribution) from cached DuckDB data. Shows where the most trading activity occurred — essential for support/resistance and optimal order placement.`,
    {
      symbol: z.string().describe('Trading pair (e.g., BTC/USDT)'),
      timeframe: z.string().default('1h').describe('Candle timeframe'),
      period: z.number().default(200).describe('Number of candles to analyze'),
      bins: z.number().default(20).describe('Number of price bins'),
    } as any,
    handler(async (params: any) => {
      if (!store) throw new Error('DuckDB datastore not configured. Restart with data caching enabled.');

      const candles = await store.query({
        symbol: params.symbol,
        interval: params.timeframe,
        exchange: client.exchangeId,
        limit: params.period,
      });

      if (candles.length < 10) {
        throw new Error(`Insufficient cached data (${candles.length} candles). Run ingest_history first.`);
      }

      // Find price range
      const highs = candles.map((c: any) => c.high);
      const lows = candles.map((c: any) => c.low);
      const priceMin = Math.min(...lows);
      const priceMax = Math.max(...highs);
      const binSize = (priceMax - priceMin) / params.bins;

      // Build volume profile
      const profile: { priceLevel: number; volume: number; pct: number }[] = [];
      let totalVolume = 0;

      for (let i = 0; i < params.bins; i++) {
        const lo = priceMin + i * binSize;
        const hi = lo + binSize;
        let binVolume = 0;
        for (const c of candles) {
          // Proportional volume allocation based on overlap
          const overlap = Math.max(0,
            Math.min(c.high, hi) - Math.max(c.low, lo)
          );
          const range = c.high - c.low || 1;
          binVolume += c.volume * (overlap / range);
        }
        totalVolume += binVolume;
        profile.push({
          priceLevel: Math.round(((lo + hi) / 2) * 100) / 100,
          volume: Math.round(binVolume * 100) / 100,
          pct: 0,
        });
      }

      // Calculate percentages
      for (const bin of profile) {
        bin.pct = Math.round((bin.volume / totalVolume) * 10000) / 100;
      }

      // Point of control (highest volume bin)
      const poc = profile.reduce((max, b) => b.volume > max.volume ? b : max, profile[0]);

      // Value area (70% of volume around POC)
      const sorted = [...profile].sort((a, b) => b.volume - a.volume);
      let vaVolume = 0;
      const vaTarget = totalVolume * 0.7;
      const vaBins: number[] = [];
      for (const bin of sorted) {
        if (vaVolume >= vaTarget) break;
        vaVolume += bin.volume;
        vaBins.push(bin.priceLevel);
      }

      return {
        symbol: params.symbol,
        timeframe: params.timeframe,
        candles: candles.length,
        priceRange: { min: Math.round(priceMin * 100) / 100, max: Math.round(priceMax * 100) / 100 },
        pointOfControl: poc.priceLevel,
        valueArea: {
          high: Math.round(Math.max(...vaBins) * 100) / 100,
          low: Math.round(Math.min(...vaBins) * 100) / 100,
        },
        profile,
      };
    }),
  );

  server.tool(
    'get_vwap',
    `Compute VWAP (Volume-Weighted Average Price) from cached DuckDB data. The execution benchmark used by every institutional desk. Compares current price to VWAP for mean-reversion signals.`,
    {
      symbol: z.string().describe('Trading pair (e.g., BTC/USDT)'),
      timeframe: z.string().default('1h').describe('Candle timeframe'),
      period: z.number().default(24).describe('Number of candles for VWAP calculation'),
    } as any,
    handler(async (params: any) => {
      if (!store) throw new Error('DuckDB datastore not configured. Restart with data caching enabled.');

      // Use SQL for VWAP — this is what DuckDB excels at
      const rows = await store.sql(
        `SELECT
           SUM(close * volume) / NULLIF(SUM(volume), 0) as vwap,
           SUM(volume) as total_volume,
           COUNT(*) as candles,
           MIN(ts) as start_ts,
           MAX(ts) as end_ts
         FROM (
           SELECT close, volume, ts FROM ohlcv
           WHERE symbol = ? AND interval = ? AND exchange = ?
           ORDER BY ts DESC
           LIMIT ?
         )`,
        [params.symbol, params.timeframe, client.exchangeId, params.period],
      );

      const row = rows[0];
      if (!row || !row.vwap) {
        throw new Error(`No cached data for ${params.symbol}. Run ingest_history first.`);
      }

      // Get current price for comparison
      let currentPrice: number | undefined;
      try {
        const ticker = await client.getTicker(params.symbol);
        currentPrice = ticker.last ?? undefined;
      } catch { /* best effort */ }

      const vwap = row.vwap as number;
      const deviation = currentPrice != null
        ? Math.round(((currentPrice - vwap) / vwap) * 10000) / 100
        : undefined;

      return {
        symbol: params.symbol,
        timeframe: params.timeframe,
        vwap: Math.round(vwap * 100) / 100,
        totalVolume: Math.round((row.total_volume as number) * 100) / 100,
        candles: row.candles,
        startTime: row.start_ts,
        endTime: row.end_ts,
        currentPrice,
        deviationFromVwapPct: deviation,
        signal: deviation != null
          ? (deviation > 2 ? 'Above VWAP (potential resistance)'
            : deviation < -2 ? 'Below VWAP (potential support)'
            : 'Near VWAP (neutral)')
          : undefined,
      };
    }),
  );

  // ── Trade Journal Tools ─────────────────────────────────────

  server.tool(
    'get_trade_journal',
    `Query the trade journal for execution history. Filter by exchange, symbol, strategy, and time range. Returns individual trade records ordered by timestamp (newest first).`,
    {
      exchange: z.string().optional().describe('Filter by exchange ID'),
      symbol: z.string().optional().describe('Filter by trading pair (e.g., BTC/USDT)'),
      strategy: z.string().optional().describe('Filter by strategy/agent name'),
      since: z.string().optional().describe('Start date (ISO 8601, e.g., "2024-01-01")'),
      limit: z.number().default(100).describe('Max trades to return'),
    } as any,
    handler(async (params: any) => {
      const journal = (client as any).journal as TradeJournal | undefined;
      if (!journal) throw new Error('Trade journal not configured.');

      const sinceTs = params.since ? new Date(params.since).getTime() : undefined;

      const trades = await journal.query({
        exchange: params.exchange,
        symbol: params.symbol,
        strategy: params.strategy,
        since: sinceTs,
        limit: params.limit,
      });

      return {
        exchange: client.exchangeId,
        count: trades.length,
        trades,
      };
    }),
  );

  server.tool(
    'get_pnl_report',
    `P&L summary from the trade journal. Computes realized P&L, buy/sell volume, total fees, and traded symbols. Filter by exchange, symbol, strategy, and time range.`,
    {
      exchange: z.string().optional().describe('Filter by exchange ID'),
      symbol: z.string().optional().describe('Filter by trading pair (e.g., BTC/USDT)'),
      strategy: z.string().optional().describe('Filter by strategy/agent name'),
      since: z.string().optional().describe('Start date (ISO 8601, e.g., "2024-01-01")'),
    } as any,
    handler(async (params: any) => {
      const journal = (client as any).journal as TradeJournal | undefined;
      if (!journal) throw new Error('Trade journal not configured.');

      const sinceTs = params.since ? new Date(params.since).getTime() : undefined;

      const report = await journal.pnl({
        exchange: params.exchange,
        symbol: params.symbol,
        strategy: params.strategy,
        since: sinceTs,
      });

      return {
        exchange: client.exchangeId,
        ...report,
      };
    }),
  );

  server.tool(
    'backtest_strategy',
    `Run a simple moving average crossover backtest on cached DuckDB data. Buys when fast SMA crosses above slow SMA, sells when fast crosses below. Returns trade list, equity curve, and performance stats (Sharpe, Sortino, max drawdown, win rate, profit factor).`,
    {
      symbol: z.string().describe('Trading pair (e.g., BTC/USDT)'),
      timeframe: z.string().default('1d').describe('Candle timeframe (1m, 5m, 15m, 1h, 4h, 1d)'),
      fast_period: z.number().default(10).describe('Fast MA period'),
      slow_period: z.number().default(30).describe('Slow MA period'),
      initial_capital: z.number().default(10000).describe('Starting capital in quote currency'),
      position_size_pct: z.number().default(1.0).describe('Fraction of capital to use per trade (0-1)'),
    } as any,
    handler(async (params: any) => {
      if (!store) throw new Error('DuckDB datastore not configured. Restart with data caching enabled.');

      const fastPeriod: number = params.fast_period;
      const slowPeriod: number = params.slow_period;
      if (fastPeriod >= slowPeriod) {
        throw new Error(`fast_period (${fastPeriod}) must be less than slow_period (${slowPeriod})`);
      }

      const candles = await store.query({
        symbol: params.symbol,
        interval: params.timeframe,
        exchange: client.exchangeId,
        limit: 10000, // fetch as much as available
      });

      if (candles.length < slowPeriod + 1) {
        throw new Error(`Insufficient cached data (${candles.length} candles, need at least ${slowPeriod + 1}). Run ingest_history first.`);
      }

      const closes = candles.map((c: any) => c.close);

      // Compute SMAs
      const fastSma = sma(closes, fastPeriod);
      const slowSma = sma(closes, slowPeriod);

      // Align: slowSma starts at index (slowPeriod - 1) in closes
      // fastSma starts at index (fastPeriod - 1) in closes
      // We need both to exist, so start at (slowPeriod - 1)
      const startIdx = slowPeriod - 1;

      // Simulate trades
      const trades: { type: string; price: number; bar: number; pnl?: number; pnlPct?: number }[] = [];
      let capital = params.initial_capital as number;
      const positionSizePct = params.position_size_pct as number;
      let inPosition = false;
      let entryPrice = 0;
      let entryCapital = 0;
      const equityCurve: number[] = [capital];

      for (let i = startIdx + 1; i < closes.length; i++) {
        // fastSma index: i - (fastPeriod - 1)
        // slowSma index: i - (slowPeriod - 1)
        const fastIdx = i - (fastPeriod - 1);
        const slowIdx = i - (slowPeriod - 1);
        const prevFastIdx = fastIdx - 1;
        const prevSlowIdx = slowIdx - 1;

        if (prevFastIdx < 0 || prevSlowIdx < 0) continue;

        const fastNow = fastSma[fastIdx];
        const slowNow = slowSma[slowIdx];
        const fastPrev = fastSma[prevFastIdx];
        const slowPrev = slowSma[prevSlowIdx];

        // Buy signal: fast crosses above slow
        if (!inPosition && fastPrev <= slowPrev && fastNow > slowNow) {
          entryPrice = closes[i];
          entryCapital = capital * positionSizePct;
          inPosition = true;
          trades.push({ type: 'buy', price: Math.round(entryPrice * 100) / 100, bar: i });
        }
        // Sell signal: fast crosses below slow
        else if (inPosition && fastPrev >= slowPrev && fastNow < slowNow) {
          const exitPrice = closes[i];
          const pnl = entryCapital * ((exitPrice - entryPrice) / entryPrice);
          const pnlPct = ((exitPrice - entryPrice) / entryPrice) * 100;
          capital += pnl;
          inPosition = false;
          trades.push({
            type: 'sell',
            price: Math.round(exitPrice * 100) / 100,
            bar: i,
            pnl: Math.round(pnl * 100) / 100,
            pnlPct: Math.round(pnlPct * 100) / 100,
          });
          equityCurve.push(Math.round(capital * 100) / 100);
        }
      }

      // Close open position at last bar
      if (inPosition) {
        const exitPrice = closes[closes.length - 1];
        const pnl = entryCapital * ((exitPrice - entryPrice) / entryPrice);
        const pnlPct = ((exitPrice - entryPrice) / entryPrice) * 100;
        capital += pnl;
        trades.push({
          type: 'sell',
          price: Math.round(exitPrice * 100) / 100,
          bar: closes.length - 1,
          pnl: Math.round(pnl * 100) / 100,
          pnlPct: Math.round(pnlPct * 100) / 100,
        });
        equityCurve.push(Math.round(capital * 100) / 100);
      }

      // Compute stats from trade P&Ls
      const tradePnls = trades
        .filter(t => t.type === 'sell' && t.pnl != null)
        .map(t => t.pnl as number);

      const winners = tradePnls.filter(p => p > 0).length;
      const losers = tradePnls.filter(p => p <= 0).length;
      const totalTrades = tradePnls.length;

      // Compute returns series from equity curve for Sharpe/Sortino
      const equityReturns = returns(equityCurve);
      const dd = maxDrawdown(equityCurve);
      const totalReturn = ((capital - params.initial_capital) / params.initial_capital) * 100;

      return {
        symbol: params.symbol,
        timeframe: params.timeframe,
        fastPeriod,
        slowPeriod,
        totalBars: closes.length,
        trades,
        totalTrades,
        winners,
        losers,
        winRate: totalTrades > 0 ? Math.round(winRate(tradePnls) * 1000) / 1000 : 0,
        profitFactor: totalTrades > 0 ? Math.round(profitFactor(tradePnls) * 100) / 100 : 0,
        totalReturn: Math.round(totalReturn * 100) / 100,
        sharpe: equityReturns.length > 1 ? Math.round(sharpeRatio(equityReturns) * 100) / 100 : 0,
        sortino: equityReturns.length > 1 ? Math.round(sortinoRatio(equityReturns) * 100) / 100 : 0,
        maxDrawdown: Math.round(dd.maxDrawdown * 10000) / 100,
        initialCapital: params.initial_capital,
        finalCapital: Math.round(capital * 100) / 100,
        equityCurve,
      };
    }),
  );

  // ── Correlation Regime Detection ──────────────────────────

  server.tool(
    'detect_correlation_regime',
    `Rolling correlation with regime change detection between two symbols. Computes rolling correlation over a sliding window, detects regime transitions (decorrelation events, sign flips), and classifies the current regime. Essential for pairs trading and dynamic hedging.`,
    {
      symbol_a: z.string().describe('First trading pair (e.g., BTC/USDT)'),
      symbol_b: z.string().describe('Second trading pair (e.g., ETH/USDT)'),
      timeframe: z.string().default('1d').describe('Candle timeframe'),
      window: z.number().default(30).describe('Rolling correlation window size'),
      lookback: z.number().default(200).describe('Total number of bars to analyze'),
    } as any,
    handler(async (params: any) => {
      if (!store) throw new Error('DuckDB datastore not configured. Restart with data caching enabled.');

      const window: number = params.window;
      const lookback: number = params.lookback;

      // Fetch candles for both symbols
      const candlesA = await store.query({
        symbol: params.symbol_a,
        interval: params.timeframe,
        exchange: client.exchangeId,
        limit: lookback,
      });
      const candlesB = await store.query({
        symbol: params.symbol_b,
        interval: params.timeframe,
        exchange: client.exchangeId,
        limit: lookback,
      });

      if (candlesA.length < window + 1) {
        throw new Error(`Insufficient cached data for ${params.symbol_a} (${candlesA.length} candles, need ${window + 1}). Run ingest_history first.`);
      }
      if (candlesB.length < window + 1) {
        throw new Error(`Insufficient cached data for ${params.symbol_b} (${candlesB.length} candles, need ${window + 1}). Run ingest_history first.`);
      }

      const closesA = candlesA.map((c: any) => c.close);
      const closesB = candlesB.map((c: any) => c.close);

      // Align to same length
      const minLen = Math.min(closesA.length, closesB.length);
      const alignedA = closesA.slice(closesA.length - minLen);
      const alignedB = closesB.slice(closesB.length - minLen);

      const returnsA = returns(alignedA);
      const returnsB = returns(alignedB);

      // Compute rolling correlation
      const rollingCorr: { index: number; correlation: number }[] = [];
      for (let i = window - 1; i < returnsA.length; i++) {
        const sliceA = returnsA.slice(i - window + 1, i + 1);
        const sliceB = returnsB.slice(i - window + 1, i + 1);
        const corr = correlation(sliceA, sliceB);
        rollingCorr.push({ index: i, correlation: Math.round(corr * 1000) / 1000 });
      }

      // Detect regime transitions: zero crossings and sign flips
      const transitions: { index: number; from: number; to: number; type: string }[] = [];
      for (let i = 1; i < rollingCorr.length; i++) {
        const prev = rollingCorr[i - 1].correlation;
        const curr = rollingCorr[i].correlation;
        if ((prev >= 0 && curr < 0) || (prev < 0 && curr >= 0)) {
          transitions.push({
            index: rollingCorr[i].index,
            from: prev,
            to: curr,
            type: prev >= 0 && curr < 0 ? 'decorrelation' : 'recorrelation',
          });
        }
      }

      // Classify current regime
      const currentCorr = rollingCorr.length > 0
        ? rollingCorr[rollingCorr.length - 1].correlation
        : 0;

      let currentRegime: string;
      if (currentCorr > 0.7) currentRegime = 'highly_correlated';
      else if (currentCorr > 0.3) currentRegime = 'moderately_correlated';
      else if (currentCorr >= -0.3) currentRegime = 'uncorrelated';
      else currentRegime = 'inversely_correlated';

      // Average correlation
      const avgCorr = rollingCorr.length > 0
        ? Math.round(mean(rollingCorr.map(r => r.correlation)) * 1000) / 1000
        : 0;

      // Sample the rolling series to avoid huge payloads (max ~50 points)
      const step = Math.max(1, Math.floor(rollingCorr.length / 50));
      const sampled = rollingCorr.filter((_, i) => i % step === 0 || i === rollingCorr.length - 1);

      return {
        symbolA: params.symbol_a,
        symbolB: params.symbol_b,
        timeframe: params.timeframe,
        window,
        dataPoints: rollingCorr.length,
        currentCorrelation: currentCorr,
        currentRegime,
        averageCorrelation: avgCorr,
        transitions,
        rollingSeries: sampled,
      };
    }),
  );

  // ── Export to Parquet ──────────────────────────────────────

  server.tool(
    'export_to_parquet',
    `Export cached market data to a Parquet file for external analysis (Python, R, DuckDB CLI). Filters by symbol, timeframe, and exchange before writing.`,
    {
      symbol: z.string().describe('Trading pair to export (e.g., BTC/USDT)'),
      timeframe: z.string().default('1d').describe('Candle timeframe to export'),
      output_path: z.string().optional().describe('Output file path (default: .desk/exports/{symbol}_{timeframe}.parquet)'),
    } as any,
    handler(async (params: any) => {
      if (!store) throw new Error('DuckDB datastore not configured. Restart with data caching enabled.');

      // Validate inputs to prevent SQL injection (exportParquet uses raw SQL in COPY)
      const symbolPattern = /^[A-Za-z0-9]+\/[A-Za-z0-9]+$/;
      const timeframePattern = /^[0-9]+[smhdwMy]$/;
      if (!symbolPattern.test(params.symbol)) {
        throw new Error(`Invalid symbol format: ${params.symbol}. Expected format: BASE/QUOTE (e.g., BTC/USDT)`);
      }
      if (!timeframePattern.test(params.timeframe)) {
        throw new Error(`Invalid timeframe format: ${params.timeframe}. Expected format like 1m, 5m, 1h, 1d`);
      }

      const safeSymbol = params.symbol.replace(/\//g, '-');
      const outputPath: string = params.output_path
        ?? `.desk/exports/${safeSymbol}_${params.timeframe}.parquet`;

      // exchangeId is server-controlled (not user input), symbol/timeframe validated above
      const query = `SELECT * FROM ohlcv WHERE symbol = '${params.symbol}' AND interval = '${params.timeframe}' AND exchange = '${client.exchangeId}'`;

      await store.exportParquet(query, outputPath);

      // Get row count for confirmation
      const countRows = await store.sql(
        `SELECT COUNT(*) as cnt FROM ohlcv WHERE symbol = ? AND interval = ? AND exchange = ?`,
        [params.symbol, params.timeframe, client.exchangeId],
      );
      const rowCount = countRows[0]?.cnt ?? 0;

      return {
        symbol: params.symbol,
        timeframe: params.timeframe,
        exchange: client.exchangeId,
        outputPath,
        rowCount,
      };
    }),
  );

  // ── Tick-Level Trade Ingestion ─────────────────────────────

  server.tool(
    'ingest_recent_trades',
    `Fetch recent public trades from ${client.name} and store as 1-second OHLCV candles in the local DuckDB cache. Each second of trade activity becomes one candle (open=first price, close=last price, volume=sum). Useful for tick-level analysis and microstructure research.`,
    {
      symbol: z.string().describe('Trading pair (e.g., BTC/USDT)'),
      limit: z.number().default(500).describe('Max trades to fetch from the exchange'),
    } as any,
    handler(async (params: any) => {
      if (!store) throw new Error('DuckDB datastore not configured. Restart with data caching enabled.');

      const trades = await client.getTrades(params.symbol, undefined, params.limit);
      if (trades.length === 0) {
        return { exchange: client.exchangeId, symbol: params.symbol, tradesFetched: 0, secondsStored: 0 };
      }

      // Group trades by second (floor timestamp to nearest 1000ms)
      const buckets = new Map<number, typeof trades>();
      for (const t of trades) {
        if (t.timestamp == null) continue;
        const sec = Math.floor(t.timestamp / 1000) * 1000;
        let bucket = buckets.get(sec);
        if (!bucket) {
          bucket = [];
          buckets.set(sec, bucket);
        }
        bucket.push(t);
      }

      // Convert each second-bucket into an OHLCV row
      const rows: OHLCVRow[] = [];
      for (const [sec, bucket] of buckets) {
        const prices = bucket.map(t => t.price);
        const volumes = bucket.map(t => t.amount);
        rows.push({
          symbol: params.symbol,
          exchange: client.exchangeId,
          asset_type: 'crypto',
          interval: '1s',
          ts: new Date(sec),
          open: prices[0],
          high: Math.max(...prices),
          low: Math.min(...prices),
          close: prices[prices.length - 1],
          volume: volumes.reduce((s, v) => s + v, 0),
        });
      }

      const inserted = await store.insertOHLCV(rows);

      // Compute time range
      const timestamps = [...buckets.keys()].sort((a, b) => a - b);
      return {
        exchange: client.exchangeId,
        symbol: params.symbol,
        tradesFetched: trades.length,
        secondsStored: inserted,
        timeRange: {
          from: new Date(timestamps[0]).toISOString(),
          to: new Date(timestamps[timestamps.length - 1]).toISOString(),
        },
      };
    }),
  );

  // ── P&L Attribution ───────────────────────────────────────

  server.tool(
    'get_pnl_attribution',
    `Detailed P&L attribution from the trade journal. Group realized P&L by symbol, strategy, calendar day, or hour of day. Essential for identifying which pairs, agents, or time windows drive performance.`,
    {
      group_by: z.enum(['symbol', 'strategy', 'day', 'hour']).default('symbol').describe('Dimension to group P&L by'),
      since: z.string().optional().describe('Start date (ISO 8601, e.g., "2024-01-01")'),
    } as any,
    handler(async (params: any) => {
      const journal = (client as any).journal as TradeJournal | undefined;
      if (!journal) throw new Error('Trade journal not configured.');

      const groupBy: string = params.group_by;
      const sinceClause = params.since
        ? `WHERE timestamp >= ${new Date(params.since).getTime()}`
        : '';

      let sql: string;
      switch (groupBy) {
        case 'symbol':
          sql = `SELECT symbol as dimension, SUM(CASE WHEN side = 'sell' THEN cost ELSE -cost END) as pnl, SUM(COALESCE(fee, 0)) as fees, COUNT(*) as trades FROM trades ${sinceClause} GROUP BY symbol ORDER BY pnl DESC`;
          break;
        case 'strategy':
          sql = `SELECT COALESCE(strategy, 'unknown') as dimension, SUM(CASE WHEN side = 'sell' THEN cost ELSE -cost END) as pnl, SUM(COALESCE(fee, 0)) as fees, COUNT(*) as trades FROM trades ${sinceClause} GROUP BY strategy ORDER BY pnl DESC`;
          break;
        case 'day':
          sql = `SELECT CAST(epoch_ms(timestamp) AS DATE) as dimension, SUM(CASE WHEN side = 'sell' THEN cost ELSE -cost END) as pnl, SUM(COALESCE(fee, 0)) as fees, COUNT(*) as trades FROM trades ${sinceClause} GROUP BY CAST(epoch_ms(timestamp) AS DATE) ORDER BY pnl DESC`;
          break;
        case 'hour':
          sql = `SELECT EXTRACT(HOUR FROM epoch_ms(timestamp)) as dimension, SUM(CASE WHEN side = 'sell' THEN cost ELSE -cost END) as pnl, SUM(COALESCE(fee, 0)) as fees, COUNT(*) as trades FROM trades ${sinceClause} GROUP BY EXTRACT(HOUR FROM epoch_ms(timestamp)) ORDER BY pnl DESC`;
          break;
        default:
          throw new Error(`Invalid group_by: ${groupBy}. Use symbol, strategy, day, or hour.`);
      }

      const rows = await journal.sql(sql);

      return {
        exchange: client.exchangeId,
        groupBy,
        since: params.since ?? null,
        rows,
      };
    }),
  );
}
