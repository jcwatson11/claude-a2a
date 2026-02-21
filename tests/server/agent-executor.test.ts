import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ClaudeAgentExecutor } from "../../src/server/agent-executor.js";
import { ClaudeRunner } from "../../src/server/claude-runner.js";
import { SessionStore } from "../../src/server/services/session-store.js";
import { BudgetTracker } from "../../src/server/services/budget-tracker.js";
import { loadConfig } from "../../src/server/config.js";
import pino from "pino";
import type { RequestContext, ExecutionEventBus } from "@a2a-js/sdk/server";
import type { Message } from "@a2a-js/sdk";
import { join } from "node:path";
import { mkdirSync, rmSync } from "node:fs";

const log = pino({ level: "silent" });
const tmpDir = join(import.meta.dirname, ".tmp-executor-test");

beforeEach(() => {
  mkdirSync(tmpDir, { recursive: true });
});

describe("ClaudeAgentExecutor", () => {
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function createMockEventBus() {
    const events: unknown[] = [];
    return {
      publish: vi.fn((event: unknown) => events.push(event)),
      finished: vi.fn(),
      events,
      on: vi.fn(),
      off: vi.fn(),
      once: vi.fn(),
      removeAllListeners: vi.fn(),
    } satisfies ExecutionEventBus & { events: unknown[] };
  }

  it("publishes error message for empty input", async () => {
    const config = loadConfig("/nonexistent");
    const runner = new ClaudeRunner(config, log);
    const sessionStore = new SessionStore(config, log);
    const budgetTracker = new BudgetTracker(config, log, join(tmpDir, "b.json"));

    const executor = new ClaudeAgentExecutor(
      runner, config, sessionStore, budgetTracker, log,
    );

    const eventBus = createMockEventBus();
    const userMessage: Message = {
      kind: "message",
      messageId: "test-1",
      role: "user",
      parts: [{ kind: "text", text: "" }],
    };

    await executor.execute(
      { userMessage, taskId: "task-1", contextId: "ctx-1" } as RequestContext,
      eventBus,
    );

    expect(eventBus.publish).toHaveBeenCalled();
    expect(eventBus.finished).toHaveBeenCalled();
    const msg = eventBus.events[0] as Message;
    expect(msg.kind).toBe("message");
    expect(msg.role).toBe("agent");
    expect(msg.parts[0]!.kind).toBe("text");
    expect((msg.parts[0] as { text: string }).text).toContain("Empty message");
  });

  it("publishes error message for unknown agent", async () => {
    const config = loadConfig("/nonexistent");
    config.agents = {};

    const runner = new ClaudeRunner(config, log);
    const sessionStore = new SessionStore(config, log);
    const budgetTracker = new BudgetTracker(config, log, join(tmpDir, "b.json"));

    const executor = new ClaudeAgentExecutor(
      runner, config, sessionStore, budgetTracker, log,
    );

    const eventBus = createMockEventBus();
    const userMessage: Message = {
      kind: "message",
      messageId: "test-2",
      role: "user",
      parts: [{ kind: "text", text: "Hello" }],
      metadata: { agent: "nonexistent" },
    };

    await executor.execute(
      { userMessage, taskId: "task-2", contextId: "ctx-2" } as RequestContext,
      eventBus,
    );

    const msg = eventBus.events[0] as Message;
    expect(msg.kind).toBe("message");
    expect((msg.parts[0] as { text: string }).text).toContain("not found");
  });
});
