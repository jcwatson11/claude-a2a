import { describe, it, expect, beforeEach, afterEach } from "vitest";
import express, { type Request, type Response, type NextFunction } from "express";
import request from "supertest";
import pino from "pino";
import { CreateTokenSchema, adminRouter } from "../../src/server/routes/admin.js";
import { loadConfig } from "../../src/server/config.js";
import type { Config } from "../../src/server/config.js";
import type { AuthContext } from "../../src/server/auth/middleware.js";
import { AppDatabase } from "../../src/server/services/database.js";
import { SessionStore } from "../../src/server/services/session-store.js";
import { BudgetTracker } from "../../src/server/services/budget-tracker.js";
import {
  createToken,
  createRefreshToken,
  verifyToken,
  initRevocationStore,
  _resetRevocationStore,
  revokeToken,
} from "../../src/server/auth/tokens.js";

const log = pino({ level: "silent" });

// ---------------------------------------------------------------------------
// CreateTokenSchema (existing tests)
// ---------------------------------------------------------------------------

describe("CreateTokenSchema", () => {
  it("accepts valid token creation request", () => {
    const result = CreateTokenSchema.safeParse({
      sub: "test-client",
      scopes: ["agent:general"],
    });
    expect(result.success).toBe(true);
  });

  it("accepts optional fields", () => {
    const result = CreateTokenSchema.safeParse({
      sub: "test-client",
      scopes: ["agent:general", "agent:code"],
      budget_daily_usd: 10,
      rate_limit_rpm: 60,
      expires_hours: 24,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.budget_daily_usd).toBe(10);
      expect(result.data.rate_limit_rpm).toBe(60);
      expect(result.data.expires_hours).toBe(24);
    }
  });

  it("rejects missing sub", () => {
    const result = CreateTokenSchema.safeParse({
      scopes: ["agent:general"],
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty sub", () => {
    const result = CreateTokenSchema.safeParse({
      sub: "",
      scopes: ["agent:general"],
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing scopes", () => {
    const result = CreateTokenSchema.safeParse({
      sub: "test-client",
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty scopes array", () => {
    const result = CreateTokenSchema.safeParse({
      sub: "test-client",
      scopes: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects negative budget", () => {
    const result = CreateTokenSchema.safeParse({
      sub: "test-client",
      scopes: ["*"],
      budget_daily_usd: -5,
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-integer rate limit", () => {
    const result = CreateTokenSchema.safeParse({
      sub: "test-client",
      scopes: ["*"],
      rate_limit_rpm: 1.5,
    });
    expect(result.success).toBe(false);
  });

  it("strips unknown fields", () => {
    const result = CreateTokenSchema.safeParse({
      sub: "test-client",
      scopes: ["*"],
      evil_field: "should be ignored",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect("evil_field" in result.data).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// adminRouter — route handler tests
// ---------------------------------------------------------------------------

describe("adminRouter", () => {
  let config: Config;
  let appDb: AppDatabase;
  let sessionStore: SessionStore;
  let budgetTracker: BudgetTracker;

  beforeEach(() => {
    process.env["CLAUDE_A2A_JWT_SECRET"] = "test-secret-for-admin-tests";
    config = loadConfig("/nonexistent");
    appDb = new AppDatabase(":memory:", log);
    _resetRevocationStore();
    initRevocationStore(appDb, log);
    sessionStore = new SessionStore(config, log, appDb);
    budgetTracker = new BudgetTracker(config, log, appDb);
  });

  afterEach(() => {
    sessionStore.stop();
    _resetRevocationStore();
    appDb.close();
    delete process.env["CLAUDE_A2A_JWT_SECRET"];
  });

  // -- Helpers --

  function buildApp(authContext: AuthContext): express.Express {
    const app = express();
    app.use(express.json());
    app.use((_req: Request, _res: Response, next: NextFunction) => {
      _req.authContext = authContext;
      next();
    });
    app.use(adminRouter(config, sessionStore, budgetTracker));
    return app;
  }

  function masterApp(): express.Express {
    return buildApp({ type: "master", clientName: "master", scopes: ["*"] });
  }

  function jwtApp(): express.Express {
    return buildApp({ type: "jwt", clientName: "test-client", scopes: ["agent:general"] });
  }

  // -- Guard middleware --

  describe("guard middleware", () => {
    it("returns 403 for non-master auth", async () => {
      const res = await request(jwtApp()).get("/sessions");
      expect(res.status).toBe(403);
      expect(res.body.error).toBe("Admin routes require master key");
    });
  });

  // -- POST /tokens --

  describe("POST /tokens", () => {
    it("creates a token with valid body", async () => {
      const res = await request(masterApp())
        .post("/tokens")
        .send({ sub: "new-client", scopes: ["agent:general"] });

      expect(res.status).toBe(200);
      expect(res.body.token).toBeTruthy();
      expect(res.body.sub).toBe("new-client");
      expect(res.body.scopes).toEqual(["agent:general"]);
      expect(res.body.refresh_token).toBeUndefined();

      // Verify the returned token is actually valid
      const decoded = verifyToken(config, res.body.token);
      expect(decoded.sub).toBe("new-client");
    });

    it("includes refresh_token when refresh is enabled", async () => {
      config.auth.jwt.refresh_enabled = true;
      const res = await request(masterApp())
        .post("/tokens")
        .send({ sub: "refresh-client", scopes: ["*"] });

      expect(res.status).toBe(200);
      expect(res.body.token).toBeTruthy();
      expect(res.body.refresh_token).toBeTruthy();
    });

    it("returns 400 for invalid body", async () => {
      const res = await request(masterApp())
        .post("/tokens")
        .send({ sub: "", scopes: [] });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Invalid request body");
      expect(Array.isArray(res.body.details)).toBe(true);
      expect(res.body.details.length).toBeGreaterThanOrEqual(1);
    });
  });

  // -- DELETE /tokens/:jti --

  describe("DELETE /tokens/:jti", () => {
    it("revokes a token by JTI", async () => {
      const res = await request(masterApp()).delete("/tokens/some-jti-value");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ revoked: "some-jti-value" });
    });

    it("revocation takes effect on real tokens", async () => {
      const token = createToken(config, { sub: "revoke-me", scopes: ["*"] });
      const decoded = verifyToken(config, token);

      const res = await request(masterApp()).delete(`/tokens/${decoded.jti}`);
      expect(res.status).toBe(200);

      expect(() => verifyToken(config, token)).toThrow("revoked");
    });
  });

  // -- POST /tokens/refresh --

  describe("POST /tokens/refresh", () => {
    it("returns new token for valid refresh token", async () => {
      config.auth.jwt.refresh_enabled = true;
      const refreshToken = createRefreshToken(config, {
        sub: "refresh-me",
        scopes: ["agent:general"],
        budget_daily_usd: 5,
      });

      const res = await request(masterApp())
        .post("/tokens/refresh")
        .send({ refresh_token: refreshToken });

      expect(res.status).toBe(200);
      expect(res.body.token).toBeTruthy();
      expect(res.body.sub).toBe("refresh-me");
      expect(res.body.scopes).toEqual(["agent:general"]);

      // Verify the returned token works
      const decoded = verifyToken(config, res.body.token);
      expect(decoded.sub).toBe("refresh-me");
    });

    it("returns 400 when refresh is disabled", async () => {
      // refresh_enabled defaults to false
      const res = await request(masterApp())
        .post("/tokens/refresh")
        .send({ refresh_token: "anything" });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Refresh tokens are not enabled");
    });

    it("returns 400 when refresh_token is missing", async () => {
      config.auth.jwt.refresh_enabled = true;
      const res = await request(masterApp())
        .post("/tokens/refresh")
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("refresh_token is required");
    });

    it("returns 401 for invalid refresh token", async () => {
      config.auth.jwt.refresh_enabled = true;
      const res = await request(masterApp())
        .post("/tokens/refresh")
        .send({ refresh_token: "not-a-valid-jwt" });

      expect(res.status).toBe(401);
      expect(res.body.error).toBe("Invalid refresh token");
    });
  });

  // -- GET /tokens/revoked --

  describe("GET /tokens/revoked", () => {
    it("returns list of revoked tokens", async () => {
      const app = masterApp();

      // Initially empty
      const res1 = await request(app).get("/tokens/revoked");
      expect(res1.status).toBe(200);
      expect(res1.body.revoked).toEqual([]);

      // Revoke some tokens via the API
      await request(app).delete("/tokens/jti-1");
      await request(app).delete("/tokens/jti-2");

      const res2 = await request(app).get("/tokens/revoked");
      expect(res2.status).toBe(200);
      expect(res2.body.revoked).toContain("jti-1");
      expect(res2.body.revoked).toContain("jti-2");
      expect(res2.body.revoked).toHaveLength(2);
    });
  });

  // -- GET /sessions --

  describe("GET /sessions", () => {
    it("returns all sessions with count", async () => {
      sessionStore.create("s1", "general", "alice", "ctx-1", "task-1");
      sessionStore.create("s2", "general", "bob", "ctx-2", "task-2");

      const res = await request(masterApp()).get("/sessions");
      expect(res.status).toBe(200);
      expect(res.body.count).toBe(2);
      expect(res.body.sessions).toHaveLength(2);
    });

    it("filters by client query parameter", async () => {
      sessionStore.create("s1", "general", "alice", "ctx-1", "task-1");
      sessionStore.create("s2", "general", "alice", "ctx-2", "task-2");
      sessionStore.create("s3", "general", "bob", "ctx-3", "task-3");

      const res = await request(masterApp()).get("/sessions?client=alice");
      expect(res.status).toBe(200);
      expect(res.body.count).toBe(2);
      expect(res.body.sessions.every((s: { clientName: string }) => s.clientName === "alice")).toBe(true);
    });

    it("returns empty when client has no sessions", async () => {
      sessionStore.create("s1", "general", "alice", "ctx-1", "task-1");

      const res = await request(masterApp()).get("/sessions?client=nobody");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ sessions: [], count: 0 });
    });
  });

  // -- DELETE /sessions/:id --

  describe("DELETE /sessions/:id", () => {
    it("deletes an existing session", async () => {
      sessionStore.create("s1", "general", "alice", "ctx-1", "task-1");

      const res = await request(masterApp()).delete("/sessions/s1");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ deleted: true, session_id: "s1" });
      expect(sessionStore.get("s1")).toBeUndefined();
    });

    it("returns false for unknown session", async () => {
      const res = await request(masterApp()).delete("/sessions/nonexistent");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ deleted: false, session_id: "nonexistent" });
    });
  });

  // -- GET /stats --

  describe("GET /stats", () => {
    it("returns server statistics", async () => {
      sessionStore.create("s1", "general", "alice", "ctx-1", "task-1");
      budgetTracker.record_cost("alice", 0.5);

      const res = await request(masterApp()).get("/stats");
      expect(res.status).toBe(200);
      expect(res.body.sessions).toBe(1);
      expect(Array.isArray(res.body.agents)).toBe(true);
      expect(res.body.agents).toContain("general");
      expect(res.body.budget).toBeDefined();
      expect(res.body.budget.global_spent).toBe(0.5);
      expect(res.body.budget.global_limit).toBe(config.budgets.global_daily_limit_usd);
      expect(res.body.budget.clients).toHaveProperty("alice", 0.5);
    });
  });
});
