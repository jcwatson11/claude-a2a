import Database from "better-sqlite3";
import type { Logger } from "pino";

interface Migration {
  version: number;
  description: string;
  up: (db: Database.Database) => void;
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    description: "Initial schema",
    up: (db) => {
      db.exec(`
        CREATE TABLE budget_records (
          date TEXT NOT NULL,
          client_name TEXT NOT NULL,
          spent_usd REAL NOT NULL DEFAULT 0,
          PRIMARY KEY (date, client_name)
        );

        CREATE TABLE revoked_tokens (
          jti TEXT PRIMARY KEY,
          revoked_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE sessions (
          session_id TEXT PRIMARY KEY,
          agent_name TEXT NOT NULL,
          client_name TEXT NOT NULL,
          context_id TEXT NOT NULL UNIQUE,
          task_id TEXT NOT NULL UNIQUE,
          created_at INTEGER NOT NULL,
          last_accessed_at INTEGER NOT NULL,
          total_cost_usd REAL NOT NULL DEFAULT 0,
          message_count INTEGER NOT NULL DEFAULT 0,
          process_alive INTEGER NOT NULL DEFAULT 1
        );
        CREATE INDEX idx_sessions_client ON sessions(client_name);

        CREATE TABLE tasks (
          id TEXT PRIMARY KEY,
          context_id TEXT NOT NULL,
          status_state TEXT NOT NULL,
          status_timestamp TEXT,
          status_message_json TEXT,
          artifacts_json TEXT,
          history_json TEXT,
          metadata_json TEXT,
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX idx_tasks_context ON tasks(context_id);
      `);
    },
  },
  {
    version: 2,
    description: "Add last_pid to sessions for orphan detection",
    up: (db) => {
      db.exec(`ALTER TABLE sessions ADD COLUMN last_pid INTEGER`);
    },
  },
  {
    version: 3,
    description: "Add client_name to tasks for tenant isolation",
    up: (db) => {
      db.exec(`ALTER TABLE tasks ADD COLUMN client_name TEXT`);
    },
  },
];

export class AppDatabase {
  readonly db: Database.Database;
  private readonly log: Logger;

  constructor(dbPath: string, log: Logger) {
    this.log = log.child({ component: "database" });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("busy_timeout = 5000");
    this.runMigrations();
    this.log.info({ path: dbPath }, "database opened");
  }

  close(): void {
    this.db.close();
    this.log.info("database closed");
  }

  private runMigrations(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);

    const currentVersion =
      (
        this.db
          .prepare("SELECT MAX(version) as v FROM migrations")
          .get() as { v: number | null }
      )?.v ?? 0;

    const pending = MIGRATIONS.filter((m) => m.version > currentVersion);
    if (pending.length === 0) return;

    for (const migration of pending) {
      this.db.transaction(() => {
        migration.up(this.db);
        this.db
          .prepare("INSERT INTO migrations (version) VALUES (?)")
          .run(migration.version);
      })();
      this.log.info(
        { version: migration.version, description: migration.description },
        "migration applied",
      );
    }
  }
}
