import { describe, it, expect } from 'vitest';
import { LatencyTracker } from '../src/client/latency-tracker.js';

describe('LatencyTracker', () => {
  it('record + stats: computes count, avg, min, max, percentiles', () => {
    const tracker = new LatencyTracker();
    const samples = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    for (const s of samples) {
      tracker.record('fetchTicker', s);
    }

    const s = tracker.stats('fetchTicker');
    expect(s).not.toBeNull();
    expect(s!.method).toBe('fetchTicker');
    expect(s!.count).toBe(10);
    expect(s!.avgMs).toBe(55);
    expect(s!.minMs).toBe(10);
    expect(s!.maxMs).toBe(100);
    // p50 = sorted[floor(10*0.5)] = sorted[5] = 60
    expect(s!.p50Ms).toBe(60);
    // p95 = sorted[floor(10*0.95)] = sorted[9] = 100
    expect(s!.p95Ms).toBe(100);
    // p99 = sorted[floor(10*0.99)] = sorted[9] = 100
    expect(s!.p99Ms).toBe(100);
    expect(s!.lastMs).toBe(100);
  });

  it('returns null for unknown method', () => {
    const tracker = new LatencyTracker();
    expect(tracker.stats('nonexistent')).toBeNull();
  });

  it('recordError: tracks error count and error rate', () => {
    const tracker = new LatencyTracker();
    // 8 successes, 2 errors -> errorRate = 2/(8+2)*100 = 20%
    for (let i = 0; i < 8; i++) {
      tracker.record('createOrder', 50);
    }
    tracker.recordError('createOrder');
    tracker.recordError('createOrder');

    const s = tracker.stats('createOrder');
    expect(s).not.toBeNull();
    expect(s!.count).toBe(8);
    expect(s!.errorCount).toBe(2);
    expect(s!.errorRate).toBe(20);
  });

  it('allStats returns sorted by avgMs descending', () => {
    const tracker = new LatencyTracker();
    tracker.record('fast', 10);
    tracker.record('slow', 100);
    tracker.record('medium', 50);

    const all = tracker.allStats();
    expect(all).toHaveLength(3);
    expect(all[0].method).toBe('slow');
    expect(all[1].method).toBe('medium');
    expect(all[2].method).toBe('fast');
  });

  it('reset clears everything', () => {
    const tracker = new LatencyTracker();
    tracker.record('fetchTicker', 25);
    tracker.recordError('fetchTicker');
    expect(tracker.stats('fetchTicker')).not.toBeNull();

    tracker.reset();
    expect(tracker.stats('fetchTicker')).toBeNull();
    expect(tracker.allStats()).toHaveLength(0);
  });

  it('ring buffer: caps at maxSamples', () => {
    const tracker = new LatencyTracker(1000);
    for (let i = 0; i < 1100; i++) {
      tracker.record('fetchOHLCV', i);
    }

    const s = tracker.stats('fetchOHLCV');
    expect(s).not.toBeNull();
    expect(s!.count).toBe(1000);
    // First 100 samples (0-99) should have been shifted out
    // min should be 100, not 0
    expect(s!.minMs).toBe(100);
    expect(s!.maxMs).toBe(1099);
  });
});
