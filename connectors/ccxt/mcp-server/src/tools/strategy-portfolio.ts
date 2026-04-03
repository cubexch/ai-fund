/* eslint-disable @typescript-eslint/no-explicit-any */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ExchangeClient } from '../client/exchange';
import { handler } from './handler';
import {
  kelly, fixedFractionalSize,
  valueAtRisk, maxDrawdown, sharpeRatio, sortinoRatio,
  annualizedVolatility, returns, correlationMatrix, mean,
} from '@ai-fund/lib/math';

export function registerStrategyPortfolioTools(server: McpServer, client: ExchangeClient) {
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
          sortinoRatio: Number.isFinite(sortino) ? Math.round(sortino * 100) / 100 : null,
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
    'rebalance_portfolio',
    `Calculate optimal trades to rebalance a portfolio to target weights on ${client.name}. Returns trade list with amounts, notional values, and turnover metrics.`,
    {
      holdings: z.string().describe('JSON array of current holdings: [{"symbol":"BTC/USDT","amount":0.5,"price":65000},...]'),
      targets: z.string().describe('JSON object of target weights: {"BTC/USDT":0.6,"ETH/USDT":0.3,"SOL/USDT":0.1}'),
      total_value: z.number().optional().describe('Total portfolio value in quote currency (computed from holdings if omitted)'),
    } as any,
    handler(async (params: any) => {
      const holdingsArr: { symbol: string; amount: number; price: number }[] = JSON.parse(params.holdings);
      const targetWeights: Record<string, number> = JSON.parse(params.targets);

      // Compute current portfolio value
      const portfolioValue = params.total_value ??
        holdingsArr.reduce((sum, h) => sum + h.amount * h.price, 0);

      if (portfolioValue <= 0) {
        throw new Error('Portfolio value must be positive');
      }

      // Build current values and weights
      const currentValues: Record<string, number> = {};
      const prices: Record<string, number> = {};
      for (const h of holdingsArr) {
        currentValues[h.symbol] = h.amount * h.price;
        prices[h.symbol] = h.price;
      }

      const currentWeights: Record<string, number> = {};
      for (const [sym, val] of Object.entries(currentValues)) {
        currentWeights[sym] = Math.round((val / portfolioValue) * 10000) / 10000;
      }

      // Fetch prices for symbols in targets but not in holdings
      for (const sym of Object.keys(targetWeights)) {
        if (prices[sym] == null) {
          const ticker = await client.getTicker(sym);
          const tickerPrice = ticker.last ?? ticker.bid ?? ticker.ask;
          if (tickerPrice == null || tickerPrice === 0) {
            throw new Error(`Cannot determine price for ${sym}`);
          }
          prices[sym] = tickerPrice;
          currentValues[sym] = 0;
          currentWeights[sym] = 0;
        }
      }

      // Compute trades
      interface Trade {
        symbol: string;
        side: 'buy' | 'sell';
        amount: number;
        notional: number;
        reason: string;
      }

      const trades: Trade[] = [];
      let totalTurnover = 0;

      // All symbols involved (union of holdings and targets)
      const allSymbols = new Set([...Object.keys(currentValues), ...Object.keys(targetWeights)]);

      for (const sym of allSymbols) {
        const currentVal = currentValues[sym] ?? 0;
        const targetWeight = targetWeights[sym] ?? 0;
        const targetVal = portfolioValue * targetWeight;
        const delta = targetVal - currentVal;

        if (Math.abs(delta) < 1) continue; // skip negligible trades

        const curWeightPct = ((currentVal / portfolioValue) * 100).toFixed(1);
        const tgtWeightPct = (targetWeight * 100).toFixed(1);

        const side: 'buy' | 'sell' = delta > 0 ? 'buy' : 'sell';
        const absDelta = Math.abs(delta);
        const price = prices[sym];
        let amount = absDelta / price;

        // Round to exchange precision if markets are loaded
        try {
          await client.ensureMarkets();
          amount = client.roundAmount(sym, amount);
        } catch {
          // Markets not loaded — use raw amount
        }

        const reason = currentVal === 0
          ? `New position at ${tgtWeightPct}%`
          : side === 'buy'
            ? `Increase from ${curWeightPct}% to ${tgtWeightPct}%`
            : `Decrease from ${curWeightPct}% to ${tgtWeightPct}%`;

        trades.push({
          symbol: sym,
          side,
          amount,
          notional: Math.round(absDelta * 100) / 100,
          reason,
        });
        totalTurnover += absDelta;
      }

      // Sort by absolute notional descending
      trades.sort((a, b) => b.notional - a.notional);

      return {
        portfolioValue: Math.round(portfolioValue * 100) / 100,
        currentWeights,
        targetWeights,
        trades,
        totalTurnover: Math.round(totalTurnover * 100) / 100,
        turnoverPct: Math.round((totalTurnover / portfolioValue) * 1000) / 10,
      };
    }),
  );

  server.tool(
    'get_liquidation_heatmap',
    `Estimate liquidation levels from order book depth on ${client.name}. Shows where leveraged positions would be liquidated and the volume sitting at those levels.`,
    {
      symbol: z.string().describe('Trading pair (e.g., BTC/USDT)'),
      leverage_levels: z.string().default('2,3,5,10,25,50,100').describe('Comma-separated leverage levels to analyze'),
    } as any,
    handler(async (params: any) => {
      const [orderBook, quote] = await Promise.all([
        client.getOrderBook(params.symbol, 50),
        client.getQuote(params.symbol),
      ]);

      const mid = quote.mid ?? orderBook.mid;
      if (mid == null || mid === 0) {
        throw new Error(`Cannot determine mid price for ${params.symbol}`);
      }

      const leverageLevels = params.leverage_levels
        .split(',')
        .map((l: string) => parseFloat(l.trim()))
        .filter((l: number) => l > 0 && isFinite(l));

      const levels: {
        leverage: number;
        longLiquidation: number;
        shortLiquidation: number;
        nearbyBidVolume: number;
        nearbyAskVolume: number;
      }[] = [];

      // Tolerance: 0.5% of mid for "nearby" volume matching
      const tolerance = mid * 0.005;

      for (const leverage of leverageLevels) {
        const longLiq = mid * (1 - 1 / leverage);
        const shortLiq = mid * (1 + 1 / leverage);

        // Walk bids to find volume near long liquidation price
        let nearbyBidVolume = 0;
        for (const [price, size] of orderBook.bids) {
          if (Math.abs(price - longLiq) <= tolerance) {
            nearbyBidVolume += size;
          }
        }

        // Walk asks to find volume near short liquidation price
        let nearbyAskVolume = 0;
        for (const [price, size] of orderBook.asks) {
          if (Math.abs(price - shortLiq) <= tolerance) {
            nearbyAskVolume += size;
          }
        }

        levels.push({
          leverage,
          longLiquidation: Math.round(longLiq * 100) / 100,
          shortLiquidation: Math.round(shortLiq * 100) / 100,
          nearbyBidVolume: Math.round(nearbyBidVolume * 100000000) / 100000000,
          nearbyAskVolume: Math.round(nearbyAskVolume * 100000000) / 100000000,
        });
      }

      // Identify cluster zones: group nearby liquidation prices and sum volumes
      const clusterZones: {
        priceRange: [number, number];
        estimatedLiquidationVolume: number;
        type: 'long_liquidation' | 'short_liquidation';
      }[] = [];

      // Long liquidation clusters (below mid)
      const longLiqs = levels
        .filter(l => l.longLiquidation > 0)
        .sort((a, b) => a.longLiquidation - b.longLiquidation);

      if (longLiqs.length > 0) {
        let clusterStart = longLiqs[0].longLiquidation;
        let clusterEnd = longLiqs[0].longLiquidation;
        let clusterVol = longLiqs[0].nearbyBidVolume;

        for (let i = 1; i < longLiqs.length; i++) {
          const gap = longLiqs[i].longLiquidation - clusterEnd;
          if (gap <= mid * 0.02) {
            clusterEnd = longLiqs[i].longLiquidation;
            clusterVol += longLiqs[i].nearbyBidVolume;
          } else {
            clusterZones.push({
              priceRange: [Math.round(clusterStart * 100) / 100, Math.round(clusterEnd * 100) / 100],
              estimatedLiquidationVolume: Math.round(clusterVol * 100000000) / 100000000,
              type: 'long_liquidation',
            });
            clusterStart = longLiqs[i].longLiquidation;
            clusterEnd = longLiqs[i].longLiquidation;
            clusterVol = longLiqs[i].nearbyBidVolume;
          }
        }
        clusterZones.push({
          priceRange: [Math.round(clusterStart * 100) / 100, Math.round(clusterEnd * 100) / 100],
          estimatedLiquidationVolume: Math.round(clusterVol * 100000000) / 100000000,
          type: 'long_liquidation',
        });
      }

      // Short liquidation clusters (above mid)
      const shortLiqs = levels
        .filter(l => l.shortLiquidation > 0)
        .sort((a, b) => a.shortLiquidation - b.shortLiquidation);

      if (shortLiqs.length > 0) {
        let clusterStart = shortLiqs[0].shortLiquidation;
        let clusterEnd = shortLiqs[0].shortLiquidation;
        let clusterVol = shortLiqs[0].nearbyAskVolume;

        for (let i = 1; i < shortLiqs.length; i++) {
          const gap = shortLiqs[i].shortLiquidation - clusterEnd;
          if (gap <= mid * 0.02) {
            clusterEnd = shortLiqs[i].shortLiquidation;
            clusterVol += shortLiqs[i].nearbyAskVolume;
          } else {
            clusterZones.push({
              priceRange: [Math.round(clusterStart * 100) / 100, Math.round(clusterEnd * 100) / 100],
              estimatedLiquidationVolume: Math.round(clusterVol * 100000000) / 100000000,
              type: 'short_liquidation',
            });
            clusterStart = shortLiqs[i].shortLiquidation;
            clusterEnd = shortLiqs[i].shortLiquidation;
            clusterVol = shortLiqs[i].nearbyAskVolume;
          }
        }
        clusterZones.push({
          priceRange: [Math.round(clusterStart * 100) / 100, Math.round(clusterEnd * 100) / 100],
          estimatedLiquidationVolume: Math.round(clusterVol * 100000000) / 100000000,
          type: 'short_liquidation',
        });
      }

      return {
        symbol: params.symbol,
        currentMid: Math.round(mid * 100) / 100,
        levels,
        clusterZones,
      };
    }),
  );
}
