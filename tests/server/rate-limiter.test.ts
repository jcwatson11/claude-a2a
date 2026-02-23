import { describe, it, expect, vi } from "vitest";
import { RateLimiter } from "../../src/server/services/rate-limiter.js";
import { loadConfig } from "../../src/server/config.js";

describe("RateLimiter", () => {
  it("allows burst requests then blocks", () => {
    const config = loadConfig("/nonexistent");
    config.rate_limiting.requests_per_minute = 10;
    config.rate_limiting.burst = 3;
    const limiter = new RateLimiter(config);

    let allowed = 0;
    let blocked = 0;

    for (let i = 0; i < 6; i++) {
      const req = { authContext: { clientName: "test" } } as any;
      const headers: Record<string, string | number> = {};
      const res = {
        setHeader: (k: string, v: string | number) => { headers[k] = v; },
        status: (code: number) => ({
          json: () => { if (code === 429) blocked++; },
        }),
      } as any;

      limiter.middleware()(req, res, () => { allowed++; });
    }

    // burst=3 means first 3 requests are allowed, rest are blocked
    expect(allowed).toBe(3);
    expect(blocked).toBe(3);
  });

  it("sets rate limit headers on allowed requests", () => {
    const config = loadConfig("/nonexistent");
    config.rate_limiting.requests_per_minute = 60;
    config.rate_limiting.burst = 5;
    const limiter = new RateLimiter(config);

    const req = { authContext: { clientName: "header-test" } } as any;
    const headers: Record<string, string | number> = {};
    const res = {
      setHeader: (k: string, v: string | number) => { headers[k] = v; },
    } as any;

    limiter.middleware()(req, res, () => {});

    expect(headers["X-RateLimit-Limit"]).toBe(60);
    expect(headers["X-RateLimit-Remaining"]).toBeGreaterThanOrEqual(0);
  });

  it("sets Retry-After header on blocked requests", () => {
    const config = loadConfig("/nonexistent");
    config.rate_limiting.requests_per_minute = 10;
    config.rate_limiting.burst = 1;
    const limiter = new RateLimiter(config);

    // Exhaust the single burst token
    const req1 = { authContext: { clientName: "retry-test" } } as any;
    const res1 = { setHeader: () => {} } as any;
    limiter.middleware()(req1, res1, () => {});

    // Second request should be blocked with Retry-After
    const req2 = { authContext: { clientName: "retry-test" } } as any;
    const headers: Record<string, string | number> = {};
    let statusCode = 0;
    const res2 = {
      setHeader: (k: string, v: string | number) => { headers[k] = v; },
      status: (code: number) => {
        statusCode = code;
        return { json: () => {} };
      },
    } as any;

    limiter.middleware()(req2, res2, () => {});

    expect(statusCode).toBe(429);
    expect(headers["Retry-After"]).toBeDefined();
    expect(headers["X-RateLimit-Remaining"]).toBe("0");
  });

  it("skips when disabled", () => {
    const config = loadConfig("/nonexistent");
    config.rate_limiting.enabled = false;
    const limiter = new RateLimiter(config);

    let passed = false;
    const req = {} as any;
    const res = {} as any;
    limiter.middleware()(req, res, () => {
      passed = true;
    });

    expect(passed).toBe(true);
  });

  it("cleanup evicts stale buckets", () => {
    const config = loadConfig("/nonexistent");
    config.rate_limiting.requests_per_minute = 10;
    config.rate_limiting.burst = 5;
    const limiter = new RateLimiter(config);

    // Make a request to create a bucket
    const req = { authContext: { clientName: "stale-client" } } as any;
    const res = { setHeader: () => {} } as any;
    limiter.middleware()(req, res, () => {});
    expect(limiter.bucketCount).toBe(1);

    // Advance time past the 5-minute cutoff
    vi.useFakeTimers();
    vi.advanceTimersByTime(300_001);
    limiter.cleanup();
    vi.useRealTimers();

    expect(limiter.bucketCount).toBe(0);
  });

  it("uses per-client RPM override from authContext", () => {
    const config = loadConfig("/nonexistent");
    config.rate_limiting.requests_per_minute = 10;
    config.rate_limiting.burst = 2;
    const limiter = new RateLimiter(config);

    // Client with higher RPM override — should get burst + 1s refill capacity
    // Default client (rpm=10, burst=2) gets 2 requests then blocked
    // Override client (rpm=120, burst=2) still starts with burst=2 but
    // the X-RateLimit-Limit header should reflect the override
    let allowed = 0;
    const headers: Record<string, string | number> = {};

    for (let i = 0; i < 3; i++) {
      const req = { authContext: { clientName: "fast-client", rateLimitRpm: 120 } } as any;
      const res = {
        setHeader: (k: string, v: string | number) => { headers[k] = v; },
        status: (code: number) => ({
          json: () => {},
        }),
      } as any;
      limiter.middleware()(req, res, () => { allowed++; });
    }

    // Burst is still 2, so first 2 pass, but the rate limit header shows 120
    expect(allowed).toBe(2);
    expect(headers["X-RateLimit-Limit"]).toBe(120);
  });

  it("cleanup keeps recent buckets", () => {
    const config = loadConfig("/nonexistent");
    config.rate_limiting.requests_per_minute = 10;
    config.rate_limiting.burst = 5;
    const limiter = new RateLimiter(config);

    const req = { authContext: { clientName: "active-client" } } as any;
    const res = { setHeader: () => {} } as any;
    limiter.middleware()(req, res, () => {});

    // Don't advance time — bucket is fresh
    limiter.cleanup();
    expect(limiter.bucketCount).toBe(1);
  });
});
