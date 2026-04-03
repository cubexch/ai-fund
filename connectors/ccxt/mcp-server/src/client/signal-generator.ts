/**
 * Re-export from shared lib — the signal generator is exchange-agnostic.
 */
export {
  SignalGenerator,
  type TradingSignal,
  type SignalType,
  type SignalStrength,
  type ScanResult,
} from '../../../../../lib/signal-generator.js';
