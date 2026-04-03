/* eslint-disable @typescript-eslint/no-explicit-any */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ExchangeClient } from '../client/exchange';
import { handler } from './handler';
import {
  simulateOrderBookFill,
  analyzeDepthAtBands,
  analyzeTradeFlow,
  recommendEntry,
} from '@ai-fund/lib/execution-analytics';
import { computeDcaSchedule, optimizeGridParams, analyzeBasisTrade } from '@ai-fund/lib/grid-trading';

export function registerStrategyEntryTools(server: McpServer, client: ExchangeClient) {
  server.tool(
    'get_optimal_entry',
    `Analyze order book depth, spread, and recent trade flow on ${client.name} to recommend optimal entry strategy for a trade. Returns recommended order type, price, estimated slippage, and trade flow signal.`,
    {
      symbol: z.string().describe('Trading pair (e.g., BTC/USDT)'),
      side: z.enum(['buy', 'sell']).describe('Trade side'),
      amount: z.number().describe('Desired position size in base currency'),
      urgency: z.enum(['low', 'medium', 'high']).default('medium').describe('How urgently the order needs to fill'),
    } as any,
    handler(async (params: any) => {
      const [orderBook, quote, recentTrades] = await Promise.all([
        client.getOrderBook(params.symbol, 20),
        client.getQuote(params.symbol),
        client.getTrades(params.symbol, undefined, 100),
      ]);

      const mid = orderBook.mid;
      if (mid == null || mid === 0) {
        throw new Error(`Cannot determine mid price for ${params.symbol} — order book may be empty`);
      }

      const currentSpread = orderBook.spread ?? 0;
      const spreadBps = orderBook.spreadBps ?? 0;
      const bestBid = orderBook.bestBid ?? mid;
      const bestAsk = orderBook.bestAsk ?? mid;

      // Estimate slippage by walking the order book
      const book = params.side === 'buy' ? orderBook.asks : orderBook.bids;
      const fillSim = simulateOrderBookFill(book, params.amount, mid);

      // Depth analysis: total liquidity within 0.1% of mid on each side
      const depthBands = analyzeDepthAtBands(orderBook.bids, orderBook.asks, mid, [0.001]);
      const depth01 = depthBands['0.1%'];

      // Trade flow analysis: buy/sell imbalance from recent trades
      const tradeEntries = recentTrades.map(t => ({
        side: t.side as 'buy' | 'sell',
        amount: t.amount,
      }));
      const flow = analyzeTradeFlow(tradeEntries);
      const totalVolume = flow.buyVolume + flow.sellVolume;
      const buyRatio = totalVolume > 0 ? flow.buyVolume / totalVolume : 0.5;
      const tradeFlowSignal: 'bullish' | 'bearish' | 'neutral' =
        buyRatio > 0.6 ? 'bullish' : buyRatio < 0.4 ? 'bearish' : 'neutral';

      // Urgency-based recommendation
      const rec = recommendEntry(
        params.side, mid, bestBid, bestAsk,
        currentSpread, spreadBps, fillSim.slippagePct, params.urgency,
      );

      return {
        symbol: params.symbol,
        side: params.side,
        amount: params.amount,
        currentMid: Math.round(mid * 100) / 100,
        currentSpread: Math.round(currentSpread * 100) / 100,
        spreadBps: Math.round(spreadBps * 100) / 100,
        recommendedOrderType: rec.orderType,
        recommendedPrice: rec.price,
        estimatedSlippage: {
          pct: Math.round(fillSim.slippagePct * 1000000) / 1000000,
          absolutePerUnit: fillSim.slippagePerUnit,
        },
        depthAnalysis: {
          bidDepth01Pct: depth01.bidDepth,
          askDepth01Pct: depth01.askDepth,
        },
        tradeFlowSignal,
        tradeFlowImbalance: Math.round(buyRatio * 10000) / 10000,
        rationale: rec.rationale,
      };
    }),
  );

  server.tool(
    'get_funding_rates',
    `Fetch funding rates for perpetual contracts on ${client.name}. Returns current funding rate, annualized rate, mark/index prices, and next funding time. Essential for carry trade and basis trade strategies.`,
    {
      symbols: z.string().describe('Comma-separated perpetual symbols (e.g., BTC/USDT:USDT,ETH/USDT:USDT)'),
    } as any,
    handler(async (params: any) => {
      const symbolList = params.symbols.split(',').map((s: string) => s.trim());
      const exchange = (client as any).exchange;
      await client.ensureMarkets();

      const rates: any[] = [];
      for (const symbol of symbolList) {
        try {
          if (typeof exchange.fetchFundingRate === 'function') {
            const fr = await exchange.fetchFundingRate(symbol);
            rates.push({
              symbol,
              fundingRate: fr.fundingRate,
              fundingRateAnnualized: fr.fundingRate != null ? Math.round(fr.fundingRate * 365 * 3 * 10000) / 100 : null,
              nextFundingTime: fr.fundingTimestamp || fr.nextFundingTimestamp,
              markPrice: fr.markPrice,
              indexPrice: fr.indexPrice,
              interestRate: fr.interestRate,
            });
          } else {
            rates.push({ symbol, error: 'Exchange does not support fetchFundingRate' });
          }
        } catch (err: any) {
          rates.push({ symbol, error: err.message });
        }
      }

      return rates;
    }),
  );

  server.tool(
    'detect_basis_trade',
    `Detect spot vs perpetual basis trade opportunities on ${client.name}. Compares spot and perp prices, computes basis, funding rate carry, and net annualized return after fees. The core profit engine for crypto market makers.`,
    {
      base: z.string().describe('Base asset (e.g., BTC)'),
      quote: z.string().describe('Quote asset (e.g., USDT)'),
    } as any,
    handler(async (params: any) => {
      const spotSymbol = `${params.base}/${params.quote}`;
      const perpSymbol = `${params.base}/${params.quote}:${params.quote}`;

      // Fetch spot and perp tickers
      let spotPrice: number;
      let perpPrice: number;
      try {
        const spotTicker = await client.getTicker(spotSymbol);
        const sp = spotTicker.last ?? spotTicker.bid;
        if (sp == null) throw new Error('No spot price available');
        spotPrice = sp;
      } catch (err: any) {
        throw new Error(`Cannot fetch spot price for ${spotSymbol}: ${err.message}`);
      }

      try {
        const perpTicker = await client.getTicker(perpSymbol);
        const pp = perpTicker.last ?? perpTicker.bid;
        if (pp == null) throw new Error('No perp price available');
        perpPrice = pp;
      } catch (err: any) {
        throw new Error(`Cannot fetch perp price for ${perpSymbol}: ${err.message}`);
      }

      // Try to get funding rate
      let fundingRate: number | null = null;
      try {
        const exchange = (client as any).exchange;
        if (typeof exchange.fetchFundingRate === 'function') {
          const fr = await exchange.fetchFundingRate(perpSymbol);
          fundingRate = fr.fundingRate ?? null;
        }
      } catch {
        // Funding rate unavailable — proceed without it
      }

      const result = analyzeBasisTrade({
        spotPrice,
        perpPrice,
        fundingRate,
      });

      // Map lib signal text to legacy format for backward compatibility
      const net = result.netCarryAnnualized;
      let signal: string;
      if (net > 5) {
        signal = 'Strong positive carry \u2014 long spot, short perp';
      } else if (net > 1) {
        signal = 'Moderate positive carry \u2014 long spot, short perp';
      } else if (net < -5) {
        signal = 'Strong negative carry \u2014 short spot, long perp (or avoid)';
      } else if (net < -1) {
        signal = 'Moderate negative carry \u2014 short spot, long perp (or avoid)';
      } else {
        signal = 'Negligible carry \u2014 not actionable after fees';
      }

      return {
        base: params.base,
        quote: params.quote,
        spotSymbol,
        perpSymbol,
        spotPrice: Math.round(spotPrice * 100) / 100,
        perpPrice: Math.round(perpPrice * 100) / 100,
        basis: Math.round(result.basis * 1000) / 1000,
        basisAnnualized: Math.round(result.basisAnnualized * 10) / 10,
        fundingRate,
        fundingRateAnnualized: result.fundingRateAnnualized != null ? Math.round(result.fundingRateAnnualized * 100) / 100 : null,
        totalCarryAnnualized: Math.round(result.totalCarryAnnualized * 100) / 100,
        estimatedFees: result.estimatedFees,
        netCarryAnnualized: Math.round(result.netCarryAnnualized * 100) / 100,
        signal,
        actionable: result.actionable,
      };
    }),
  );

  server.tool(
    'calculate_dca_schedule',
    `Smart DCA (dollar-cost averaging) schedule with optional volatility-adjusted sizing on ${client.name}. Allocates more when volatility is low and less when it is high.`,
    {
      symbol: z.string().describe('Trading pair (e.g., BTC/USDT)'),
      total_amount: z.number().describe('Total amount to invest in quote currency'),
      num_orders: z.number().default(10).describe('Number of DCA orders'),
      timeframe: z.string().default('1d').describe('Timeframe for volatility calculation'),
      vol_adjust: z.boolean().default(true).describe('Scale order sizes inversely with volatility'),
    } as any,
    handler(async (params: any) => {
      const numOrders = params.num_orders ?? 10;
      const totalAmount = params.total_amount;

      if (totalAmount <= 0) {
        throw new Error('total_amount must be positive');
      }
      if (numOrders < 2) {
        throw new Error('num_orders must be at least 2');
      }

      // Fetch bars for volatility estimation
      const bars = await client.getBars(params.symbol, params.timeframe ?? '1d', undefined, Math.max(numOrders + 20, 50));
      if (bars.length < numOrders + 1) {
        throw new Error(`Insufficient data: got ${bars.length} bars, need at least ${numOrders + 1}`);
      }

      const closes = bars.map((b: any) => b.close);
      const currentPrice = closes[closes.length - 1];

      const dcaOrders = computeDcaSchedule({
        totalAmount,
        numOrders,
        currentPrice,
        closes,
        volAdjust: params.vol_adjust !== false,
      });

      const schedule = dcaOrders.map(o => ({
        order_number: o.orderNumber,
        amount_quote: Math.round(o.amountQuote * 100) / 100,
        estimated_amount_base: Math.round(o.estimatedAmountBase * 100000000) / 100000000,
        size_reason: o.sizeReason.charAt(0).toUpperCase() + o.sizeReason.slice(1),
      }));

      return {
        symbol: params.symbol,
        totalAmount,
        numOrders,
        currentPrice: Math.round(currentPrice * 100) / 100,
        volAdjust: params.vol_adjust !== false,
        schedule,
      };
    }),
  );

  // ── optimize_grid_params ──────────────────────────────────

  server.tool(
    'optimize_grid_params',
    `Optimize grid trading parameters for a symbol on ${client.name}. Uses Bollinger Bands for price range and ATR for grid spacing. Returns grid levels, spacing, expected daily trades, and volatility regime.`,
    {
      symbol: z.string().describe('Trading pair (e.g., BTC/USDT)'),
      timeframe: z.string().default('4h').describe('Candle timeframe (default 4h)'),
      period: z.number().default(100).describe('Number of candles to analyze (default 100)'),
      num_grids: z.number().default(10).describe('Number of grid levels (default 10)'),
    } as any,
    handler(async (params: any) => {
      const symbol: string = params.symbol;
      const timeframe: string = params.timeframe ?? '4h';
      const period: number = params.period ?? 100;
      const numGrids: number = params.num_grids ?? 10;

      const bars = await client.getBars(symbol, timeframe, undefined, period);
      if (bars.length < 26) {
        throw new Error(`Need at least 26 candles for grid optimization, got ${bars.length}`);
      }

      const candles = bars.map(b => ({
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
        volume: b.volume,
      }));

      const grid = optimizeGridParams(candles, numGrids);

      // Map grid levels to the existing output shape.
      // The lib produces numGrids+1 boundary levels; the tool originally
      // produced exactly numGrids levels at cell midpoints, so we trim
      // to the first numGrids entries for backward compatibility.
      const gridLevels = grid.levels.slice(0, numGrids).map(l => ({
        price: Math.round(l.price * 100) / 100,
        side: l.side,
        amount: Math.round(l.amount * 100000000) / 100000000,
      }));

      return {
        symbol,
        priceRange: {
          high: grid.priceRange.high,
          low: grid.priceRange.low,
          current: grid.priceRange.current,
          bbUpper: Math.round(grid.priceRange.bbUpper * 100) / 100,
          bbLower: Math.round(grid.priceRange.bbLower * 100) / 100,
        },
        gridLevels,
        spacing: Math.round(grid.spacing * 100) / 100,
        atrBased: {
          currentAtr: Math.round(grid.atr.current * 100) / 100,
          avgAtr: Math.round(grid.atr.average * 100) / 100,
          atrRatio: Math.round(grid.atr.ratio * 100) / 100,
        },
        expectedDailyTrades: grid.expectedDailyTrades,
        volRegime: grid.volRegime,
      };
    }),
  );
}
