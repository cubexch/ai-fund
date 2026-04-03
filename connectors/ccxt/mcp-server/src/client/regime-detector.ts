/**
 * Re-export from shared lib — the regime detector is exchange-agnostic.
 */
export {
  RegimeDetector,
  type MarketRegime,
  type RegimeAnalysis,
  type RegimeTransition,
  type RegimeRecommendation,
  type RegimeHistoryEntry,
} from '@ai-fund/lib/regime-detector';
