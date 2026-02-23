import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SqliteTaskStore } from "../../src/server/services/task-store.js";
import { AppDatabase } from "../../src/server/services/database.js";
import { AuthenticatedUser } from "../../src/server/auth/user.js";
import type { Task } from "@a2a-js/sdk";
import { ServerCallContext, UnauthenticatedUser } from "@a2a-js/sdk/server";
import type { AuthContext } from "../../src/server/auth/middleware.js";
import pino from "pino";

const log = pino({ level: "silent" });

describe("SqliteTaskStore", () => {
  let appDb: AppDatabase;
  let store: SqliteTaskStore;

  beforeEach(() => {
    appDb = new AppDatabase(":memory:", log);
    store = new SqliteTaskStore(appDb);
  });

  afterEach(() => {
    appDb.close();
  });

  it("returns undefined for unknown task", async () => {
    const task = await store.load("nonexistent");
    expect(task).toBeUndefined();
  });

  it("saves and loads a minimal task", async () => {
    const task: Task = {
      id: "t-1",
      contextId: "ctx-1",
      kind: "task",
      status: { state: "submitted" },
    };

    await store.save(task);
    const loaded = await store.load("t-1");

    expect(loaded).toBeDefined();
    expect(loaded!.id).toBe("t-1");
    expect(loaded!.contextId).toBe("ctx-1");
    expect(loaded!.kind).toBe("task");
    expect(loaded!.status.state).toBe("submitted");
  });

  it("saves and loads a task with all fields", async () => {
    const task: Task = {
      id: "t-2",
      contextId: "ctx-2",
      kind: "task",
      status: {
        state: "completed",
        timestamp: "2026-02-22T12:00:00Z",
        message: {
          kind: "message",
          messageId: "msg-1",
          role: "agent",
          parts: [{ kind: "text", text: "Done!" }],
        },
      },
      artifacts: [
        {
          artifactId: "a-1",
          name: "result.txt",
          parts: [{ kind: "text", text: "Hello world" }],
        },
      ],
      history: [
        {
          kind: "message",
          messageId: "msg-0",
          role: "user",
          parts: [{ kind: "text", text: "Do something" }],
        },
      ],
      metadata: { custom_key: "custom_value" },
    };

    await store.save(task);
    const loaded = await store.load("t-2");

    expect(loaded).toBeDefined();
    expect(loaded!.status.state).toBe("completed");
    expect(loaded!.status.timestamp).toBe("2026-02-22T12:00:00Z");
    expect(loaded!.status.message).toBeDefined();
    expect(loaded!.status.message!.parts[0]).toEqual({ kind: "text", text: "Done!" });
    expect(loaded!.artifacts).toHaveLength(1);
    expect(loaded!.artifacts![0]!.name).toBe("result.txt");
    expect(loaded!.history).toHaveLength(1);
    expect(loaded!.metadata).toEqual({ custom_key: "custom_value" });
  });

  it("upserts — save overwrites existing task", async () => {
    const task: Task = {
      id: "t-3",
      contextId: "ctx-3",
      kind: "task",
      status: { state: "submitted" },
    };

    await store.save(task);

    // Update status
    task.status = { state: "completed", timestamp: "2026-02-22T13:00:00Z" };
    task.artifacts = [
      { artifactId: "a-1", parts: [{ kind: "text", text: "result" }] },
    ];
    await store.save(task);

    const loaded = await store.load("t-3");
    expect(loaded!.status.state).toBe("completed");
    expect(loaded!.artifacts).toHaveLength(1);
  });

  it("handles task without optional fields", async () => {
    const task: Task = {
      id: "t-4",
      contextId: "ctx-4",
      kind: "task",
      status: { state: "working" },
    };

    await store.save(task);
    const loaded = await store.load("t-4");

    expect(loaded!.artifacts).toBeUndefined();
    expect(loaded!.history).toBeUndefined();
    expect(loaded!.metadata).toBeUndefined();
    expect(loaded!.status.timestamp).toBeUndefined();
    expect(loaded!.status.message).toBeUndefined();
  });

  it("persists across store instances (same DB)", async () => {
    const task: Task = {
      id: "t-5",
      contextId: "ctx-5",
      kind: "task",
      status: { state: "completed" },
    };

    await store.save(task);

    // Create new store instance from same DB
    const store2 = new SqliteTaskStore(appDb);
    const loaded = await store2.load("t-5");

    expect(loaded).toBeDefined();
    expect(loaded!.status.state).toBe("completed");
  });

  // -------------------------------------------------------------------------
  // Tenant isolation
  // -------------------------------------------------------------------------

  function makeAuthContext(overrides: Partial<AuthContext> = {}): AuthContext {
    return { type: "jwt", clientName: "alice", scopes: ["*"], ...overrides };
  }

  function contextFor(authCtx: AuthContext): ServerCallContext {
    return new ServerCallContext(undefined, new AuthenticatedUser(authCtx));
  }

  function masterContext(): ServerCallContext {
    return contextFor(makeAuthContext({ type: "master", clientName: "master" }));
  }

  const minimalTask: Task = {
    id: "t-tenant",
    contextId: "ctx-tenant",
    kind: "task",
    status: { state: "submitted" },
  };

  describe("tenant isolation", () => {
    it("load returns task when no context (internal call)", async () => {
      await store.save(minimalTask);
      const loaded = await store.load("t-tenant");
      expect(loaded).toBeDefined();
      expect(loaded!.id).toBe("t-tenant");
    });

    it("load returns task for master user regardless of ownership", async () => {
      const aliceCtx = contextFor(makeAuthContext({ clientName: "alice" }));
      await store.save(minimalTask, aliceCtx);

      const loaded = await store.load("t-tenant", masterContext());
      expect(loaded).toBeDefined();
      expect(loaded!.id).toBe("t-tenant");
    });

    it("load returns task for the owning client", async () => {
      const aliceCtx = contextFor(makeAuthContext({ clientName: "alice" }));
      await store.save(minimalTask, aliceCtx);

      const loaded = await store.load("t-tenant", aliceCtx);
      expect(loaded).toBeDefined();
      expect(loaded!.id).toBe("t-tenant");
    });

    it("load returns undefined for a different client", async () => {
      const aliceCtx = contextFor(makeAuthContext({ clientName: "alice" }));
      await store.save(minimalTask, aliceCtx);

      const bobCtx = contextFor(makeAuthContext({ clientName: "bob" }));
      const loaded = await store.load("t-tenant", bobCtx);
      expect(loaded).toBeUndefined();
    });

    it("load returns undefined for unauthenticated user", async () => {
      const aliceCtx = contextFor(makeAuthContext({ clientName: "alice" }));
      await store.save(minimalTask, aliceCtx);

      const unauthCtx = new ServerCallContext(undefined, new UnauthenticatedUser());
      const loaded = await store.load("t-tenant", unauthCtx);
      expect(loaded).toBeUndefined();
    });

    it("save stores client_name from context on create", async () => {
      const aliceCtx = contextFor(makeAuthContext({ clientName: "alice" }));
      await store.save(minimalTask, aliceCtx);

      // Verify by checking that alice can read but bob cannot
      const aliceLoaded = await store.load("t-tenant", aliceCtx);
      expect(aliceLoaded).toBeDefined();

      const bobCtx = contextFor(makeAuthContext({ clientName: "bob" }));
      const bobLoaded = await store.load("t-tenant", bobCtx);
      expect(bobLoaded).toBeUndefined();
    });

    it("save does not overwrite client_name on update", async () => {
      // Create as alice
      const aliceCtx = contextFor(makeAuthContext({ clientName: "alice" }));
      await store.save(minimalTask, aliceCtx);

      // Update as master (which has a different clientName "master")
      const updated: Task = { ...minimalTask, status: { state: "completed" } };
      await store.save(updated, masterContext());

      // Alice should still own the task
      const aliceLoaded = await store.load("t-tenant", aliceCtx);
      expect(aliceLoaded).toBeDefined();
      expect(aliceLoaded!.status.state).toBe("completed");

      // Bob should still be denied
      const bobCtx = contextFor(makeAuthContext({ clientName: "bob" }));
      expect(await store.load("t-tenant", bobCtx)).toBeUndefined();
    });

    it("allows access to legacy tasks with no owner", async () => {
      // Save without context (simulates legacy data / internal creation)
      await store.save(minimalTask);

      // Any authenticated user should be able to access
      const bobCtx = contextFor(makeAuthContext({ clientName: "bob" }));
      const loaded = await store.load("t-tenant", bobCtx);
      expect(loaded).toBeDefined();
    });
  });
});
