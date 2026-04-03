/**
 * Strategy portfolio tools — position sizing, portfolio risk, rebalancing, liquidation heatmap.
 *
 * Thin wrappers around @ai-fund/lib/portfolio-analytics — all pure computation
 * is delegated to the shared library. This file handles MCP registration,
 * exchange data fetching, precision rounding, and response shaping.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ExchangeClient } from '../client/exchange';
import { handler } from './handler';
import {
  kelly, fixedFractionalSize,
} from '@ai-fund/lib/math';
import {
  assessPortfolioRisk,
  calculateRebalanceTrades,
} from '@ai-fund/lib/portfolio-analytics';

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

      // Fetch bars for each symbol and extract closes
      const symbolData: Record<string, number[]> = {};
      for (const symbol of symbolList) {
        const bars = await client.getBars(symbol, '1d', undefined, params.period);
        if (bars.length < 2) {
          throw new Error(`Insufficient data for ${symbol}: got ${bars.length} bars, need at least 2`);
        }
        symbolData[symbol] = bars.map((b: any) => b.close);
      }

      return assessPortfolioRisk(symbolData, weightList, params.portfolio_value, params.confidence);
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

      // Early check: portfolio value must be positive
      const portfolioVal = params.total_value ??
        holdingsArr.reduce((sum: number, h: { amount: number; price: number }) => sum + h.amount * h.price, 0);
      if (portfolioVal <= 0) {
        throw new Error('Portfolio value must be positive');
      }

      // Build prices lookup from holdings
      const prices: Record<string, number> = {};
      for (const h of holdingsArr) {
        prices[h.symbol] = h.price;
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
        }
      }

      const result = calculateRebalanceTrades(holdingsArr, targetWeights, prices, params.total_value);

      // Round amounts to exchange precision
      for (const trade of result.trades) {
        try {
          await client.ensureMarkets();
          trade.amount = client.roundAmount(trade.symbol, trade.amount);
        } catch {
          // Markets not loaded — use raw amount
        }
      }

      return result;
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

      const tolerance = mid * 0.005;

      const levels: {
        leverage: number;
        longLiquidation: number;
        shortLiquidation: number;
        nearbyBidVolume: number;
        nearbyAskVolume: number;
      }[] = [];

      for (const leverage of leverageLevels) {
        const longLiq = mid * (1 - 1 / leverage);
        const shortLiq = mid * (1 + 1 / leverage);

        let nearbyBidVolume = 0;
        for (const [price, size] of orderBook.bids) {
          if (Math.abs(price - longLiq) <= tolerance) {
            nearbyBidVolume += size;
          }
        }

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

      // Identify cluster zones
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
