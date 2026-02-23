import { describe, it, expect, beforeEach, afterEach } from "vitest";
import jwt from "jsonwebtoken";
import {
  createToken,
  createRefreshToken,
  verifyToken,
  verifyRefreshToken,
  revokeToken,
  isRevoked,
  initRevocationStore,
  _resetRevocationStore,
} from "../../src/server/auth/tokens.js";
import { createAuthMiddleware } from "../../src/server/auth/middleware.js";
import type { AuthContext } from "../../src/server/auth/middleware.js";
import { AppDatabase } from "../../src/server/services/database.js";
import { loadConfig } from "../../src/server/config.js";
import type { Config } from "../../src/server/config.js";
import type { Request, Response, NextFunction } from "express";
import pino from "pino";

let config: Config;
let appDb: AppDatabase;

beforeEach(() => {
  appDb = new AppDatabase(":memory:", log);
  _resetRevocationStore();
  process.env["CLAUDE_A2A_JWT_SECRET"] = "test-secret-for-testing";
  config = loadConfig("/nonexistent");
});

afterEach(() => {
  _resetRevocationStore();
  appDb.close();
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
    initRevocationStore(appDb, log);

    const token = createToken(config, {
      sub: "revoke-test",
      scopes: ["*"],
    });

    const decoded = verifyToken(config, token);
    revokeToken(decoded.jti);
    expect(isRevoked(decoded.jti)).toBe(true);

    expect(() => verifyToken(config, token)).toThrow("revoked");
  });

  it("persists revoked tokens across reloads", () => {
    initRevocationStore(appDb, log);

    const token = createToken(config, {
      sub: "persist-test",
      scopes: ["*"],
    });

    const decoded = verifyToken(config, token);
    revokeToken(decoded.jti);

    // Simulate restart: reset in-memory state and re-init from same DB
    _resetRevocationStore();
    initRevocationStore(appDb, log);

    expect(isRevoked(decoded.jti)).toBe(true);
    expect(() => verifyToken(config, token)).toThrow("revoked");
  });

  it("throws on invalid token", () => {
    expect(() => verifyToken(config, "garbage-token")).toThrow();
  });

  it("rejects tokens signed with alg 'none'", () => {
    // Craft an unsigned JWT with alg: "none" — the classic JWT bypass attack
    const payload = {
      sub: "attacker",
      jti: "fake-jti",
      scopes: ["*"],
      token_type: "access",
    };
    const unsignedToken = jwt.sign(payload, "", { algorithm: "none" as jwt.Algorithm });

    expect(() => verifyToken(config, unsignedToken)).toThrow();
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

const log = pino({ level: "silent" });

function mockReq(headers: Record<string, string> = {}): Request {
  return { headers, authContext: undefined } as unknown as Request;
}

function mockRes(): Response & { statusCode: number; body: unknown } {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(data: unknown) {
      res.body = data;
      return res;
    },
  };
  return res as unknown as Response & { statusCode: number; body: unknown };
}

describe("createAuthMiddleware", () => {
  it("allows anonymous access when no auth is configured", () => {
    const noAuthConfig = loadConfig("/nonexistent");
    noAuthConfig.auth.master_key = null;
    noAuthConfig.auth.jwt.secret = null;

    const middleware = createAuthMiddleware(noAuthConfig, log);
    const req = mockReq();
    const res = mockRes();
    let called = false;

    middleware(req, res, () => { called = true; });

    expect(called).toBe(true);
    const auth = (req as unknown as { authContext: AuthContext }).authContext;
    expect(auth.type).toBe("none");
    expect(auth.clientName).toBe("anonymous");
    expect(auth.scopes).toEqual(["*"]);
  });

  it("returns 401 when auth is configured but no header provided", () => {
    const middleware = createAuthMiddleware(config, log);
    const req = mockReq();
    const res = mockRes();
    let called = false;

    middleware(req, res, () => { called = true; });

    expect(called).toBe(false);
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: "Authorization header required" });
  });

  it("authenticates with master key", () => {
    const cfg = loadConfig("/nonexistent");
    cfg.auth.master_key = "my-secret-key";

    const middleware = createAuthMiddleware(cfg, log);
    const req = mockReq({ authorization: "Bearer my-secret-key" });
    const res = mockRes();
    let called = false;

    middleware(req, res, () => { called = true; });

    expect(called).toBe(true);
    const auth = (req as unknown as { authContext: AuthContext }).authContext;
    expect(auth.type).toBe("master");
    expect(auth.clientName).toBe("master");
    expect(auth.scopes).toEqual(["*"]);
  });

  it("rejects wrong master key", () => {
    const cfg = loadConfig("/nonexistent");
    cfg.auth.master_key = "correct-key";
    cfg.auth.jwt.secret = null;

    const middleware = createAuthMiddleware(cfg, log);
    const req = mockReq({ authorization: "Bearer wrong-key" });
    const res = mockRes();
    let called = false;

    middleware(req, res, () => { called = true; });

    expect(called).toBe(false);
    expect(res.statusCode).toBe(401);
  });

  it("authenticates with valid JWT", () => {
    const middleware = createAuthMiddleware(config, log);
    const token = createToken(config, {
      sub: "jwt-client",
      scopes: ["agent:general"],
      budget_daily_usd: 5,
      rate_limit_rpm: 30,
    });
    const req = mockReq({ authorization: `Bearer ${token}` });
    const res = mockRes();
    let called = false;

    middleware(req, res, () => { called = true; });

    expect(called).toBe(true);
    const auth = (req as unknown as { authContext: AuthContext }).authContext;
    expect(auth.type).toBe("jwt");
    expect(auth.clientName).toBe("jwt-client");
    expect(auth.scopes).toEqual(["agent:general"]);
    expect(auth.budgetDailyUsd).toBe(5);
    expect(auth.rateLimitRpm).toBe(30);
    expect(auth.tokenId).toBeTruthy();
  });

  it("rejects invalid JWT", () => {
    const middleware = createAuthMiddleware(config, log);
    const req = mockReq({ authorization: "Bearer not-a-valid-jwt" });
    const res = mockRes();
    let called = false;

    middleware(req, res, () => { called = true; });

    expect(called).toBe(false);
    expect(res.statusCode).toBe(401);
    expect((res.body as { error: string }).error).toBe("Invalid or expired token");
    expect((res.body as Record<string, unknown>).detail).toBeUndefined();
  });

  it("includes error detail in 401 when jwt.debug is true", () => {
    const cfg = loadConfig("/nonexistent");
    cfg.auth.jwt.debug = true;

    const middleware = createAuthMiddleware(cfg, log);
    const req = mockReq({ authorization: "Bearer not-a-valid-jwt" });
    const res = mockRes();

    middleware(req, res, () => {});

    expect(res.statusCode).toBe(401);
    expect((res.body as Record<string, unknown>).detail).toBeDefined();
    expect(typeof (res.body as Record<string, unknown>).detail).toBe("string");
  });

  it("omits error detail in 401 when jwt.debug is false", () => {
    const cfg = loadConfig("/nonexistent");
    cfg.auth.jwt.debug = false;

    const middleware = createAuthMiddleware(cfg, log);
    const req = mockReq({ authorization: "Bearer not-a-valid-jwt" });
    const res = mockRes();

    middleware(req, res, () => {});

    expect(res.statusCode).toBe(401);
    expect((res.body as Record<string, unknown>).detail).toBeUndefined();
  });

  it("rejects revoked JWT", () => {
    initRevocationStore(appDb, log);

    const middleware = createAuthMiddleware(config, log);
    const token = createToken(config, {
      sub: "revoke-me",
      scopes: ["*"],
    });

    // Revoke it
    const decoded = verifyToken(config, token);
    revokeToken(decoded.jti);

    const req = mockReq({ authorization: `Bearer ${token}` });
    const res = mockRes();
    let called = false;

    middleware(req, res, () => { called = true; });

    expect(called).toBe(false);
    expect(res.statusCode).toBe(401);
    expect((res.body as { error: string }).error).toBe("Invalid or expired token");
  });

  it("prefers master key over JWT when both configured", () => {
    const cfg = loadConfig("/nonexistent");
    cfg.auth.master_key = "the-master-key";
    cfg.auth.jwt.secret = "some-jwt-secret";

    const middleware = createAuthMiddleware(cfg, log);
    const req = mockReq({ authorization: "Bearer the-master-key" });
    const res = mockRes();
    let called = false;

    middleware(req, res, () => { called = true; });

    expect(called).toBe(true);
    const auth = (req as unknown as { authContext: AuthContext }).authContext;
    expect(auth.type).toBe("master");
  });

  it("rejects refresh tokens used as access tokens", () => {
    const cfg = loadConfig("/nonexistent");
    cfg.auth.jwt.refresh_enabled = true;

    const middleware = createAuthMiddleware(cfg, log);
    const refreshToken = createRefreshToken(cfg, {
      sub: "sneaky-client",
      scopes: ["*"],
    });

    const req = mockReq({ authorization: `Bearer ${refreshToken}` });
    const res = mockRes();
    let called = false;

    middleware(req, res, () => { called = true; });

    expect(called).toBe(false);
    expect(res.statusCode).toBe(401);
    expect((res.body as { error: string }).error).toBe(
      "Refresh tokens cannot be used for API access",
    );
  });
});

