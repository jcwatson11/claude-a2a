import { Router, type Request, type Response } from "express";
import type { ClaudeRunner } from "../claude-runner.js";
import type { SessionStore } from "../services/session-store.js";
import { VERSION } from "../../version.js";

export function healthRouter(
  runner: ClaudeRunner,
  sessionStore: SessionStore,
): Router {
  const router = Router();

  router.get("/health", (_req: Request, res: Response) => {
    res.json({
      status: "ok",
      version: VERSION,
      uptime_seconds: Math.floor(process.uptime()),
      active_sessions: runner.concurrentCount,
      total_sessions: sessionStore.size,
    });
  });

  return router;
}
