import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ExchangeClient } from '../client/exchange.js';
import { handler, authHandler } from './handler.js';
import {
  sma, ema, rsi, macd, bollingerBands, atr, adx, obv, stochastic,
  type OHLCV,
} from '../../../../../lib/indicators.js';
import {
  kelly, fixedFractionalSize,
  valueAtRisk, maxDrawdown, sharpeRatio, sortinoRatio,
  annualizedVolatility, returns, correlationMatrix, mean,
} from '../../../../../lib/math.js';

// Cast schemas to any to avoid TS2589 "excessively deep type instantiation" with zod + MCP SDK
/* eslint-disable @typescript-eslint/no-explicit-any */

export function registerStrategyTools(server: McpServer, client: ExchangeClient) {
  server.tool(
    'get_technical_analysis',
    `Run technical analysis on ${client.name} OHLCV data. Computes SMA, EMA, RSI, MACD, Bollinger Bands, ATR, ADX, OBV, and Stochastic. Essential for trading signals.`,
    {
      symbol: z.string().describe('Trading pair (e.g., BTC/USDT)'),
      timeframe: z.string().default('1d').describe('Candle timeframe (1m, 5m, 15m, 1h, 4h, 1d)'),
      limit: z.number().default(100).describe('Number of candles to analyze'),
    } as any,
    handler(async (params: any) => {
      const bars = await client.getBars(params.symbol, params.timeframe, undefined, params.limit);
      if (bars.length < 26) {
        throw new Error(`Need at least 26 candles for analysis, got ${bars.length}`);
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

      const sma20 = sma(closes, 20);
      const sma50 = sma(closes, 50);
      const ema12 = ema(closes, 12);
      const ema26 = ema(closes, 26);
      const rsi14 = rsi(closes, 14);
      const macdResult = macd(closes, 12, 26, 9);
      const bb = bollingerBands(closes, 20, 2);
      const atr14 = atr(candles, 14);
      const obvValues = obv(candles);
      const stochResult = stochastic(candles, 14, 3);

      // Latest values
      const latest = {
        price: closes[closes.length - 1],
        sma20: sma20.length > 0 ? sma20[sma20.length - 1] : null,
        sma50: sma50.length > 0 ? sma50[sma50.length - 1] : null,
        ema12: ema12.length > 0 ? ema12[ema12.length - 1] : null,
        ema26: ema26.length > 0 ? ema26[ema26.length - 1] : null,
        rsi: rsi14.length > 0 ? Math.round(rsi14[rsi14.length - 1] * 100) / 100 : null,
        macd: macdResult.macd.length > 0 ? {
          macd: Math.round(macdResult.macd[macdResult.macd.length - 1] * 100) / 100,
          signal: Math.round(macdResult.signal[macdResult.signal.length - 1] * 100) / 100,
          histogram: Math.round(macdResult.histogram[macdResult.histogram.length - 1] * 100) / 100,
        } : null,
        bollingerBands: bb.upper.length > 0 ? {
          upper: Math.round(bb.upper[bb.upper.length - 1] * 100) / 100,
          middle: Math.round(bb.middle[bb.middle.length - 1] * 100) / 100,
          lower: Math.round(bb.lower[bb.lower.length - 1] * 100) / 100,
        } : null,
        atr: atr14.length > 0 ? Math.round(atr14[atr14.length - 1] * 100) / 100 : null,
        obv: obvValues.length > 0 ? obvValues[obvValues.length - 1] : null,
        stochastic: stochResult.k.length > 0 ? {
          k: Math.round(stochResult.k[stochResult.k.length - 1] * 100) / 100,
          d: Math.round(stochResult.d[stochResult.d.length - 1] * 100) / 100,
        } : null,
      };

      // Signals
      const signals: string[] = [];
      if (latest.rsi != null) {
        if (latest.rsi > 70) signals.push('RSI overbought (>70)');
        else if (latest.rsi < 30) signals.push('RSI oversold (<30)');
      }
      if (latest.macd?.histogram != null) {
        if (latest.macd.histogram > 0) signals.push('MACD bullish (histogram > 0)');
        else signals.push('MACD bearish (histogram < 0)');
      }
      if (latest.sma20 != null && latest.sma50 != null) {
        if (latest.sma20 > latest.sma50) signals.push('SMA20 > SMA50 (bullish trend)');
        else signals.push('SMA20 < SMA50 (bearish trend)');
      }
      if (latest.bollingerBands != null) {
        if (latest.price > latest.bollingerBands.upper) signals.push('Price above upper Bollinger Band');
        else if (latest.price < latest.bollingerBands.lower) signals.push('Price below lower Bollinger Band');
      }

      return {
        symbol: params.symbol,
        timeframe: params.timeframe,
        candles: bars.length,
        latest,
        signals,
      };
    }),
  );

  server.tool(
    'calculate_position_size',
    `Calculate optimal position size using Kelly criterion or fixed-fractional method. Uses portfolio value, win rate, and risk parameters.`,
    {
      method: z.enum(['kelly', 'fixed_fractional']).describe('Sizing method'),
      portfolio_value: z.number().describe('Total portfolio value in quote currency'),
      win_rate: z.number().optional().describe('Historical win rate (0-1, for Kelly)'),
      avg_win_loss_ratio: z.number().optional().describe('Average win / average loss (for Kelly)'),
      risk_per_trade: z.number().optional().describe('Risk per trade as decimal (e.g., 0.02 for 2%, for fixed-fractional)'),
      entry_price: z.number().optional().describe('Planned entry price (for fixed-fractional)'),
      stop_loss_price: z.number().optional().describe('Stop-loss price (for fixed-fractional)'),
      symbol: z.string().optional().describe('Trading pair — used to round to exchange precision'),
    } as any,
    handler(async (params: any) => {
      if (params.method === 'kelly') {
        if (params.win_rate == null || params.avg_win_loss_ratio == null) {
          throw new Error('Kelly method requires win_rate and avg_win_loss_ratio');
        }
        const fraction = kelly(params.win_rate, params.avg_win_loss_ratio, true);
        const capitalToRisk = params.portfolio_value * fraction;
        const price = params.entry_price ?? 1;
        let positionSize = capitalToRisk / price;

        if (params.symbol) {
          await client.ensureMarkets();
          positionSize = client.roundAmount(params.symbol, positionSize);
        }

        return {
          method: 'kelly',
          halfKelly: true,
          kellyFraction: Math.round(fraction * 10000) / 10000,
          capitalToRisk: Math.round(capitalToRisk * 100) / 100,
          positionSize,
          entryPrice: params.entry_price,
          portfolioValue: params.portfolio_value,
        };
      }

      // Fixed fractional
      if (params.risk_per_trade == null || params.entry_price == null || params.stop_loss_price == null) {
        throw new Error('Fixed-fractional method requires risk_per_trade, entry_price, and stop_loss_price');
      }
      let positionSize = fixedFractionalSize(
        params.portfolio_value,
        params.risk_per_trade,
        params.entry_price,
        params.stop_loss_price,
      );
      const maxLoss = params.portfolio_value * params.risk_per_trade;

      if (params.symbol) {
        await client.ensureMarkets();
        positionSize = client.roundAmount(params.symbol, positionSize);
      }

      return {
        method: 'fixed_fractional',
        positionSize,
        riskPerTrade: params.risk_per_trade,
        maxLoss: Math.round(maxLoss * 100) / 100,
        entryPrice: params.entry_price,
        stopLossPrice: params.stop_loss_price,
        riskPerUnit: Math.abs(params.entry_price - params.stop_loss_price),
        portfolioValue: params.portfolio_value,
      };
    }),
  );

  server.tool(
    'get_fees',
    `Get trading fee rates on ${client.name}. Returns maker and taker fee percentages — critical for arbitrage profitability calculations.`,
    {
      symbol: z.string().optional().describe('Trading pair to get fees for (omit for top markets)'),
    } as any,
    handler(async (params: any) => {
      return client.getTradingFees(params.symbol);
    }),
  );

  server.tool(
    'get_exchange_info',
    `Get ${client.name} exchange capabilities — supported order types, timeframes, rate limits, market count. Use to check what features are available.`,
    {} as any,
    handler(async () => {
      return client.getExchangeInfo();
    }),
  );

  server.tool(
    'get_market_info',
    `Get detailed market information for a symbol on ${client.name} — precision rules, min/max order sizes, and fee rates. Essential before placing orders to know valid amounts.`,
    {
      symbol: z.string().describe('Trading pair (e.g., BTC/USDT)'),
    } as any,
    handler(async (params: any) => {
      return client.getMarketInfo(params.symbol);
    }),
  );

  server.tool(
    'assess_portfolio_risk',
    `Portfolio-level risk assessment using cached market data and VaR. Computes per-symbol volatility, drawdown, Sharpe, Sortino, plus portfolio VaR and correlation matrix.`,
    {
      symbols: z.string().describe('Comma-separated trading pairs (e.g., BTC/USDT,ETH/USDT)'),
      weights: z.string().describe('Comma-separated portfolio weights — must sum to ~1.0 (e.g., 0.6,0.4)'),
      portfolio_value: z.number().describe('Total portfolio value in quote currency'),
      confidence: z.number().default(0.95).describe('VaR confidence level (0.95 or 0.99)'),
      period: z.number().default(90).describe('Number of historical daily candles to use'),
    } as any,
    handler(async (params: any) => {
      const symbolList = params.symbols.split(',').map((s: string) => s.trim());
      const weightList = params.weights.split(',').map((w: string) => parseFloat(w.trim()));

      if (symbolList.length !== weightList.length) {
        throw new Error(`Mismatched symbols (${symbolList.length}) and weights (${weightList.length}) — must be same length`);
      }

      const weightSum = weightList.reduce((a: number, b: number) => a + b, 0);
      if (Math.abs(weightSum - 1.0) > 0.05) {
        throw new Error(`Weights sum to ${weightSum.toFixed(4)}, must sum to ~1.0 (tolerance ±0.05)`);
      }

      // Fetch bars and compute returns for each symbol
      const allReturns: number[][] = [];
      const perSymbol: Record<string, unknown>[] = [];

      for (let i = 0; i < symbolList.length; i++) {
        const symbol = symbolList[i];
        const bars = await client.getBars(symbol, '1d', undefined, params.period);
        if (bars.length < 2) {
          throw new Error(`Insufficient data for ${symbol}: got ${bars.length} bars, need at least 2`);
        }

        const closes = bars.map((b: any) => b.close);
        const symReturns = returns(closes);
        allReturns.push(symReturns);

        // Build cumulative values for maxDrawdown
        const cumValues = [1.0];
        for (const r of symReturns) {
          cumValues.push(cumValues[cumValues.length - 1] * (1 + r));
        }

        const vol = annualizedVolatility(symReturns);
        const mdd = maxDrawdown(cumValues);
        const sharpe = sharpeRatio(symReturns);
        const sortino = sortinoRatio(symReturns);

        perSymbol.push({
          symbol,
          weight: weightList[i],
          annualizedVolatility: Math.round(vol * 10000) / 10000,
          maxDrawdown: Math.round(mdd.maxDrawdown * 10000) / 10000,
          sharpeRatio: Math.round(sharpe * 100) / 100,
          sortinoRatio: sortino === Infinity ? 'Infinity' : Math.round(sortino * 100) / 100,
          dataPoints: symReturns.length,
        });
      }

      // Compute portfolio returns as weighted sum
      const minLen = Math.min(...allReturns.map(r => r.length));
      const portfolioReturns: number[] = [];
      for (let t = 0; t < minLen; t++) {
        let wr = 0;
        for (let i = 0; i < allReturns.length; i++) {
          wr += weightList[i] * allReturns[i][t];
        }
        portfolioReturns.push(wr);
      }

      // Portfolio-level cumulative values
      const portfValues = [1.0];
      for (const r of portfolioReturns) {
        portfValues.push(portfValues[portfValues.length - 1] * (1 + r));
      }

      const portfVol = annualizedVolatility(portfolioReturns);
      const portfMdd = maxDrawdown(portfValues);
      const portfSharpe = sharpeRatio(portfolioReturns);
      const var_ = valueAtRisk(params.portfolio_value, portfolioReturns, params.confidence);

      // Correlation matrix
      const corrMatrix = correlationMatrix(
        allReturns.map(r => r.slice(0, minLen)),
        symbolList,
      );
      // Round matrix values
      corrMatrix.matrix = corrMatrix.matrix.map(row =>
        row.map(v => Math.round(v * 10000) / 10000),
      );

      return {
        portfolio: {
          value: params.portfolio_value,
          confidence: params.confidence,
          valueAtRisk: Math.round(var_ * 100) / 100,
          annualizedVolatility: Math.round(portfVol * 10000) / 10000,
          maxDrawdown: Math.round(portfMdd.maxDrawdown * 10000) / 10000,
          sharpeRatio: Math.round(portfSharpe * 100) / 100,
          meanDailyReturn: Math.round(mean(portfolioReturns) * 1000000) / 1000000,
          dataPoints: portfolioReturns.length,
        },
        perSymbol,
        correlations: corrMatrix,
      };
    }),
  );

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
}
