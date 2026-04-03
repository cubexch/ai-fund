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
  zScore, standardDeviation,
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
        spotPrice = spotTicker.last ?? spotTicker.mid ?? spotTicker.bid;
        if (spotPrice == null) throw new Error('No spot price available');
      } catch (err: any) {
        throw new Error(`Cannot fetch spot price for ${spotSymbol}: ${err.message}`);
      }

      try {
        const perpTicker = await client.getTicker(perpSymbol);
        perpPrice = perpTicker.last ?? perpTicker.mid ?? perpTicker.bid;
        if (perpPrice == null) throw new Error('No perp price available');
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
    'scan_mean_reversion',
    `Scan cached DuckDB data for mean reversion opportunities using Z-scores on ${client.name}. Flags overbought/oversold symbols based on deviation from rolling mean.`,
    {
      symbols: z.string().describe('Comma-separated trading pairs (e.g., BTC/USDT,ETH/USDT,SOL/USDT)'),
      timeframe: z.string().default('1d').describe('Candle timeframe (1m, 5m, 15m, 1h, 4h, 1d)'),
      lookback: z.number().default(50).describe('Lookback period for mean/std calculation'),
      zscore_threshold: z.number().default(2.0).describe('Z-score threshold to flag opportunities'),
    } as any,
    handler(async (params: any) => {
      const symbolList = params.symbols.split(',').map((s: string) => s.trim());
      const store = client.store;

      if (!store) {
        throw new Error('DuckDB store not configured — mean reversion scan requires cached OHLCV data. Use get_bars first to populate the cache.');
      }

      const results: any[] = [];

      for (const symbol of symbolList) {
        const candles = await store.query({
          symbol,
          interval: params.timeframe,
          limit: params.lookback + 1,
        });

        if (candles.length < params.lookback) {
          results.push({
            symbol,
            error: `Insufficient data: got ${candles.length} candles, need ${params.lookback}`,
          });
          continue;
        }

        const closes = candles.map(c => c.close);
        const lookbackCloses = closes.slice(-params.lookback);
        const currentPrice = closes[closes.length - 1];

        const avg = mean(lookbackCloses);
        const std = standardDeviation(lookbackCloses);

        if (std === 0) {
          results.push({
            symbol,
            currentPrice,
            mean: avg,
            std: 0,
            zscore: 0,
            signal: 'neutral' as const,
            deviationPct: 0,
          });
          continue;
        }

        const z = zScore(currentPrice, lookbackCloses);
        const deviationPct = ((currentPrice - avg) / avg) * 100;

        let signal: 'overbought' | 'oversold' | 'neutral';
        if (z > params.zscore_threshold) {
          signal = 'overbought';
        } else if (z < -params.zscore_threshold) {
          signal = 'oversold';
        } else {
          signal = 'neutral';
        }

        results.push({
          symbol,
          currentPrice: Math.round(currentPrice * 100) / 100,
          mean: Math.round(avg * 100) / 100,
          std: Math.round(std * 100) / 100,
          zscore: Math.round(z * 10000) / 10000,
          signal,
          deviationPct: Math.round(deviationPct * 100) / 100,
        });
      }

      // Sort by absolute z-score descending
      results.sort((a: any, b: any) => {
        const aZ = Math.abs(a.zscore ?? 0);
        const bZ = Math.abs(b.zscore ?? 0);
        return bZ - aZ;
      });

      const opportunities = results.filter((r: any) => r.signal && r.signal !== 'neutral' && !r.error);

      return {
        scanned: symbolList.length,
        timeframe: params.timeframe,
        lookback: params.lookback,
        zscoreThreshold: params.zscore_threshold,
        opportunities: opportunities.length,
        results,
      };
    }),
  );

  server.tool(
    'detect_confluence',
    `Multi-timeframe signal confluence detector on ${client.name}. Analyzes RSI, MACD, SMA trend, Bollinger Band position, and price vs EMA across multiple timeframes to find agreement.`,
    {
      symbol: z.string().describe('Trading pair (e.g., BTC/USDT)'),
      timeframes: z.string().default('5m,15m,1h,4h,1d').describe('Comma-separated timeframes to analyze'),
    } as any,
    handler(async (params: any) => {
      const tfList = params.timeframes.split(',').map((t: string) => t.trim());

      const signals: Record<string, {
        rsi: number;
        rsiSignal: string;
        macd: string;
        trend: string;
        bbPosition: string;
        priceVsEma: string;
      }> = {};

      let bullishCount = 0;
      let bearishCount = 0;

      for (const tf of tfList) {
        const bars = await client.getBars(params.symbol, tf, undefined, 100);
        if (bars.length < 51) {
          throw new Error(`Insufficient data for timeframe ${tf}: got ${bars.length} bars, need at least 51`);
        }

        const candles: OHLCV[] = bars.map((b: any) => ({
          open: b.open, high: b.high, low: b.low, close: b.close,
          volume: b.volume, timestamp: b.timestamp,
        }));
        const closes = candles.map(c => c.close);
        const currentPrice = closes[closes.length - 1];

        // RSI(14)
        const rsi14 = rsi(closes, 14);
        const rsiValue = rsi14.length > 0 ? Math.round(rsi14[rsi14.length - 1] * 100) / 100 : 50;
        const rsiSignal = rsiValue > 70 ? 'overbought' : rsiValue < 30 ? 'oversold' : 'neutral';

        // MACD histogram sign
        const macdResult = macd(closes, 12, 26, 9);
        const histogram = macdResult.histogram.length > 0
          ? macdResult.histogram[macdResult.histogram.length - 1] : 0;
        const macdSignal = histogram > 0 ? 'bullish' : 'bearish';

        // SMA(20) vs SMA(50)
        const sma20 = sma(closes, 20);
        const sma50 = sma(closes, 50);
        const sma20Val = sma20.length > 0 ? sma20[sma20.length - 1] : 0;
        const sma50Val = sma50.length > 0 ? sma50[sma50.length - 1] : 0;
        const trend = sma20Val > sma50Val ? 'bullish' : 'bearish';

        // Bollinger Band position
        const bb = bollingerBands(closes, 20, 2);
        let bbPosition = 'inside';
        if (bb.upper.length > 0) {
          const upperVal = bb.upper[bb.upper.length - 1];
          const lowerVal = bb.lower[bb.lower.length - 1];
          if (currentPrice > upperVal) bbPosition = 'above_upper';
          else if (currentPrice < lowerVal) bbPosition = 'below_lower';
        }

        // Price vs EMA(20)
        const ema20 = ema(closes, 20);
        const ema20Val = ema20.length > 0 ? ema20[ema20.length - 1] : currentPrice;
        const priceVsEma = currentPrice > ema20Val ? 'above' : 'below';

        // Count bullish/bearish signals for this timeframe
        let tfBullish = 0;
        let tfBearish = 0;

        if (macdSignal === 'bullish') tfBullish++; else tfBearish++;
        if (trend === 'bullish') tfBullish++; else tfBearish++;
        if (priceVsEma === 'above') tfBullish++; else tfBearish++;
        if (rsiSignal === 'overbought') tfBearish++;
        else if (rsiSignal === 'oversold') tfBullish++;
        if (bbPosition === 'above_upper') tfBearish++;
        else if (bbPosition === 'below_lower') tfBullish++;

        if (tfBullish > tfBearish) bullishCount++;
        else if (tfBearish > tfBullish) bearishCount++;

        signals[tf] = {
          rsi: rsiValue,
          rsiSignal,
          macd: macdSignal,
          trend,
          bbPosition,
          priceVsEma,
        };
      }

      const total = tfList.length;
      const dominant = bullishCount >= bearishCount ? 'bullish' : 'bearish';
      const dominantCount = Math.max(bullishCount, bearishCount);
      const score = Math.round((dominantCount / total) * 100);
      const strength = score >= 80 ? 'strong' : score >= 60 ? 'moderate' : 'weak';

      return {
        symbol: params.symbol,
        timeframes: tfList,
        signals,
        confluence: {
          bullish: bullishCount,
          bearish: bearishCount,
          score,
          direction: dominant,
          strength,
        },
        recommendation: `${strength.charAt(0).toUpperCase() + strength.slice(1)} ${dominant} confluence across ${dominantCount}/${total} timeframes`,
      };
    }),
  );

  server.tool(
    'detect_bb_squeeze',
    `Bollinger Band squeeze detector on ${client.name}. Identifies low-volatility compression that often precedes breakouts. Scans multiple symbols and ranks by squeeze intensity.`,
    {
      symbols: z.string().describe('Comma-separated trading pairs (e.g., BTC/USDT,ETH/USDT)'),
      timeframe: z.string().default('4h').describe('Candle timeframe'),
      period: z.number().default(20).describe('Bollinger Band period'),
      squeeze_threshold: z.number().default(0.5).describe('Squeeze if bandwidth < threshold * mean bandwidth'),
    } as any,
    handler(async (params: any) => {
      const symbolList = params.symbols.split(',').map((s: string) => s.trim());
      const results: {
        symbol: string;
        inSqueeze: boolean;
        bandwidth: number;
        avgBandwidth: number;
        squeezeRatio: number;
        squeezeDuration: number;
        pricePosition: string;
        signal: string;
      }[] = [];

      for (const symbol of symbolList) {
        const bars = await client.getBars(symbol, params.timeframe, undefined, 120);
        if (bars.length < params.period + 1) {
          throw new Error(`Insufficient data for ${symbol}: got ${bars.length} bars, need at least ${params.period + 1}`);
        }

        const closes = bars.map((b: any) => b.close);
        const bb = bollingerBands(closes, params.period, 2);

        if (bb.upper.length === 0) {
          throw new Error(`Could not compute Bollinger Bands for ${symbol}`);
        }

        // Compute bandwidth series: (upper - lower) / middle * 100
        const bandwidthSeries: number[] = [];
        for (let i = 0; i < bb.upper.length; i++) {
          const bw = bb.middle[i] !== 0
            ? ((bb.upper[i] - bb.lower[i]) / bb.middle[i]) * 100
            : 0;
          bandwidthSeries.push(bw);
        }

        const currentBandwidth = bandwidthSeries[bandwidthSeries.length - 1];
        const avgBandwidth = mean(bandwidthSeries);
        const squeezeRatio = avgBandwidth !== 0 ? currentBandwidth / avgBandwidth : 1;
        const inSqueeze = squeezeRatio < params.squeeze_threshold;

        // Squeeze duration: consecutive bars below threshold
        let squeezeDuration = 0;
        if (inSqueeze) {
          for (let i = bandwidthSeries.length - 1; i >= 0; i--) {
            const ratio = avgBandwidth !== 0 ? bandwidthSeries[i] / avgBandwidth : 1;
            if (ratio < params.squeeze_threshold) {
              squeezeDuration++;
            } else {
              break;
            }
          }
        }

        // Direction hint: price vs middle band
        const currentPrice = closes[closes.length - 1];
        const currentMiddle = bb.middle[bb.middle.length - 1];
        const pricePosition = currentPrice > currentMiddle ? 'above_middle' : 'below_middle';

        // Build signal string
        let signal: string;
        if (inSqueeze) {
          const bias = pricePosition === 'above_middle' ? 'bullish' : 'bearish';
          if (squeezeDuration >= 10) {
            signal = `Extended squeeze (${squeezeDuration} bars) — breakout imminent, bias ${bias}`;
          } else {
            signal = `Tight squeeze — breakout imminent, bias ${bias}`;
          }
        } else {
          signal = 'No squeeze — normal volatility';
        }

        results.push({
          symbol,
          inSqueeze,
          bandwidth: Math.round(currentBandwidth * 10000) / 10000,
          avgBandwidth: Math.round(avgBandwidth * 10000) / 10000,
          squeezeRatio: Math.round(squeezeRatio * 10000) / 10000,
          squeezeDuration,
          pricePosition,
          signal,
        });
      }

      // Sort by squeeze ratio (lowest = tightest squeeze first)
      results.sort((a, b) => a.squeezeRatio - b.squeezeRatio);

      return {
        timeframe: params.timeframe,
        results,
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

  server.tool(
    'get_volatility_term_structure',
    `Build volatility term structure from multiple timeframes on ${client.name}. Computes annualized volatility per timeframe and classifies the term structure as normal or inverted.`,
    {
      symbol: z.string().describe('Trading pair (e.g., BTC/USDT)'),
      timeframes: z.string().default('1h,4h,1d,1w').describe('Comma-separated timeframes to analyze'),
    } as any,
    handler(async (params: any) => {
      const tfList = params.timeframes.split(',').map((t: string) => t.trim());

      // Periods per year for annualization
      const periodsPerYear: Record<string, number> = {
        '1m': 525600,
        '5m': 105120,
        '15m': 35040,
        '1h': 8760,
        '4h': 2190,
        '1d': 365,
        '1w': 52,
      };

      const structure: {
        timeframe: string;
        annualizedVolatility: number;
        sampleSize: number;
        periodsPerYear: number;
      }[] = [];

      for (const tf of tfList) {
        const bars = await client.getBars(params.symbol, tf, undefined, 100);
        if (bars.length < 2) {
          throw new Error(`Insufficient data for timeframe ${tf}: got ${bars.length} bars, need at least 2`);
        }

        const closes = bars.map((b: any) => b.close);
        const rets = returns(closes);
        const std = standardDeviation(rets);
        const ppy = periodsPerYear[tf] ?? 365;
        const annVol = std * Math.sqrt(ppy);

        structure.push({
          timeframe: tf,
          annualizedVolatility: Math.round(annVol * 10000) / 10000,
          sampleSize: rets.length,
          periodsPerYear: ppy,
        });
      }

      // Compute volatility ratios between adjacent timeframes
      const ratios: { from: string; to: string; ratio: number }[] = [];
      for (let i = 0; i < structure.length - 1; i++) {
        const ratio = structure[i + 1].annualizedVolatility !== 0
          ? structure[i].annualizedVolatility / structure[i + 1].annualizedVolatility
          : Infinity;
        ratios.push({
          from: structure[i].timeframe,
          to: structure[i + 1].timeframe,
          ratio: ratio === Infinity ? Infinity : Math.round(ratio * 10000) / 10000,
        });
      }

      // Classify: normal = longer timeframes have higher annualized vol;
      // inverted = shorter timeframes have higher annualized vol
      let increasingCount = 0;
      let decreasingCount = 0;
      for (let i = 0; i < structure.length - 1; i++) {
        if (structure[i + 1].annualizedVolatility > structure[i].annualizedVolatility) {
          increasingCount++;
        } else {
          decreasingCount++;
        }
      }

      const classification: 'normal' | 'inverted' | 'mixed' =
        structure.length <= 1 ? 'normal' :
        increasingCount > decreasingCount ? 'normal' :
        decreasingCount > increasingCount ? 'inverted' :
        'mixed';

      return {
        symbol: params.symbol,
        structure,
        ratios,
        classification,
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
