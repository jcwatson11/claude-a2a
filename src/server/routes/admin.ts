import { Router, type Request, type Response } from "express";
import { z } from "zod";
import type { Config } from "../config.js";
import type { SessionStore } from "../services/session-store.js";
import type { BudgetTracker } from "../services/budget-tracker.js";
import {
  createToken,
  createRefreshToken,
  verifyRefreshToken,
  revokeToken,
  listRevokedTokens,
} from "../auth/tokens.js";

export const CreateTokenSchema = z.object({
  sub: z.string().min(1, "sub is required"),
  scopes: z.array(z.string()).min(1, "at least one scope is required"),
  budget_daily_usd: z.number().positive().optional(),
  rate_limit_rpm: z.number().int().positive().optional(),
  expires_hours: z.number().positive().optional(),
});

export function adminRouter(config: Config, sessionStore: SessionStore, budgetTracker: BudgetTracker): Router {
  const router = Router();

  // All admin routes require master key auth
  router.use((req: Request, res: Response, next) => {
    if (req.authContext?.type !== "master") {
      res.status(403).json({ error: "Admin routes require master key" });
      return;
    }
    next();
  });

  // Create a new JWT token
  router.post("/tokens", (req: Request, res: Response) => {
    const parsed = CreateTokenSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "Invalid request body",
        details: parsed.error.issues,
      });
      return;
    }

    try {
      const { sub, scopes, budget_daily_usd, rate_limit_rpm, expires_hours } = parsed.data;
      const tokenClaims = { sub, scopes, budget_daily_usd, rate_limit_rpm };

      const token = createToken(config, tokenClaims, expires_hours);

      const response: Record<string, unknown> = { token, sub, scopes };

      if (config.auth.jwt.refresh_enabled) {
        response.refresh_token = createRefreshToken(config, tokenClaims);
      }

      res.json(response);
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : "Token creation failed",
      });
    }
  });

  // Revoke a token
  router.delete("/tokens/:jti", (req: Request, res: Response) => {
    const jti = req.params["jti"];
    if (!jti || typeof jti !== "string") {
      res.status(400).json({ error: "Missing token ID" });
      return;
    }
    revokeToken(jti);
    res.json({ revoked: jti });
  });

  // Refresh an access token using a refresh token
  router.post("/tokens/refresh", (req: Request, res: Response) => {
    if (!config.auth.jwt.refresh_enabled) {
      res.status(400).json({ error: "Refresh tokens are not enabled" });
      return;
    }

    const { refresh_token } = req.body as { refresh_token?: string };
    if (!refresh_token || typeof refresh_token !== "string") {
      res.status(400).json({ error: "refresh_token is required" });
      return;
    }

    try {
      const decoded = verifyRefreshToken(config, refresh_token);

      const token = createToken(config, {
        sub: decoded.sub,
        scopes: decoded.scopes,
        budget_daily_usd: decoded.budget_daily_usd,
        rate_limit_rpm: decoded.rate_limit_rpm,
      });

      res.json({ token, sub: decoded.sub, scopes: decoded.scopes });
    } catch (err) {
      res.status(401).json({
        error: "Invalid refresh token",
        detail: err instanceof Error ? err.message : undefined,
      });
    }
  });

  // List revoked tokens
  router.get("/tokens/revoked", (_req: Request, res: Response) => {
    res.json({ revoked: listRevokedTokens() });
  });

  // List sessions
  router.get("/sessions", (req: Request, res: Response) => {
    const client = req.query["client"];
    const clientName = typeof client === "string" ? client : undefined;
    const sessions = clientName
      ? sessionStore.listForClient(clientName)
      : sessionStore.listAll();
    res.json({ sessions, count: sessions.length });
  });

  // Delete a session
  router.delete("/sessions/:id", (req: Request, res: Response) => {
    const { id } = req.params;
    if (!id) {
      res.status(400).json({ error: "Missing session ID" });
      return;
    }
    const deleted = sessionStore.delete(typeof id === "string" ? id : id[0]!);
    res.json({ deleted, session_id: id });
  });

  // Server stats (includes budget details)
  router.get("/stats", (_req: Request, res: Response) => {
    res.json({
      sessions: sessionStore.listAll().length,
      agents: Object.entries(config.agents)
        .filter(([_, a]) => a.enabled)
        .map(([name]) => name),
      budget: budgetTracker.getStats(),
    });
  });

  return router;
}
