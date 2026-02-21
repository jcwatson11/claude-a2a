import { Router, type Request, type Response } from "express";
import type { ClaudeRunner } from "../claude-runner.js";
import type { SessionStore } from "../services/session-store.js";
import type { BudgetTracker } from "../services/budget-tracker.js";

export function healthRouter(
  runner: ClaudeRunner,
  sessionStore: SessionStore,
  budgetTracker: BudgetTracker,
): Router {
  const router = Router();

  router.get("/health", (_req: Request, res: Response) => {
    res.json({
      status: "ok",
      version: "0.1.0",
      uptime_seconds: Math.floor(process.uptime()),
      active_processes: runner.concurrentCount,
      active_sessions: sessionStore.size,
      budget: budgetTracker.getStats(),
    });
  });

  return router;
}
