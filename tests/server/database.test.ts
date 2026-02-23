import { describe, it, expect, beforeEach, afterEach } from "vitest";
import pino from "pino";
import { AppDatabase } from "../../src/server/services/database.js";

const log = pino({ level: "silent" });

describe("AppDatabase", () => {
  let appDb: AppDatabase;

  beforeEach(() => {
    appDb = new AppDatabase(":memory:", log);
  });

  afterEach(() => {
    appDb.close();
  });

  it("enables WAL journal mode on file-backed database", () => {
    const fs = require("node:fs");
    const path = require("node:path");
    const os = require("node:os");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-a2a-wal-"));
    const dbPath = path.join(tmpDir, "test.db");

    const fileDb = new AppDatabase(dbPath, log);
    const result = fileDb.db.pragma("journal_mode") as { journal_mode: string }[];
    expect(result[0]!.journal_mode).toBe("wal");
    fileDb.close();

    fs.rmSync(tmpDir, { recursive: true });
  });

  it("creates all tables on first open", () => {
    const tables = appDb.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
      )
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);
    expect(names).toContain("migrations");
    expect(names).toContain("budget_records");
    expect(names).toContain("revoked_tokens");
    expect(names).toContain("sessions");
    expect(names).toContain("tasks");
  });

  it("records migration version", () => {
    const row = appDb.db
      .prepare("SELECT MAX(version) as v FROM migrations")
      .get() as { v: number };
    expect(row.v).toBe(3);
  });

  it("is idempotent on re-open", () => {
    // Closing and re-opening the same db should not fail
    // Use a temp file for this test since :memory: is lost on close
    const fs = require("node:fs");
    const path = require("node:path");
    const os = require("node:os");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-a2a-test-"));
    const dbPath = path.join(tmpDir, "test.db");

    const db1 = new AppDatabase(dbPath, log);
    db1.close();

    const db2 = new AppDatabase(dbPath, log);
    const row = db2.db
      .prepare("SELECT MAX(version) as v FROM migrations")
      .get() as { v: number };
    expect(row.v).toBe(3);
    db2.close();

    // Cleanup
    fs.rmSync(tmpDir, { recursive: true });
  });

  it("creates indexes", () => {
    const indexes = appDb.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as { name: string }[];
    const names = indexes.map((i) => i.name);
    expect(names).toContain("idx_sessions_client");
    expect(names).toContain("idx_tasks_context");
  });

  it("supports basic CRUD on budget_records", () => {
    appDb.db
      .prepare(
        "INSERT INTO budget_records (date, client_name, spent_usd) VALUES (?, ?, ?)",
      )
      .run("2026-02-22", "alice", 1.5);

    const row = appDb.db
      .prepare(
        "SELECT spent_usd FROM budget_records WHERE date = ? AND client_name = ?",
      )
      .get("2026-02-22", "alice") as { spent_usd: number };
    expect(row.spent_usd).toBeCloseTo(1.5);
  });

  it("supports upsert on budget_records", () => {
    const upsert = appDb.db.prepare(`
      INSERT INTO budget_records (date, client_name, spent_usd)
      VALUES (?, ?, ?)
      ON CONFLICT(date, client_name)
      DO UPDATE SET spent_usd = spent_usd + excluded.spent_usd
    `);
    upsert.run("2026-02-22", "alice", 1.0);
    upsert.run("2026-02-22", "alice", 2.5);

    const row = appDb.db
      .prepare(
        "SELECT spent_usd FROM budget_records WHERE date = ? AND client_name = ?",
      )
      .get("2026-02-22", "alice") as { spent_usd: number };
    expect(row.spent_usd).toBeCloseTo(3.5);
  });

  it("enforces unique context_id on sessions", () => {
    const insert = appDb.db.prepare(`
      INSERT INTO sessions (session_id, agent_name, client_name, context_id, task_id, created_at, last_accessed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    insert.run("s1", "general", "alice", "ctx-1", "t-1", Date.now(), Date.now());

    expect(() =>
      insert.run("s2", "general", "alice", "ctx-1", "t-2", Date.now(), Date.now()),
    ).toThrow();
  });
});
