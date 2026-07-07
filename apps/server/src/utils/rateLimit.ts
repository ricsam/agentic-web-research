export type RateLimitDecision = {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: Date;
  retryAfterMs: number;
};

type Bucket = {
  count: number;
  resetAt: number;
};

export class FixedWindowRateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(private readonly options: { windowMs: number; max: number }) {}

  check(key: string, now = Date.now()): RateLimitDecision {
    this.cleanup(now);

    const existing = this.buckets.get(key);
    const bucket = existing && existing.resetAt > now
      ? existing
      : { count: 0, resetAt: now + this.options.windowMs };

    if (bucket.count >= this.options.max) {
      this.buckets.set(key, bucket);
      return {
        allowed: false,
        limit: this.options.max,
        remaining: 0,
        resetAt: new Date(bucket.resetAt),
        retryAfterMs: Math.max(bucket.resetAt - now, 0)
      };
    }

    bucket.count += 1;
    this.buckets.set(key, bucket);

    return {
      allowed: true,
      limit: this.options.max,
      remaining: Math.max(this.options.max - bucket.count, 0),
      resetAt: new Date(bucket.resetAt),
      retryAfterMs: Math.max(bucket.resetAt - now, 0)
    };
  }

  private cleanup(now: number) {
    if (this.buckets.size < 1000) return;

    for (const [key, bucket] of this.buckets.entries()) {
      if (bucket.resetAt <= now) this.buckets.delete(key);
    }
  }
}
