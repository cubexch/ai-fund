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

  private draining = false;

  /** Acquire a token, waiting if necessary. */
  async acquire(): Promise<void> {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return;
    }
    // Wait for a token — single drain loop processes the entire queue
    return new Promise<void>(resolve => {
      this.queue.push({ resolve });
      if (!this.draining) {
        this.scheduleDrain();
      }
    });
  }

  private scheduleDrain(): void {
    this.draining = true;
    const waitMs = Math.max(1, Math.ceil((1 - this.tokens) / this.refillRate));
    setTimeout(() => {
      this.refill();
      // Resolve as many waiters as we have tokens for
      while (this.queue.length > 0 && this.tokens >= 1) {
        this.tokens -= 1;
        const pending = this.queue.shift();
        pending?.resolve();
      }
      // If more waiters remain, schedule another drain
      if (this.queue.length > 0) {
        this.scheduleDrain();
      } else {
        this.draining = false;
      }
    }, waitMs);
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