describe("Refresh tokens", () => {
  it("creates and verifies a refresh token", () => {
    config.auth.jwt.refresh_enabled = true;

    const token = createRefreshToken(config, {
      sub: "refresh-client",
      scopes: ["agent:general"],
    });

    const decoded = verifyRefreshToken(config, token);
    expect(decoded.sub).toBe("refresh-client");
    expect(decoded.scopes).toEqual(["agent:general"]);
    expect(decoded.token_type).toBe("refresh");
  });

  it("throws when refresh is not enabled", () => {
    config.auth.jwt.refresh_enabled = false;

    expect(() =>
      createRefreshToken(config, {
        sub: "test",
        scopes: ["*"],
      }),
    ).toThrow("Refresh tokens are not enabled");
  });

  it("rejects access tokens passed to verifyRefreshToken", () => {
    config.auth.jwt.refresh_enabled = true;

    const accessToken = createToken(config, {
      sub: "test",
      scopes: ["*"],
    });

    expect(() => verifyRefreshToken(config, accessToken)).toThrow(
      "Token is not a refresh token",
    );
  });

  it("preserves claims on refresh token", () => {
    config.auth.jwt.refresh_enabled = true;

    const token = createRefreshToken(config, {
      sub: "budget-client",
      scopes: ["agent:general", "agent:code"],
      budget_daily_usd: 15,
      rate_limit_rpm: 45,
    });

    const decoded = verifyRefreshToken(config, token);
    expect(decoded.budget_daily_usd).toBe(15);
    expect(decoded.rate_limit_rpm).toBe(45);
    expect(decoded.scopes).toEqual(["agent:general", "agent:code"]);
  });

  it("revoked refresh tokens are rejected", () => {
    config.auth.jwt.refresh_enabled = true;
    initRevocationStore(appDb, log);

    const token = createRefreshToken(config, {
      sub: "revoke-refresh",
      scopes: ["*"],
    });

    const decoded = verifyRefreshToken(config, token);
    revokeToken(decoded.jti);

    expect(() => verifyRefreshToken(config, token)).toThrow("revoked");
  });

  it("access tokens include token_type access", () => {
    const token = createToken(config, {
      sub: "typed-client",
      scopes: ["*"],
    });

    const decoded = verifyToken(config, token);
    expect(decoded.token_type).toBe("access");
  });
});
