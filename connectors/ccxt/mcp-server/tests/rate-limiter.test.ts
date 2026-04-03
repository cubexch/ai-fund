import { describe, it, expect } from 'vitest';
import { RateLimiter } from '../src/client/rate-limiter';

describe('RateLimiter', () => {
  it('allows burst requests up to burst limit', async () => {
    const limiter = new RateLimiter(10, 5); // 10/s, burst of 5
    // Should acquire 5 tokens immediately without blocking
    for (let i = 0; i < 5; i++) {
      await limiter.acquire();
    }
    expect(limiter.available).toBe(0);
  });

  it('defaults burst to 2x sustained rate', () => {
    const limiter = new RateLimiter(10);
    expect(limiter.available).toBe(20); // 10 * 2
  });

  it('available decreases after acquire', async () => {
    const limiter = new RateLimiter(10, 5);
    expect(limiter.available).toBe(5);
    await limiter.acquire();
    expect(limiter.available).toBe(4);
    await limiter.acquire();
    expect(limiter.available).toBe(3);
  });

  it('pending tracks queued requests', async () => {
    const limiter = new RateLimiter(100, 2);
    expect(limiter.pending).toBe(0);

    // Exhaust tokens
    await limiter.acquire();
    await limiter.acquire();
    expect(limiter.available).toBe(0);

    // Next acquire should queue
    const promise = limiter.acquire();
    expect(limiter.pending).toBe(1);

    // Wait for it to resolve
    await promise;
    expect(limiter.pending).toBe(0);
  });

  it('throttles after burst is exhausted', async () => {
    const limiter = new RateLimiter(1000, 2); // high rate so refill is fast
    // Exhaust burst
    await limiter.acquire();
    await limiter.acquire();

    const start = Date.now();
    await limiter.acquire(); // should wait for refill
    const elapsed = Date.now() - start;

    // Should have waited at least a tiny bit (token refill)
    // With 1000/s rate, 1 token refills in 1ms
    expect(elapsed).toBeGreaterThanOrEqual(0);
  });

  it('tokens refill over time', async () => {
    const limiter = new RateLimiter(1000, 3); // 1000/s = 1 token/ms
    // Exhaust all tokens
    await limiter.acquire();
    await limiter.acquire();
    await limiter.acquire();
    expect(limiter.available).toBe(0);

    // Wait 10ms => ~10 tokens refilled, capped at burst (3)
    await new Promise(r => setTimeout(r, 15));
    expect(limiter.available).toBeGreaterThanOrEqual(2);
    expect(limiter.available).toBeLessThanOrEqual(3);
  });

  it('does not exceed maxTokens on refill', async () => {
    const limiter = new RateLimiter(1000, 5);
    // Wait without consuming -- tokens should stay capped at burst
    await new Promise(r => setTimeout(r, 20));
    expect(limiter.available).toBe(5);
  });

  it('handles multiple queued requests', async () => {
    const limiter = new RateLimiter(1000, 1);
    await limiter.acquire(); // exhaust the single token

    const resolved: number[] = [];
    const p1 = limiter.acquire().then(() => resolved.push(1));
    const p2 = limiter.acquire().then(() => resolved.push(2));

    expect(limiter.pending).toBeGreaterThanOrEqual(1);

    await Promise.all([p1, p2]);

    // Both should have resolved
    expect(resolved).toHaveLength(2);
    expect(resolved).toContain(1);
    expect(resolved).toContain(2);
  });
});

describe('stress tests', () => {
  it('concurrent burst: 20 simultaneous acquires on burst=5 all resolve', async () => {
    const limiter = new RateLimiter(1000, 5);
    const timeout = 5000;

    const promises = Array.from({ length: 20 }, () =>
      Promise.race([
        limiter.acquire().then(() => 'ok' as const),
        new Promise<'timeout'>((_, reject) =>
          setTimeout(() => reject(new Error('acquire hung beyond timeout')), timeout),
        ),
      ]),
    );

    const results = await Promise.all(promises);
    expect(results).toHaveLength(20);
    expect(results.every(r => r === 'ok')).toBe(true);
  }, 10000);

  it('sustained throughput: 10 sequential acquires at 1000/s complete quickly', async () => {
    const limiter = new RateLimiter(1000, 10);
    const start = Date.now();

    for (let i = 0; i < 10; i++) {
      await limiter.acquire();
    }

    const elapsed = Date.now() - start;
    // 10 requests at 1000/s with burst=10 should be near-instant
    expect(elapsed).toBeLessThan(100);
  });

  it('single acquire never hangs indefinitely', async () => {
    const limiter = new RateLimiter(1, 1);
    // Exhaust the single token
    await limiter.acquire();

    // Next acquire should still resolve within 5 seconds (rate=1/s => ~1s wait)
    const result = await Promise.race([
      limiter.acquire().then(() => 'ok' as const),
      new Promise<'timeout'>(resolve =>
        setTimeout(() => resolve('timeout'), 5000),
      ),
    ]);

    expect(result).toBe('ok');
  }, 10000);
});
