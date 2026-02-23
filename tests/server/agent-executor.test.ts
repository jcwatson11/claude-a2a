import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ClaudeAgentExecutor, convertPartsToMessage } from "../../src/server/agent-executor.js";
import { ClaudeRunner } from "../../src/server/claude-runner.js";
import { SessionStore } from "../../src/server/services/session-store.js";
import { BudgetTracker } from "../../src/server/services/budget-tracker.js";
import { AppDatabase } from "../../src/server/services/database.js";
import { AuthenticatedUser } from "../../src/server/auth/user.js";
import { loadConfig } from "../../src/server/config.js";
import pino from "pino";
import { ServerCallContext } from "@a2a-js/sdk/server";
import type { RequestContext, ExecutionEventBus } from "@a2a-js/sdk/server";
import type { Message, Part } from "@a2a-js/sdk";
import type { ContentBlock } from "../../src/server/claude-session.js";

const log = pino({ level: "silent" });

describe("ClaudeAgentExecutor", () => {
  let appDb: AppDatabase;

  beforeEach(() => {
    appDb = new AppDatabase(":memory:", log);
  });

  afterEach(() => {
    appDb.close();
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
    const budgetTracker = new BudgetTracker(config, log, appDb);

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
    const budgetTracker = new BudgetTracker(config, log, appDb);

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

  it("blocks access when user scopes don't match agent required_scopes", async () => {
    const config = loadConfig("/nonexistent");
    config.agents["general"]!.required_scopes = ["agent:general"];

    const runner = new ClaudeRunner(config, log);
    const sessionStore = new SessionStore(config, log);
    const budgetTracker = new BudgetTracker(config, log, appDb);

    const executor = new ClaudeAgentExecutor(
      runner, config, sessionStore, budgetTracker, log,
    );

    const eventBus = createMockEventBus();
    const userMessage: Message = {
      kind: "message",
      messageId: "test-scope-1",
      role: "user",
      parts: [{ kind: "text", text: "Hello" }],
      metadata: { scopes: ["agent:code"] },
    };

    await executor.execute(
      { userMessage, taskId: "task-s1", contextId: "ctx-s1" } as RequestContext,
      eventBus,
    );

    const msg = eventBus.events[0] as Message;
    expect((msg.parts[0] as { text: string }).text).toContain("Insufficient scope");
  });

  it("allows access when user scopes match agent required_scopes", async () => {
    const config = loadConfig("/nonexistent");
    config.agents["general"]!.required_scopes = ["agent:general"];

    const runner = new ClaudeRunner(config, log);
    const sessionStore = new SessionStore(config, log);
    const budgetTracker = new BudgetTracker(config, log, appDb);

    const executor = new ClaudeAgentExecutor(
      runner, config, sessionStore, budgetTracker, log,
    );

    const eventBus = createMockEventBus();
    const userMessage: Message = {
      kind: "message",
      messageId: "test-scope-2",
      role: "user",
      parts: [{ kind: "text", text: "Hello" }],
      metadata: { scopes: ["agent:general"] },
    };

    await executor.execute(
      { userMessage, taskId: "task-s2", contextId: "ctx-s2" } as RequestContext,
      eventBus,
    );

    // Should NOT contain a scope error (it will either succeed or fail for another reason like spawn)
    const msg = eventBus.events[0] as Message;
    expect((msg.parts[0] as { text: string }).text).not.toContain("Insufficient scope");
  });

  it("allows access when user has wildcard scope", async () => {
    const config = loadConfig("/nonexistent");
    config.agents["general"]!.required_scopes = ["agent:general"];

    const runner = new ClaudeRunner(config, log);
    const sessionStore = new SessionStore(config, log);
    const budgetTracker = new BudgetTracker(config, log, appDb);

    const executor = new ClaudeAgentExecutor(
      runner, config, sessionStore, budgetTracker, log,
    );

    const eventBus = createMockEventBus();
    const userMessage: Message = {
      kind: "message",
      messageId: "test-scope-3",
      role: "user",
      parts: [{ kind: "text", text: "Hello" }],
      metadata: { scopes: ["*"] },
    };

    await executor.execute(
      { userMessage, taskId: "task-s3", contextId: "ctx-s3" } as RequestContext,
      eventBus,
    );

    const msg = eventBus.events[0] as Message;
    expect((msg.parts[0] as { text: string }).text).not.toContain("Insufficient scope");
  });

  it("rejects agent mismatch on existing session", async () => {
    const config = loadConfig("/nonexistent");
    config.agents["general"]!.required_scopes = [];
    config.agents["code"] = {
      ...config.agents["general"]!,
      description: "Code agent",
      enabled: true,
      required_scopes: [],
    };

    const runner = new ClaudeRunner(config, log);
    const sessionStore = new SessionStore(config, log, appDb);
    const budgetTracker = new BudgetTracker(config, log, appDb);

    // Create a session bound to "general" agent
    sessionStore.create("s1", "general", "alice", "ctx-mismatch", "task-m1");

    const executor = new ClaudeAgentExecutor(
      runner, config, sessionStore, budgetTracker, log,
    );

    const eventBus = createMockEventBus();
    const userMessage: Message = {
      kind: "message",
      messageId: "test-mismatch",
      role: "user",
      parts: [{ kind: "text", text: "Hello" }],
      metadata: { agent: "code", scopes: ["*"] },
    };

    await executor.execute(
      { userMessage, taskId: "task-m2", contextId: "ctx-mismatch" } as RequestContext,
      eventBus,
    );

    const msg = eventBus.events[0] as Message;
    const text = (msg.parts[0] as { text: string }).text;
    expect(text).toContain('belongs to agent "general"');
    expect(text).toContain('"code"');
    expect(text).toContain("new contextId");
    // Runner should NOT have been called
    expect(runner.concurrentCount).toBe(0);
  });

  it("detects live orphaned process and returns informative message", async () => {
    const config = loadConfig("/nonexistent");
    config.agents["general"]!.required_scopes = [];

    const runner = new ClaudeRunner(config, log);
    const sessionStore = new SessionStore(config, log, appDb);
    const budgetTracker = new BudgetTracker(config, log, appDb);

    // Create a session as if it was recovered from DB (processAlive = false)
    sessionStore.create("s1", "general", "anonymous", "ctx-orphan", "task-orphan");
    const session = sessionStore.getByContextId("ctx-orphan")!;
    session.processAlive = false;
    sessionStore.savePid("ctx-orphan", process.pid); // Use our own PID — known to be alive

    const executor = new ClaudeAgentExecutor(
      runner, config, sessionStore, budgetTracker, log,
    );

    const eventBus = createMockEventBus();
    const userMessage: Message = {
      kind: "message",
      messageId: "test-orphan-1",
      role: "user",
      parts: [{ kind: "text", text: "Hello" }],
      metadata: { scopes: ["*"] },
    };

    await executor.execute(
      { userMessage, taskId: "task-orphan", contextId: "ctx-orphan" } as RequestContext,
      eventBus,
    );

    const msg = eventBus.events[0] as Message;
    expect((msg.parts[0] as { text: string }).text).toContain("still running");
    expect(msg.metadata?.["orphan_pid"]).toBe(process.pid);
    // Runner should NOT have been called — no new session created
    expect(runner.concurrentCount).toBe(0);
  });

  it("proceeds with resume when orphaned process is dead", async () => {
    const config = loadConfig("/nonexistent");
    config.agents["general"]!.required_scopes = [];

    const runner = new ClaudeRunner(config, log);
    const sessionStore = new SessionStore(config, log, appDb);
    const budgetTracker = new BudgetTracker(config, log, appDb);

    // Create a session as if it was recovered from DB (processAlive = false)
    sessionStore.create("s1", "general", "anonymous", "ctx-dead", "task-dead");
    const session = sessionStore.getByContextId("ctx-dead")!;
    session.processAlive = false;
    sessionStore.savePid("ctx-dead", 999999); // Non-existent PID

    const executor = new ClaudeAgentExecutor(
      runner, config, sessionStore, budgetTracker, log,
    );

    const eventBus = createMockEventBus();
    const userMessage: Message = {
      kind: "message",
      messageId: "test-dead-orphan",
      role: "user",
      parts: [{ kind: "text", text: "Hello" }],
      metadata: { scopes: ["*"] },
    };

    await executor.execute(
      { userMessage, taskId: "task-dead", contextId: "ctx-dead" } as RequestContext,
      eventBus,
    );

    // Should NOT contain "still running" — should proceed to runner
    const msg = eventBus.events[0] as Message;
    expect((msg.parts[0] as { text: string }).text).not.toContain("still running");
  });

  it("uses per-client budget limit from JWT auth context", async () => {
    const config = loadConfig("/nonexistent");
    config.agents["general"]!.required_scopes = [];
    config.budgets.default_client_daily_limit_usd = 100; // high default

    const runner = new ClaudeRunner(config, log);
    const sessionStore = new SessionStore(config, log);
    const budgetTracker = new BudgetTracker(config, log, appDb);

    // Pre-spend $2 for this client
    budgetTracker.record_cost("budget-client", 2.0);

    const executor = new ClaudeAgentExecutor(
      runner, config, sessionStore, budgetTracker, log,
    );

    // Create an authenticated user with a low per-client budget ($1)
    const user = new AuthenticatedUser({
      type: "jwt",
      clientName: "budget-client",
      scopes: ["*"],
      budgetDailyUsd: 1.0, // lower than what's already spent
    });
    const context = { user } as unknown as ServerCallContext;

    const eventBus = createMockEventBus();
    const userMessage: Message = {
      kind: "message",
      messageId: "test-budget",
      role: "user",
      parts: [{ kind: "text", text: "Hello" }],
    };

    await executor.execute(
      { userMessage, taskId: "task-budget", contextId: "ctx-budget", context: { user } } as unknown as RequestContext,
      eventBus,
    );

    // Should hit the per-client budget limit
    const msg = eventBus.events[0] as Message;
    const text = (msg.parts[0] as { text: string }).text;
    expect(text).toContain("budget");
    expect(text).toContain("exhausted");
  });
});

// ---------------------------------------------------------------------------
// convertPartsToMessage — pure function tests
// ---------------------------------------------------------------------------

describe("convertPartsToMessage", () => {
  it("converts text-only parts to plain string", () => {
    const parts: Part[] = [
      { kind: "text", text: "Hello" },
      { kind: "text", text: "World" },
    ];
    const { message, hasNonText } = convertPartsToMessage(parts);
    expect(typeof message).toBe("string");
    expect(message).toBe("Hello\nWorld");
    expect(hasNonText).toBe(false);
  });

  it("converts image FilePart to image content block", () => {
    const parts: Part[] = [
      { kind: "text", text: "Look at this:" },
      {
        kind: "file",
        file: { bytes: "aGVsbG8=", mimeType: "image/png", name: "test.png" },
      },
    ];
    const { message, hasNonText } = convertPartsToMessage(parts);
    expect(hasNonText).toBe(true);
    const blocks = message as ContentBlock[];
    expect(blocks[0]).toEqual({ type: "text", text: "Look at this:" });
    expect(blocks[1]).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" },
    });
    expect(blocks[2]).toEqual({ type: "text", text: "[File: test.png]" });
  });

  it("converts PDF FilePart to document content block", () => {
    const parts: Part[] = [
      {
        kind: "file",
        file: { bytes: "JVBER", mimeType: "application/pdf" },
      },
    ];
    const { message } = convertPartsToMessage(parts);
    const blocks = message as ContentBlock[];
    expect(blocks[0]).toEqual({
      type: "document",
      source: { type: "base64", media_type: "application/pdf", data: "JVBER" },
    });
  });

  it("defaults unknown MIME to document block with application/octet-stream", () => {
    const parts: Part[] = [
      { kind: "file", file: { bytes: "data123" } },
    ];
    const { message } = convertPartsToMessage(parts);
    const blocks = message as ContentBlock[];
    expect(blocks[0]).toEqual({
      type: "document",
      source: { type: "base64", media_type: "application/octet-stream", data: "data123" },
    });
  });

  it("converts URI FilePart to text reference", () => {
    const parts: Part[] = [
      {
        kind: "file",
        file: { uri: "https://example.com/doc.pdf", mimeType: "application/pdf", name: "doc.pdf" },
      },
    ];
    const { message, hasNonText } = convertPartsToMessage(parts);
    expect(hasNonText).toBe(true);
    const blocks = message as ContentBlock[];
    expect(blocks[0]!.type).toBe("text");
    expect((blocks[0] as { type: "text"; text: string }).text).toContain("doc.pdf");
    expect((blocks[0] as { type: "text"; text: string }).text).toContain("not supported");
  });

  it("converts DataPart to JSON text block", () => {
    const parts: Part[] = [
      { kind: "data", data: { key: "value", count: 42 } },
    ];
    const { message, hasNonText } = convertPartsToMessage(parts);
    expect(hasNonText).toBe(true);
    const blocks = message as ContentBlock[];
    expect(blocks[0]!.type).toBe("text");
    expect(JSON.parse((blocks[0] as { type: "text"; text: string }).text)).toEqual({
      key: "value",
      count: 42,
    });
  });

  it("returns empty string for no parts", () => {
    const { message, hasNonText } = convertPartsToMessage([]);
    expect(message).toBe("");
    expect(hasNonText).toBe(false);
  });

  it("handles mixed text and file parts as content blocks", () => {
    const parts: Part[] = [
      { kind: "text", text: "Describe this image:" },
      { kind: "file", file: { bytes: "abc", mimeType: "image/jpeg" } },
      { kind: "text", text: "And this data:" },
      { kind: "data", data: { x: 1 } },
    ];
    const { message, hasNonText } = convertPartsToMessage(parts);
    expect(hasNonText).toBe(true);
    const blocks = message as ContentBlock[];
    expect(blocks).toHaveLength(4);
    expect(blocks[0]).toEqual({ type: "text", text: "Describe this image:" });
    expect(blocks[1]).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/jpeg", data: "abc" },
    });
    expect(blocks[2]).toEqual({ type: "text", text: "And this data:" });
    expect(blocks[3]!.type).toBe("text");
  });
});
