/**
 * Formatting utilities for prices, quantities, and display values.
 */

/**
 * Format a number as USD currency.
 */
export function usd(value: number, decimals: number = 2): string {
  return `$${value.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })}`;
}

/**
 * Format a number as a percentage.
 */
export function pct(value: number, decimals: number = 1): string {
  return `${(value * 100).toFixed(decimals)}%`;
}

/**
 * Format a quantity with appropriate decimal places.
 */
export function qty(value: number, precision: number = 6): string {
  return value.toFixed(precision).replace(/\.?0+$/, '');
}

/**
 * Format a price with appropriate decimal places.
 */
export function price(value: number, precision: number = 2): string {
  return value.toFixed(precision);
}

/**
 * Format a large number with K/M/B suffixes.
 */
export function compact(value: number): string {
  if (Math.abs(value) >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`;
  if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (Math.abs(value) >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return value.toFixed(2);
}

/**
 * Format a timestamp as a readable date/time string.
 */
export function timestamp(ts: number): string {
  return new Date(ts)
    .toISOString()
    .replace('T', ' ')
    .replace(/\.\d+Z$/, ' UTC');
}

/**
 * Format a duration in milliseconds to human readable.
 */
export function duration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)}m`;
  if (ms < 86_400_000) return `${(ms / 3_600_000).toFixed(1)}h`;
  return `${(ms / 86_400_000).toFixed(1)}d`;
}

/**
 * Color-code a value for terminal display: positive = green, negative = red.
 */
export function signedValue(value: number, formatter: (v: number) => string = usd): string {
  const formatted = formatter(Math.abs(value));
  return value >= 0 ? `+${formatted}` : `-${formatted}`;
}

/**
 * Grade letter from score (0-100).
 */
export function grade(score: number): string {
  if (score >= 90) return 'A';
  if (score >= 80) return 'B';
  if (score >= 70) return 'C';
  if (score >= 60) return 'D';
  return 'F';
}
