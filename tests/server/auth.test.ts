import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createToken,
  verifyToken,
  revokeToken,
  isRevoked,
} from "../../src/server/auth/tokens.js";
import { loadConfig } from "../../src/server/config.js";
import type { Config } from "../../src/server/config.js";

let config: Config;

beforeEach(() => {
  process.env["CLAUDE_A2A_JWT_SECRET"] = "test-secret-for-testing";
  config = loadConfig("/nonexistent");
});

afterEach(() => {
  delete process.env["CLAUDE_A2A_JWT_SECRET"];
});

describe("JWT tokens", () => {
  it("creates and verifies a token", () => {
    const token = createToken(config, {
      sub: "test-client",
      scopes: ["agent:general"],
    });

    expect(token).toBeTruthy();

    const decoded = verifyToken(config, token);
    expect(decoded.sub).toBe("test-client");
    expect(decoded.scopes).toEqual(["agent:general"]);
    expect(decoded.jti).toBeTruthy();
  });

  it("creates token with optional claims", () => {
    const token = createToken(config, {
      sub: "budget-client",
      scopes: ["agent:general", "agent:code"],
      budget_daily_usd: 10,
      rate_limit_rpm: 60,
    });

    const decoded = verifyToken(config, token);
    expect(decoded.budget_daily_usd).toBe(10);
    expect(decoded.rate_limit_rpm).toBe(60);
    expect(decoded.scopes).toHaveLength(2);
  });

  it("rejects revoked tokens", () => {
    const token = createToken(config, {
      sub: "revoke-test",
      scopes: ["*"],
    });

    const decoded = verifyToken(config, token);
    revokeToken(decoded.jti);
    expect(isRevoked(decoded.jti)).toBe(true);

    expect(() => verifyToken(config, token)).toThrow("revoked");
  });

  it("throws on invalid token", () => {
    expect(() => verifyToken(config, "garbage-token")).toThrow();
  });

  it("throws when no JWT secret configured", () => {
    const noSecretConfig = loadConfig("/nonexistent");
    noSecretConfig.auth.jwt.secret = null;

    expect(() =>
      createToken(noSecretConfig, {
        sub: "test",
        scopes: ["*"],
      }),
    ).toThrow("JWT secret not configured");
  });
});
