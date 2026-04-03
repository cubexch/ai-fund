/**
 * Token-bucket rate limiter for exchange API requests.
 *
 * Prevents hitting exchange rate limits during high-frequency
 * operations like market-making and arbitrage scanning.
 */

export class RateLimiter {
  private tokens: number;
  private readonly maxTokens: number;
  private readonly refillRate: number; // tokens per ms
  private lastRefill: number;
  private queue: { resolve: () => void }[] = [];

  /**
   * @param maxRequestsPerSecond - Maximum sustained request rate
   * @param burst - Maximum burst size (default: 2x sustained rate)
   */
  constructor(maxRequestsPerSecond: number, burst?: number) {
    this.maxTokens = burst ?? maxRequestsPerSecond * 2;
    this.tokens = this.maxTokens;
    this.refillRate = maxRequestsPerSecond / 1000;
    this.lastRefill = Date.now();
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    this.tokens = Math.min(this.maxTokens, this.tokens + elapsed * this.refillRate);
    this.lastRefill = now;
  }

  /** Acquire a token, waiting if necessary. */
  async acquire(): Promise<void> {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return;
    }
    // Wait for a token
    return new Promise<void>(resolve => {
      this.queue.push({ resolve });
      const waitMs = Math.ceil((1 - this.tokens) / this.refillRate);
      setTimeout(() => {
        this.refill();
        const pending = this.queue.shift();
        if (pending) {
          this.tokens = Math.max(0, this.tokens - 1);
          pending.resolve();
        }
      }, waitMs);
    });
  }

  /** Current available tokens (for monitoring). */
  get available(): number {
    this.refill();
    return Math.floor(this.tokens);
  }

  /** Pending requests in queue. */
  get pending(): number {
    return this.queue.length;
  }
}
