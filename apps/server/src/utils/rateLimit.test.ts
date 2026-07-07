import { describe, expect, test } from "bun:test";
import { FixedWindowRateLimiter } from "./rateLimit";

describe("FixedWindowRateLimiter", () => {
  test("allows requests until the fixed window limit is reached", () => {
    const limiter = new FixedWindowRateLimiter({ max: 2, windowMs: 1000 });

    expect(limiter.check("client", 0).allowed).toBe(true);
    const second = limiter.check("client", 10);
    expect(second.allowed).toBe(true);
    expect(second.remaining).toBe(0);

    const blocked = limiter.check("client", 20);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterMs).toBe(980);
  });

  test("resets after the window", () => {
    const limiter = new FixedWindowRateLimiter({ max: 1, windowMs: 1000 });

    expect(limiter.check("client", 0).allowed).toBe(true);
    expect(limiter.check("client", 999).allowed).toBe(false);
    expect(limiter.check("client", 1000).allowed).toBe(true);
  });
});
