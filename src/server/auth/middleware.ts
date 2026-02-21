import type { Request, Response, NextFunction } from "express";
import type { Logger } from "pino";
import type { Config } from "../config.js";
import { verifyToken, type DecodedToken } from "./tokens.js";

export interface AuthContext {
  type: "master" | "jwt" | "ephemeral" | "none";
  clientName: string;
  scopes: string[];
  budgetDailyUsd?: number;
  rateLimitRpm?: number;
  tokenId?: string;
}

// Extend Express Request
declare global {
  namespace Express {
    interface Request {
      authContext?: AuthContext;
    }
  }
}

export function createAuthMiddleware(config: Config, log: Logger) {
  const logger = log.child({ component: "auth" });

  return (req: Request, res: Response, next: NextFunction): void => {
    const authHeader = req.headers["authorization"];

    // No auth configured = allow all
    if (!config.auth.master_key && !config.auth.jwt.secret) {
      req.authContext = {
        type: "none",
        clientName: "anonymous",
        scopes: ["*"],
      };
      next();
      return;
    }

    if (!authHeader) {
      res.status(401).json({ error: "Authorization header required" });
      return;
    }

    const token = authHeader.replace(/^Bearer\s+/i, "");

    // Try master key first
    if (config.auth.master_key && token === config.auth.master_key) {
      req.authContext = {
        type: "master",
        clientName: "master",
        scopes: ["*"],
      };
      logger.debug("master key auth");
      next();
      return;
    }

    // Try JWT
    if (config.auth.jwt.secret) {
      try {
        const decoded: DecodedToken = verifyToken(config, token);
        req.authContext = {
          type: decoded.ephemeral ? "ephemeral" : "jwt",
          clientName: decoded.sub,
          scopes: decoded.scopes,
          budgetDailyUsd: decoded.budget_daily_usd,
          rateLimitRpm: decoded.rate_limit_rpm,
          tokenId: decoded.jti,
        };
        logger.debug({ client: decoded.sub }, "jwt auth");
        next();
        return;
      } catch (err) {
        logger.warn(
          { error: err instanceof Error ? err.message : String(err) },
          "jwt verification failed",
        );
        res.status(401).json({
          error: "Invalid or expired token",
          detail: err instanceof Error ? err.message : undefined,
        });
        return;
      }
    }

    res.status(401).json({ error: "Invalid credentials" });
  };
}

export function requireScope(agentName: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const auth = req.authContext;
    if (!auth) {
      res.status(401).json({ error: "Not authenticated" });
      return;
    }

    if (auth.scopes.includes("*") || auth.scopes.includes(`agent:${agentName}`)) {
      next();
      return;
    }

    res.status(403).json({
      error: "Insufficient scope",
      required: `agent:${agentName}`,
      provided: auth.scopes,
    });
  };
}
