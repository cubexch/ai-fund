/* eslint-disable @typescript-eslint/no-explicit-any */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ExchangeClient } from '../client/exchange';
import { handler } from './handler';
import {
  bollingerBands, atr,
  type OHLCV,
} from '@ai-fund/lib/indicators';
import {
  returns, standardDeviation,
} from '@ai-fund/lib/math';

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
      let filled = 0;
      let totalCost = 0;
      for (const [price, size] of book) {
        const fill = Math.min(size, params.amount - filled);
        totalCost += fill * price;
        filled += fill;
        if (filled >= params.amount) break;
      }

      const avgFillPrice = filled > 0 ? totalCost / filled : mid;
      const slippagePct = Math.abs(avgFillPrice - mid) / mid;
      const slippagePerUnit = Math.abs(avgFillPrice - mid);

      // Depth analysis: total liquidity within 0.1% of mid on each side
      const depthThreshold = mid * 0.001;
      let bidDepth01Pct = 0;
      for (const [price, size] of orderBook.bids) {
        if (price >= mid - depthThreshold) {
          bidDepth01Pct += size;
        } else {
          break;
        }
      }
      let askDepth01Pct = 0;
      for (const [price, size] of orderBook.asks) {
        if (price <= mid + depthThreshold) {
          askDepth01Pct += size;
        } else {
          break;
        }
      }

      // Trade flow analysis: buy/sell imbalance from recent trades
      let buyVolume = 0;
      let sellVolume = 0;
      for (const trade of recentTrades) {
        if (trade.side === 'buy') {
          buyVolume += trade.amount;
        } else {
          sellVolume += trade.amount;
        }
      }
      const totalVolume = buyVolume + sellVolume;
      const buyRatio = totalVolume > 0 ? buyVolume / totalVolume : 0.5;
      const tradeFlowSignal: 'bullish' | 'bearish' | 'neutral' =
        buyRatio > 0.6 ? 'bullish' : buyRatio < 0.4 ? 'bearish' : 'neutral';

      // Urgency-based recommendation
      const tickSize = currentSpread > 0 ? currentSpread * 0.1 : mid * 0.0001;
      let recommendedOrderType: 'limit' | 'market';
      let recommendedPrice: number | null;
      let rationale: string;

      if (params.urgency === 'low') {
        recommendedOrderType = 'limit';
        recommendedPrice = params.side === 'buy'
          ? Math.round((bestBid + tickSize) * 100) / 100
          : Math.round((bestAsk - tickSize) * 100) / 100;
        rationale = `Low urgency: limit order near ${params.side === 'buy' ? 'bid' : 'ask'} to minimize cost; spread is ${spreadBps.toFixed(1)} bps`;
      } else if (params.urgency === 'medium') {
        recommendedOrderType = 'limit';
        recommendedPrice = Math.round(mid * 100) / 100;
        rationale = `Medium urgency: limit at mid price (${recommendedPrice}) balances fill probability and cost`;
      } else {
        recommendedOrderType = 'market';
        recommendedPrice = null;
        rationale = `High urgency: market order for immediate fill; expected slippage ${(slippagePct * 100).toFixed(3)}%`;
      }

      return {
        symbol: params.symbol,
        side: params.side,
        amount: params.amount,
        currentMid: Math.round(mid * 100) / 100,
        currentSpread: Math.round(currentSpread * 100) / 100,
        spreadBps: Math.round(spreadBps * 100) / 100,
        recommendedOrderType,
        recommendedPrice,
        estimatedSlippage: {
          pct: Math.round(slippagePct * 1000000) / 1000000,
          absolutePerUnit: Math.round(slippagePerUnit * 100) / 100,
        },
        depthAnalysis: {
          bidDepth01Pct: Math.round(bidDepth01Pct * 100000000) / 100000000,
          askDepth01Pct: Math.round(askDepth01Pct * 100000000) / 100000000,
        },
        tradeFlowSignal,
        tradeFlowImbalance: Math.round(buyRatio * 10000) / 10000,
        rationale,
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

      // Basis calculation
      const basis = (perpPrice - spotPrice) / spotPrice * 100;
      const basisAnnualized = basis * 365;

      // Try to get funding rate
      let fundingRate: number | null = null;
      let fundingRateAnnualized: number | null = null;
      try {
        const exchange = (client as any).exchange;
        if (typeof exchange.fetchFundingRate === 'function') {
          const fr = await exchange.fetchFundingRate(perpSymbol);
          fundingRate = fr.fundingRate;
          if (fundingRate != null) {
            fundingRateAnnualized = fundingRate * 365 * 3 * 100;
          }
        }
      } catch {
        // Funding rate unavailable — proceed without it
      }

      const totalCarryAnnualized = basisAnnualized + (fundingRateAnnualized ?? 0);
      const estimatedFees = 0.2; // 0.1% round-trip per side (spot + perp)
      const netCarryAnnualized = totalCarryAnnualized - estimatedFees;

      // Determine signal
      let signal: string;
      const actionable = Math.abs(netCarryAnnualized) > 1;
      if (netCarryAnnualized > 5) {
        signal = 'Strong positive carry \u2014 long spot, short perp';
      } else if (netCarryAnnualized > 1) {
        signal = 'Moderate positive carry \u2014 long spot, short perp';
      } else if (netCarryAnnualized < -5) {
        signal = 'Strong negative carry \u2014 short spot, long perp (or avoid)';
      } else if (netCarryAnnualized < -1) {
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
        basis: Math.round(basis * 1000) / 1000,
        basisAnnualized: Math.round(basisAnnualized * 10) / 10,
        fundingRate,
        fundingRateAnnualized: fundingRateAnnualized != null ? Math.round(fundingRateAnnualized * 100) / 100 : null,
        totalCarryAnnualized: Math.round(totalCarryAnnualized * 100) / 100,
        estimatedFees,
        netCarryAnnualized: Math.round(netCarryAnnualized * 100) / 100,
        signal,
        actionable,
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

      let schedule: { order_number: number; amount_quote: number; estimated_amount_base: number; size_reason: string }[];

      if (params.vol_adjust !== false) {
        // Compute rolling volatility for the last numOrders windows
        const windowSize = 10;
        const rollingVols: number[] = [];

        for (let i = 0; i < numOrders; i++) {
          const startIdx = closes.length - numOrders - windowSize + i;
          const endIdx = startIdx + windowSize + 1;
          if (startIdx < 0 || endIdx > closes.length) {
            // Fallback: use overall vol
            const allRets = returns(closes);
            rollingVols.push(standardDeviation(allRets));
          } else {
            const windowCloses = closes.slice(startIdx, endIdx);
            const windowRets = returns(windowCloses);
            const vol = standardDeviation(windowRets);
            rollingVols.push(vol);
          }
        }

        // Inverse volatility weighting: weight = 1/vol, then normalize
        const inverseVols = rollingVols.map(v => v > 0 ? 1 / v : 1);
        const sumInverse = inverseVols.reduce((a, b) => a + b, 0);
        const weights = inverseVols.map(iv => iv / sumInverse);

        schedule = weights.map((w, i) => {
          const amountQuote = Math.round(totalAmount * w * 100) / 100;
          return {
            order_number: i + 1,
            amount_quote: amountQuote,
            estimated_amount_base: Math.round((amountQuote / currentPrice) * 100000000) / 100000000,
            size_reason: `Vol-adjusted: rolling vol ${Math.round(rollingVols[i] * 10000) / 10000}, weight ${Math.round(w * 10000) / 10000}`,
          };
        });
      } else {
        // Equal splits
        const equalAmount = Math.round((totalAmount / numOrders) * 100) / 100;
        schedule = [];
        for (let i = 0; i < numOrders; i++) {
          schedule.push({
            order_number: i + 1,
            amount_quote: equalAmount,
            estimated_amount_base: Math.round((equalAmount / currentPrice) * 100000000) / 100000000,
            size_reason: 'Equal split',
          });
        }
      }

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

      const candles: OHLCV[] = bars.map(b => ({
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
        volume: b.volume,
        timestamp: b.timestamp,
      }));
      const closes = candles.map(c => c.close);
      const highs = candles.map(c => c.high);
      const lows = candles.map(c => c.low);

      // Price range from raw high/low
      const priceHigh = Math.max(...highs);
      const priceLow = Math.min(...lows);
      const currentPrice = closes[closes.length - 1];

      // Bollinger Bands for expected trading range
      const bb = bollingerBands(closes, 20, 2);
      const bbUpper = bb.upper.length > 0 ? bb.upper[bb.upper.length - 1] : priceHigh;
      const bbLower = bb.lower.length > 0 ? bb.lower[bb.lower.length - 1] : priceLow;

      // ATR for grid spacing
      const atr14 = atr(candles, 14);
      const currentAtr = atr14.length > 0 ? atr14[atr14.length - 1] : (priceHigh - priceLow) / period;

      // Volatility regime classification
      const avgAtr = atr14.length > 0
        ? atr14.reduce((a, b) => a + b, 0) / atr14.length
        : currentAtr;
      const atrRatio = avgAtr > 0 ? currentAtr / avgAtr : 1;
      let volRegime: string;
      if (atrRatio > 1.5) volRegime = 'high';
      else if (atrRatio < 0.7) volRegime = 'low';
      else volRegime = 'normal';

      // Grid range: use Bollinger Bands
      const gridTop = Math.round(bbUpper * 100) / 100;
      const gridBottom = Math.round(bbLower * 100) / 100;
      const gridRange = gridTop - gridBottom;

      // ATR-based spacing: in low-vol tighter grids, in high-vol wider grids
      const spacing = Math.round((gridRange / numGrids) * 100) / 100;

      // Position sizing: equal capital per grid level
      // Assume $10,000 notional per grid for sizing reference
      const notionalPerGrid = 10000 / numGrids;

      // Build grid levels
      const gridLevels: { price: number; side: string; amount: number }[] = [];
      for (let i = 0; i < numGrids; i++) {
        const price = Math.round((gridBottom + spacing * i + spacing / 2) * 100) / 100;
        const side = price < currentPrice ? 'buy' : 'sell';
        const amount = Math.round((notionalPerGrid / price) * 100000000) / 100000000;
        gridLevels.push({ price, side, amount });
      }

      // Expected trades per day estimate: higher vol = more grid hits
      // Approximate from ATR as fraction of grid spacing
      const expectedDailyTrades = spacing > 0
        ? Math.round((currentAtr / spacing) * 100) / 100
        : 0;

      return {
        symbol,
        priceRange: {
          high: priceHigh,
          low: priceLow,
          current: currentPrice,
          bbUpper: gridTop,
          bbLower: gridBottom,
        },
        gridLevels,
        spacing,
        atrBased: {
          currentAtr: Math.round(currentAtr * 100) / 100,
          avgAtr: Math.round(avgAtr * 100) / 100,
          atrRatio: Math.round(atrRatio * 100) / 100,
        },
        expectedDailyTrades,
        volRegime,
      };
    }),
  );
}
