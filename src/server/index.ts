import express from "express";
import { AGENT_CARD_PATH } from "@a2a-js/sdk";
import {
  DefaultRequestHandler,
  InMemoryTaskStore,
} from "@a2a-js/sdk/server";
import {
  agentCardHandler,
  jsonRpcHandler,
  restHandler,
  UserBuilder,
} from "@a2a-js/sdk/server/express";
import pino from "pino";
import type { Config } from "./config.js";
import { buildAgentCard } from "./agent-card.js";
import { ClaudeRunner } from "./claude-runner.js";
import { ClaudeAgentExecutor } from "./agent-executor.js";
import { createAuthMiddleware } from "./auth/middleware.js";
import { RateLimiter } from "./services/rate-limiter.js";
import { BudgetTracker } from "./services/budget-tracker.js";
import { SessionStore } from "./services/session-store.js";
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

  log.info("starting claude-a2a server");

  // Initialize components
  const runner = new ClaudeRunner(config, log);
  const sessionStore = new SessionStore(config, log);
  const budgetTracker = new BudgetTracker(config, log);
  const rateLimiter = new RateLimiter(config);

  sessionStore.start();

  // Build A2A agent card and executor
  const agentCard = buildAgentCard(config);
  const executor = new ClaudeAgentExecutor(
    runner,
    config,
    sessionStore,
    budgetTracker,
    log,
  );

  const taskStore = new InMemoryTaskStore();
  const requestHandler = new DefaultRequestHandler(
    agentCard,
    taskStore,
    executor,
  );

  // Build a UserBuilder that passes through auth context
  const userBuilder: (req: Request) => Promise<User | UnauthenticatedUser> = async (req) => {
    if (req.authContext) {
      return {
        name: req.authContext.clientName,
        ...req.authContext,
      } as unknown as User;
    }
    return new UnauthenticatedUser();
  };

  // Set up Express app
  const app = express();
  app.use(express.json());

  // Auth middleware for A2A and admin routes
  const authMiddleware = createAuthMiddleware(config, log);

  // Health check (no auth required)
  app.use(healthRouter(runner, sessionStore, budgetTracker));

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
  app.use("/admin", authMiddleware, adminRouter(config, sessionStore));

  // Start listening
  const { host, port } = config.server;
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

  // Graceful shutdown
  const shutdown = () => {
    log.info("shutting down");
    sessionStore.stop();
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
