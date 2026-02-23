import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SessionStore } from "../../src/server/services/session-store.js";
import { AppDatabase } from "../../src/server/services/database.js";
import { loadConfig } from "../../src/server/config.js";
import pino from "pino";

const log = pino({ level: "silent" });

describe("SessionStore", () => {
  let appDb: AppDatabase;

  beforeEach(() => {
    appDb = new AppDatabase(":memory:", log);
  });

  afterEach(() => {
    appDb.close();
  });

  function createStore(overrides?: { maxPerClient?: number }) {
    const config = loadConfig("/nonexistent");
    if (overrides?.maxPerClient) {
      config.sessions.max_per_client = overrides.maxPerClient;
    }
    return new SessionStore(config, log, appDb);
  }

  it("creates and retrieves by sessionId", () => {
    const store = createStore();
    store.create("s1", "general", "alice", "ctx-1", "task-1");

    const session = store.get("s1");
    expect(session).toBeDefined();
    expect(session!.sessionId).toBe("s1");
    expect(session!.clientName).toBe("alice");
  });

  it("retrieves by contextId", () => {
    const store = createStore();
    store.create("s1", "general", "alice", "ctx-1", "task-1");

    const session = store.getByContextId("ctx-1");
    expect(session).toBeDefined();
    expect(session!.sessionId).toBe("s1");
  });

  it("retrieves by taskId", () => {
    const store = createStore();
    store.create("s1", "general", "alice", "ctx-1", "task-1");

    const session = store.getByTaskId("task-1");
    expect(session).toBeDefined();
    expect(session!.sessionId).toBe("s1");
  });

  it("returns undefined for unknown lookups", () => {
    const store = createStore();
    expect(store.get("nope")).toBeUndefined();
    expect(store.getByContextId("nope")).toBeUndefined();
    expect(store.getByTaskId("nope")).toBeUndefined();
  });

  it("lists sessions for a client", () => {
    const store = createStore();
    store.create("s1", "general", "alice", "ctx-1", "task-1");
    store.create("s2", "general", "bob", "ctx-2", "task-2");
    store.create("s3", "code", "alice", "ctx-3", "task-3");

    const aliceSessions = store.listForClient("alice");
    expect(aliceSessions).toHaveLength(2);
    expect(aliceSessions.map((s) => s.sessionId).sort()).toEqual(["s1", "s3"]);

    expect(store.listForClient("bob")).toHaveLength(1);
    expect(store.listForClient("nobody")).toHaveLength(0);
  });

  it("deletes a session and cleans up indexes", () => {
    const store = createStore();
    store.create("s1", "general", "alice", "ctx-1", "task-1");

    expect(store.delete("s1")).toBe(true);
    expect(store.get("s1")).toBeUndefined();
    expect(store.getByContextId("ctx-1")).toBeUndefined();
    expect(store.getByTaskId("task-1")).toBeUndefined();
    expect(store.listForClient("alice")).toHaveLength(0);
    expect(store.size).toBe(0);
  });

  it("delete returns false for unknown session", () => {
    const store = createStore();
    expect(store.delete("nope")).toBe(false);
  });

  it("evicts oldest session when per-client limit is reached", () => {
    const store = createStore({ maxPerClient: 2 });

    store.create("s1", "general", "alice", "ctx-1", "task-1");
    store.create("s2", "general", "alice", "ctx-2", "task-2");

    // s1 is older, so creating s3 should evict s1
    store.create("s3", "general", "alice", "ctx-3", "task-3");

    expect(store.size).toBe(2);
    expect(store.get("s1")).toBeUndefined();
    expect(store.getByContextId("ctx-1")).toBeUndefined();
    expect(store.get("s2")).toBeDefined();
    expect(store.get("s3")).toBeDefined();
  });

  it("tracks size correctly", () => {
    const store = createStore();
    expect(store.size).toBe(0);

    store.create("s1", "general", "alice", "ctx-1", "task-1");
    expect(store.size).toBe(1);

    store.create("s2", "general", "bob", "ctx-2", "task-2");
    expect(store.size).toBe(2);

    store.delete("s1");
    expect(store.size).toBe(1);
  });

  it("updates cost and message count", () => {
    const store = createStore();
    store.create("s1", "general", "alice", "ctx-1", "task-1");

    store.update("s1", 0.5);
    store.update("s1", 0.3);

    const session = store.get("s1")!;
    expect(session.totalCostUsd).toBeCloseTo(0.8);
    expect(session.messageCount).toBe(2);
  });

  it("recovers sessions from database after restart", () => {
    // Create sessions in first store instance
    const config = loadConfig("/nonexistent");
    const store1 = new SessionStore(config, log, appDb);
    store1.create("s1", "general", "alice", "ctx-1", "task-1");
    store1.update("s1", 0.5);
    store1.create("s2", "code", "bob", "ctx-2", "task-2");
    store1.stop();

    // Create second store from same DB (simulates restart)
    const store2 = new SessionStore(config, log, appDb);

    // Sessions should be recovered
    expect(store2.size).toBe(2);

    const session = store2.get("s1");
    expect(session).toBeDefined();
    expect(session!.agentName).toBe("general");
    expect(session!.clientName).toBe("alice");
    expect(session!.totalCostUsd).toBeCloseTo(0.5);
    expect(session!.messageCount).toBe(1);
    // Processes don't survive restart
    expect(session!.processAlive).toBe(false);

    // Index lookups work
    expect(store2.getByContextId("ctx-1")).toBeDefined();
    expect(store2.getByTaskId("task-2")).toBeDefined();
    expect(store2.listForClient("alice")).toHaveLength(1);
    expect(store2.listForClient("bob")).toHaveLength(1);
  });

  it("does not fire onSessionEvicted during startup recovery", () => {
    const config = loadConfig("/nonexistent");

    // Create a session
    const store1 = new SessionStore(config, log, appDb);
    store1.create("s1", "general", "alice", "ctx-1", "task-1");
    store1.stop();

    // On restart with eviction callback — should NOT be called during load
    let evicted = false;
    const store2 = new SessionStore(config, log, appDb, {
      onSessionEvicted: () => { evicted = true; },
    });

    expect(store2.size).toBe(1);
    expect(evicted).toBe(false);
  });

  it("savePid and getLastPid persist and retrieve PID", () => {
    const store = createStore();
    store.create("s1", "general", "alice", "ctx-1", "task-1");

    store.savePid("ctx-1", 42000);

    expect(store.getLastPid("ctx-1")).toBe(42000);
    expect(store.getLastPid("nonexistent")).toBeNull();
  });

  it("savePid survives store restart", () => {
    const config = loadConfig("/nonexistent");
    const store1 = new SessionStore(config, log, appDb);
    store1.create("s1", "general", "alice", "ctx-1", "task-1");
    store1.savePid("ctx-1", 42000);
    store1.stop();

    // Restart — PID should be readable from new store
    const store2 = new SessionStore(config, log, appDb);
    expect(store2.getLastPid("ctx-1")).toBe(42000);
  });

  it("markAllProcessesDead sets all sessions to dead", () => {
    const store = createStore();
    store.create("s1", "general", "alice", "ctx-1", "task-1");
    store.create("s2", "code", "bob", "ctx-2", "task-2");

    // Both should start as alive
    expect(store.get("s1")!.processAlive).toBe(true);
    expect(store.get("s2")!.processAlive).toBe(true);

    store.markAllProcessesDead();

    // In-memory should be dead
    expect(store.get("s1")!.processAlive).toBe(false);
    expect(store.get("s2")!.processAlive).toBe(false);

    // Verify persisted to DB by reloading
    const config = loadConfig("/nonexistent");
    const store2 = new SessionStore(config, log, appDb);
    expect(store2.get("s1")!.processAlive).toBe(false);
    expect(store2.get("s2")!.processAlive).toBe(false);
  });
});
