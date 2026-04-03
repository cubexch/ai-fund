/**
 * Request latency tracker for exchange API monitoring.
 * Tracks per-method latency statistics for performance analysis.
 */

export interface LatencyStats {
  method: string;
  count: number;
  avgMs: number;
  minMs: number;
  maxMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  lastMs: number;
  errorCount: number;
  errorRate: number;
}

export class LatencyTracker {
  // Store per-method latency samples (ring buffer, max 1000 per method)
  private samples = new Map<string, number[]>();
  private errors = new Map<string, number>();
  private readonly maxSamples: number;

  constructor(maxSamples = 1000) {
    this.maxSamples = maxSamples;
  }

  record(method: string, durationMs: number): void {
    let arr = this.samples.get(method);
    if (!arr) {
      arr = [];
      this.samples.set(method, arr);
    }
    arr.push(durationMs);
    if (arr.length > this.maxSamples) arr.shift();
  }

  recordError(method: string): void {
    this.errors.set(method, (this.errors.get(method) ?? 0) + 1);
  }

  stats(method: string): LatencyStats | null {
    const arr = this.samples.get(method);
    if (!arr || arr.length === 0) return null;
    const sorted = [...arr].sort((a, b) => a - b);
    const count = sorted.length;
    const errorCount = this.errors.get(method) ?? 0;
    return {
      method,
      count,
      avgMs: Math.round(sorted.reduce((s, v) => s + v, 0) / count * 100) / 100,
      minMs: sorted[0],
      maxMs: sorted[count - 1],
      p50Ms: sorted[Math.floor(count * 0.5)],
      p95Ms: sorted[Math.floor(count * 0.95)],
      p99Ms: sorted[Math.floor(count * 0.99)],
      lastMs: arr[arr.length - 1],
      errorCount,
      errorRate: Math.round(errorCount / (count + errorCount) * 10000) / 100,
    };
  }

  allStats(): LatencyStats[] {
    const results: LatencyStats[] = [];
    for (const method of this.samples.keys()) {
      const s = this.stats(method);
      if (s) results.push(s);
    }
    return results.sort((a, b) => b.avgMs - a.avgMs);
  }

  reset(): void {
    this.samples.clear();
    this.errors.clear();
  }
}
