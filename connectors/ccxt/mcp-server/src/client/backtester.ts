/**
 * Re-export from shared lib — the backtester is exchange-agnostic.
 *
 * CCXT's BarResult is structurally identical to lib's Bar, so all
 * types are compatible without adapters.
 */
export {
  Backtester,
  type BacktestConfig,
  type BacktestTrade,
  type BacktestMetrics,
  type BacktestResult,
  type RunOptions,
  type WalkForwardOptions,
  type OptimizeOptions,
} from '../../../../../lib/backtester.js';
