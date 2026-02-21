import { describe, it, expect } from "vitest";
import { RateLimiter } from "../../src/server/services/rate-limiter.js";
import { loadConfig } from "../../src/server/config.js";

describe("RateLimiter", () => {
  it("allows requests within limit", () => {
    const config = loadConfig("/nonexistent");
    config.rate_limiting.requests_per_minute = 10;
    config.rate_limiting.burst = 5;
    const limiter = new RateLimiter(config);

    // Simulate middleware
    let allowed = 0;
    let blocked = 0;

    for (let i = 0; i < 8; i++) {
      const req = { authContext: { clientName: "test" } } as any;
      const res = {
        setHeader: () => {},
        status: (code: number) => ({
          json: () => {
            if (code === 429) blocked++;
          },
        }),
      } as any;

      let nextCalled = false;
      const next = () => {
        nextCalled = true;
        allowed++;
      };

      limiter.middleware()(req, res, next);
    }

    // With burst=5 and rpm=10, we should get some allowed
    expect(allowed).toBeGreaterThan(0);
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
});
