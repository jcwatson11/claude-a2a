import { Router, type Request, type Response } from "express";
import type { Config } from "../config.js";
import type { SessionStore } from "../services/session-store.js";
import { createToken, revokeToken, listRevokedTokens } from "../auth/tokens.js";

export function adminRouter(config: Config, sessionStore: SessionStore): Router {
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
    try {
      const { sub, scopes, budget_daily_usd, rate_limit_rpm, expires_hours } =
        req.body as {
          sub: string;
          scopes: string[];
          budget_daily_usd?: number;
          rate_limit_rpm?: number;
          expires_hours?: number;
        };

      if (!sub || !scopes) {
        res
          .status(400)
          .json({ error: "Missing required fields: sub, scopes" });
        return;
      }

      const token = createToken(
        config,
        { sub, scopes, budget_daily_usd, rate_limit_rpm },
        expires_hours,
      );

      res.json({ token, sub, scopes });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : "Token creation failed",
      });
    }
  });

  // Revoke a token
  router.delete("/tokens/:jti", (req: Request, res: Response) => {
    const { jti } = req.params;
    if (!jti) {
      res.status(400).json({ error: "Missing token ID" });
      return;
    }
    revokeToken(jti);
    res.json({ revoked: jti });
  });

  // List revoked tokens
  router.get("/tokens/revoked", (_req: Request, res: Response) => {
    res.json({ revoked: listRevokedTokens() });
  });

  // List sessions
  router.get("/sessions", (req: Request, res: Response) => {
    const client = req.query["client"] as string | undefined;
    const sessions = client
      ? sessionStore.listForClient(client)
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
    const deleted = sessionStore.delete(id);
    res.json({ deleted, session_id: id });
  });

  // Server stats
  router.get("/stats", (_req: Request, res: Response) => {
    res.json({
      sessions: sessionStore.listAll().length,
      agents: Object.entries(config.agents)
        .filter(([_, a]) => a.enabled)
        .map(([name]) => name),
    });
  });

  return router;
}
