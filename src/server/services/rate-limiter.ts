import type { Request, Response, NextFunction } from "express";
import type { Config } from "../config.js";

interface Bucket {
  tokens: number;
  lastRefill: number;
}

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly rpm: number;
  private readonly burst: number;
  private readonly enabled: boolean;

  constructor(config: Config) {
    this.enabled = config.rate_limiting.enabled;
    this.rpm = config.rate_limiting.requests_per_minute;
    this.burst = config.rate_limiting.burst;
  }

  middleware() {
    return (req: Request, res: Response, next: NextFunction): void => {
      if (!this.enabled) {
        next();
        return;
      }

      const clientName = req.authContext?.clientName ?? "anonymous";
      // Per-client override from JWT
      const clientRpm = req.authContext?.rateLimitRpm ?? this.rpm;

      if (this.tryConsume(clientName, clientRpm)) {
        const bucket = this.buckets.get(clientName)!;
        res.setHeader("X-RateLimit-Limit", clientRpm);
        res.setHeader("X-RateLimit-Remaining", Math.floor(bucket.tokens));
        next();
      } else {
        const retryAfter = Math.ceil(60 / clientRpm);
        res.setHeader("Retry-After", retryAfter);
        res.setHeader("X-RateLimit-Limit", clientRpm);
        res.setHeader("X-RateLimit-Remaining", "0");
        res.status(429).json({
          error: "Rate limit exceeded",
          retry_after_seconds: retryAfter,
        });
      }
    };
  }

  private tryConsume(key: string, rpm: number): boolean {
    const now = Date.now();
    let bucket = this.buckets.get(key);

    if (!bucket) {
      bucket = { tokens: this.burst, lastRefill: now };
      this.buckets.set(key, bucket);
    }

    // Refill tokens based on elapsed time
    const elapsed = (now - bucket.lastRefill) / 1000;
    const tokensPerSecond = rpm / 60;
    bucket.tokens = Math.min(
      this.burst + rpm / 60, // max capacity = burst + 1 second worth
      bucket.tokens + elapsed * tokensPerSecond,
    );
    bucket.lastRefill = now;

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return true;
    }

    return false;
  }

  /** Clean up old buckets periodically */
  cleanup(): void {
    const cutoff = Date.now() - 300_000; // 5 min inactivity
    for (const [key, bucket] of this.buckets) {
      if (bucket.lastRefill < cutoff) {
        this.buckets.delete(key);
      }
    }
  }
}
