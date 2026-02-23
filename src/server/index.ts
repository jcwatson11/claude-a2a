import express from "express";
import { AGENT_CARD_PATH } from "@a2a-js/sdk";
import {
  DefaultRequestHandler,
} from "@a2a-js/sdk/server";
import {
  agentCardHandler,
  jsonRpcHandler,
  restHandler,
} from "@a2a-js/sdk/server/express";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import pino from "pino";
import type { Config } from "./config.js";
import { buildAgentCard } from "./agent-card.js";
import { ClaudeRunner } from "./claude-runner.js";
import { ClaudeAgentExecutor } from "./agent-executor.js";
import { createAuthMiddleware } from "./auth/middleware.js";
import { initRevocationStore } from "./auth/tokens.js";
import { AuthenticatedUser } from "./auth/user.js";
import { RateLimiter } from "./services/rate-limiter.js";
import { AppDatabase } from "./services/database.js";
import { BudgetTracker } from "./services/budget-tracker.js";
import { SessionStore } from "./services/session-store.js";
import { SqliteTaskStore } from "./services/task-store.js";
import { healthRouter } from "./routes/health.js";
import { adminRouter } from "./routes/admin.js";
import type { Request } from "express";
import { User, UnauthenticatedUser } from "@a2a-js/sdk/server";

export async function startServer(config: Config): Promise<void> {
  const log = pino({
    level: process.env["LOG_LEVEL"] ?? "info",
    transport:
      process.env["NODE_ENV"] !== "production"
        ? { target: "pino/file", options: { destination: 1 } }
        : undefined,
  });

  process.on("uncaughtException", (err) => {
    log.fatal({ err }, "uncaught exception");
    process.exit(1);
  });

  process.on("unhandledRejection", (reason) => {
    log.fatal({ reason }, "unhandled rejection");
    process.exit(1);
  });

  log.info("starting claude-a2a server");

  // Verify Claude binary is available
  const binaryCheck = checkClaudeBinary(config.claude.binary);
  if (binaryCheck.ok) {
    log.info({ binary: config.claude.binary, version: binaryCheck.version }, "claude binary found");
  } else {
    log.fatal(
      { binary: config.claude.binary },
      "claude binary not found or not executable — cannot start server",
    );
    process.exit(1);
  }

  // Ensure data directory and work directories exist
  validateDirectories(config, log);

  // Open database
  const appDb = new AppDatabase(`${config.data_dir}/claude-a2a.db`, log);

  // Migrate legacy JSON files to SQLite (one-time, on first startup after upgrade)
  migrateLegacyData(config, appDb, log);

  // Initialize components
  initRevocationStore(appDb, log);

  const runner = new ClaudeRunner(config, log);
  const sessionStore = new SessionStore(config, log, appDb, {
    onSessionEvicted: (contextId) => runner.destroySession(contextId),
  });
  const budgetTracker = new BudgetTracker(config, log, appDb);
  const rateLimiter = new RateLimiter(config);

  sessionStore.start();
  rateLimiter.start();

  // Build A2A agent card and executor
  const agentCard = buildAgentCard(config);
  const executor = new ClaudeAgentExecutor(
    runner,
    config,
    sessionStore,
    budgetTracker,
    log,
  );

  const taskStore = new SqliteTaskStore(appDb);
  const requestHandler = new DefaultRequestHandler(
    agentCard,
    taskStore,
    executor,
  );

  // Build a UserBuilder that passes through auth context
  const userBuilder: (req: Request) => Promise<User | UnauthenticatedUser> = async (req) => {
    if (req.authContext) {
      return new AuthenticatedUser(req.authContext);
    }
    return new UnauthenticatedUser();
  };

  // Set up Express app
  const app = express();
  app.use(express.json({ limit: config.server.max_body_size }));

  // Request correlation ID middleware
  app.use(requestIdMiddleware());

  // Request/response logging middleware
  app.use(requestLoggingMiddleware(log));

  // Request timeout middleware
  app.use(requestTimeoutMiddleware(config.server.request_timeout));

  // Auth middleware for A2A and admin routes
  const authMiddleware = createAuthMiddleware(config, log);

  // Health check (no auth required)
  app.use(healthRouter(runner, sessionStore));

  // Agent card (no auth required for discovery)
  app.use(
    `/${AGENT_CARD_PATH}`,
    agentCardHandler({ agentCardProvider: requestHandler }),
  );
  app.use(
    `/.well-known/agent.json`,
    agentCardHandler({ agentCardProvider: requestHandler }),
  );

  // A2A endpoints (with auth + rate limiting)
  app.use("/a2a/jsonrpc", authMiddleware, rateLimiter.middleware(), jsonRpcHandler({
    requestHandler,
    userBuilder,
  }));
  app.use("/a2a/rest", authMiddleware, rateLimiter.middleware(), restHandler({
    requestHandler,
    userBuilder,
  }));

  // Admin routes (auth required)
  app.use("/admin", authMiddleware, adminRouter(config, sessionStore, budgetTracker));

  // If no auth is configured, force bind to localhost only
  let { host, port } = config.server;
  if (!config.auth.master_key && !config.auth.jwt.secret) {
    if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
      log.warn(
        { original: host, override: "127.0.0.1" },
        "no auth configured — overriding host to 127.0.0.1 to prevent unauthenticated network exposure",
      );
      host = "127.0.0.1";
    }
    log.warn("running without authentication — only accessible from localhost");
  }

  // Start listening
  const server = app.listen(port, host, () => {
    log.info({ host, port }, "claude-a2a listening");
    log.info(
      {
        agents: Object.entries(config.agents)
          .filter(([_, a]) => a.enabled)
          .map(([name]) => name),
        agentCardUrl: `http://${host === "0.0.0.0" ? "localhost" : host}:${port}/${AGENT_CARD_PATH}`,
      },
      "enabled agents",
    );
  });

  // Graceful shutdown — release processes (they continue running independently)
  const shutdown = async () => {
    log.info("shutting down");
    await runner.releaseAll(taskStore);        // update in-flight tasks + release processes
    sessionStore.markAllProcessesDead();       // persist processAlive=false to SQLite
    sessionStore.stop();                       // stop cleanup timer
    rateLimiter.stop();                        // stop rate limiter timer
    appDb.close();                             // close database (after all writes done)
    server.close(() => {
      log.info("server closed");
      process.exit(0);
    });
    // Force exit after 10s
    setTimeout(() => process.exit(1), 10_000);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

const VALID_REQUEST_ID = /^[\w.\-]{1,128}$/;

/** Express middleware that assigns a correlation ID to each request. Exported for testing. */
export function requestIdMiddleware() {
  return (req: Request, res: express.Response, next: express.NextFunction): void => {
    const header = req.headers["x-request-id"] as string | undefined;
    const id = header && VALID_REQUEST_ID.test(header) ? header : randomUUID();
    req.requestId = id;
    res.setHeader("X-Request-ID", id);
    next();
  };
}

/** Express middleware that logs request method, path, status code, and duration. Exported for testing. */
export function requestLoggingMiddleware(logger: pino.Logger) {
  return (req: Request, res: express.Response, next: express.NextFunction): void => {
    const start = Date.now();
    res.on("finish", () => {
      const duration = Date.now() - start;
      logger.info(
        {
          method: req.method,
          path: req.originalUrl,
          status: res.statusCode,
          duration,
          requestId: req.requestId,
        },
        "request completed",
      );
    });
    next();
  };
}

/** Express middleware that enforces a request timeout. Exported for testing. */
export function requestTimeoutMiddleware(timeoutSeconds: number) {
  const timeoutMs = timeoutSeconds * 1000;
  return (req: Request, res: express.Response, next: express.NextFunction): void => {
    req.setTimeout(timeoutMs, () => {
      if (!res.headersSent) {
        res.status(408).json({ error: "Request timeout" });
      }
    });
    next();
  };
}

/**
 * Validate and prepare directories at startup.
 * - data_dir and default work_dir are auto-created (they're ours to manage).
 * - Per-agent work_dir overrides must already exist (they point to external projects).
 */
export function validateDirectories(config: Config, log: pino.Logger): void {
  // Ensure data_dir exists
  mkdirSync(config.data_dir, { recursive: true });

  // Ensure default work_dir exists (derived from data_dir)
  const defaultWorkDir = config.claude.work_dir;
  if (defaultWorkDir) {
    mkdirSync(defaultWorkDir, { recursive: true });
    log.info({ workDir: defaultWorkDir }, "work directory ready");
  }

  // Validate per-agent work_dir overrides exist
  for (const [name, agentConfig] of Object.entries(config.agents)) {
    if (!agentConfig.enabled || !agentConfig.work_dir) continue;
    if (!existsSync(agentConfig.work_dir)) {
      log.fatal(
        { agent: name, workDir: agentConfig.work_dir },
        "agent work_dir does not exist — create the directory or fix the config",
      );
      process.exit(1);
    }
  }
}

/** Check if a binary exists and is executable. Exported for testing. */
export function checkClaudeBinary(binary: string): { ok: true; version: string } | { ok: false } {
  try {
    const version = execFileSync(binary, ["--version"], {
      timeout: 5000,
      encoding: "utf-8",
    }).trim();
    return { ok: true, version };
  } catch {
    return { ok: false };
  }
}

/**
 * One-time migration of legacy JSON persistence files into SQLite.
 * Old files are renamed to `.migrated` (not deleted) as a safety measure.
 */
export function migrateLegacyData(config: Config, appDb: AppDatabase, log: pino.Logger): void {
  const budgetPath = `${config.data_dir}/budget.json`;
  const revokedPath = `${config.data_dir}/revoked-tokens.json`;

  if (existsSync(budgetPath)) {
    try {
      const data = JSON.parse(readFileSync(budgetPath, "utf-8")) as {
        date?: string;
        clients?: Record<string, number>;
      };
      if (data.date && data.clients) {
        const insert = appDb.db.prepare(
          "INSERT OR IGNORE INTO budget_records (date, client_name, spent_usd) VALUES (?, ?, ?)",
        );
        appDb.db.transaction(() => {
          for (const [client, spent] of Object.entries(data.clients!)) {
            insert.run(data.date, client, spent);
          }
        })();
      }
      renameSync(budgetPath, `${budgetPath}.migrated`);
      log.info("migrated budget.json to SQLite");
    } catch (err) {
      log.warn({ error: err instanceof Error ? err.message : String(err) }, "failed to migrate budget.json");
    }
  }

  if (existsSync(revokedPath)) {
    try {
      const jtis = JSON.parse(readFileSync(revokedPath, "utf-8")) as unknown;
      if (Array.isArray(jtis)) {
        const insert = appDb.db.prepare(
          "INSERT OR IGNORE INTO revoked_tokens (jti) VALUES (?)",
        );
        appDb.db.transaction(() => {
          for (const jti of jtis) {
            if (typeof jti === "string") {
              insert.run(jti);
            }
          }
        })();
      }
      renameSync(revokedPath, `${revokedPath}.migrated`);
      log.info("migrated revoked-tokens.json to SQLite");
    } catch (err) {
      log.warn({ error: err instanceof Error ? err.message : String(err) }, "failed to migrate revoked-tokens.json");
    }
  }
}
