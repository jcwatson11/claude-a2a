import type { Logger } from "pino";
import type { Config } from "../config.js";
import type { AppDatabase } from "./database.js";
import type Database from "better-sqlite3";

export interface SessionMetadata {
  sessionId: string;
  agentName: string;
  clientName: string;
  contextId: string;
  taskId: string;
  createdAt: number;
  lastAccessedAt: number;
  totalCostUsd: number;
  messageCount: number;
  processAlive: boolean;
}

export interface SessionStoreOptions {
  onSessionEvicted?: (contextId: string) => void;
}

interface SessionRow {
  session_id: string;
  agent_name: string;
  client_name: string;
  context_id: string;
  task_id: string;
  created_at: number;
  last_accessed_at: number;
  total_cost_usd: number;
  message_count: number;
  process_alive: number;
  last_pid: number | null;
}

export class SessionStore {
  private readonly sessions = new Map<string, SessionMetadata>();
  private readonly byContextId = new Map<string, SessionMetadata>();
  private readonly byTaskId = new Map<string, SessionMetadata>();
  private readonly byClient = new Map<string, Set<string>>(); // clientName -> sessionIds
  private readonly maxLifetimeMs: number;
  private readonly maxIdleMs: number;
  private readonly maxPerClient: number;
  private readonly log: Logger;
  private readonly onSessionEvicted?: (contextId: string) => void;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  // SQLite prepared statements (null when running without persistence)
  private readonly stmtInsert: Database.Statement | null;
  private readonly stmtUpdate: Database.Statement | null;
  private readonly stmtDelete: Database.Statement | null;
  private readonly stmtSelectAll: Database.Statement | null;
  private readonly stmtSavePid: Database.Statement | null;
  private readonly stmtGetPid: Database.Statement | null;
  private readonly stmtMarkAllDead: Database.Statement | null;

  constructor(config: Config, log: Logger, appDb?: AppDatabase, options?: SessionStoreOptions) {
    this.maxLifetimeMs = config.sessions.max_lifetime_hours * 3600_000;
    this.maxIdleMs = config.sessions.max_idle_hours * 3600_000;
    this.maxPerClient = config.sessions.max_per_client;
    this.log = log.child({ component: "session-store" });
    this.onSessionEvicted = options?.onSessionEvicted;

    if (appDb) {
      this.stmtInsert = appDb.db.prepare(`
        INSERT INTO sessions (session_id, agent_name, client_name, context_id, task_id, created_at, last_accessed_at, total_cost_usd, message_count, process_alive)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      this.stmtUpdate = appDb.db.prepare(`
        UPDATE sessions SET last_accessed_at = ?, total_cost_usd = ?, message_count = ?, process_alive = ?
        WHERE session_id = ?
      `);
      this.stmtDelete = appDb.db.prepare("DELETE FROM sessions WHERE session_id = ?");
      this.stmtSelectAll = appDb.db.prepare("SELECT * FROM sessions");
      this.stmtSavePid = appDb.db.prepare("UPDATE sessions SET last_pid = ? WHERE context_id = ?");
      this.stmtGetPid = appDb.db.prepare("SELECT last_pid FROM sessions WHERE context_id = ?");
      this.stmtMarkAllDead = appDb.db.prepare("UPDATE sessions SET process_alive = 0");

      // Load persisted sessions on startup
      this.loadFromDb();
    } else {
      this.stmtInsert = null;
      this.stmtUpdate = null;
      this.stmtDelete = null;
      this.stmtSelectAll = null;
      this.stmtSavePid = null;
      this.stmtGetPid = null;
      this.stmtMarkAllDead = null;
    }
  }

  start(): void {
    this.cleanupTimer = setInterval(() => this.cleanup(), 60_000);
  }

  stop(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  get(sessionId: string): SessionMetadata | undefined {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.lastAccessedAt = Date.now();
    }
    return session;
  }

  getByTaskId(taskId: string): SessionMetadata | undefined {
    const session = this.byTaskId.get(taskId);
    if (session) {
      session.lastAccessedAt = Date.now();
    }
    return session;
  }

  getByContextId(contextId: string): SessionMetadata | undefined {
    const session = this.byContextId.get(contextId);
    if (session) {
      session.lastAccessedAt = Date.now();
    }
    return session;
  }

  create(
    sessionId: string,
    agentName: string,
    clientName: string,
    contextId: string,
    taskId: string,
  ): SessionMetadata {
    // Check per-client limit
    const clientSet = this.byClient.get(clientName);
    if (clientSet && clientSet.size >= this.maxPerClient) {
      // Evict oldest idle session for this client
      let oldest: SessionMetadata | undefined;
      for (const id of clientSet) {
        const s = this.sessions.get(id)!;
        if (!oldest || s.lastAccessedAt < oldest.lastAccessedAt) {
          oldest = s;
        }
      }
      if (oldest) {
        this.log.info(
          { sessionId: oldest.sessionId, client: clientName },
          "evicting oldest session (per-client limit)",
        );
        this.removeSession(oldest);
      }
    }

    const session: SessionMetadata = {
      sessionId,
      agentName,
      clientName,
      contextId,
      taskId,
      createdAt: Date.now(),
      lastAccessedAt: Date.now(),
      totalCostUsd: 0,
      messageCount: 0,
      processAlive: true,
    };

    this.addToIndexes(session);
    this.stmtInsert?.run(
      session.sessionId, session.agentName, session.clientName,
      session.contextId, session.taskId,
      session.createdAt, session.lastAccessedAt,
      session.totalCostUsd, session.messageCount,
      session.processAlive ? 1 : 0,
    );

    return session;
  }

  update(sessionId: string, costUsd: number): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.totalCostUsd += costUsd;
      session.messageCount++;
      session.lastAccessedAt = Date.now();
      this.stmtUpdate?.run(
        session.lastAccessedAt, session.totalCostUsd,
        session.messageCount, session.processAlive ? 1 : 0,
        session.sessionId,
      );
    }
  }

  delete(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    this.removeSession(session);
    return true;
  }

  listForClient(clientName: string): SessionMetadata[] {
    const clientSet = this.byClient.get(clientName);
    if (!clientSet) return [];
    const result: SessionMetadata[] = [];
    for (const id of clientSet) {
      const s = this.sessions.get(id);
      if (s) result.push(s);
    }
    return result;
  }

  listAll(): SessionMetadata[] {
    return [...this.sessions.values()];
  }

  get size(): number {
    return this.sessions.size;
  }

  /** Persist the PID of the Claude process for a session (for orphan detection after restart). */
  savePid(contextId: string, pid: number): void {
    this.stmtSavePid?.run(pid, contextId);
  }

  /** Get the last known PID for a session's Claude process. */
  getLastPid(contextId: string): number | null {
    if (!this.stmtGetPid) return null;
    const row = this.stmtGetPid.get(contextId) as { last_pid: number | null } | undefined;
    return row?.last_pid ?? null;
  }

  /**
   * Mark all sessions as process-dead in memory and SQLite.
   * Called during graceful shutdown after releasing processes.
   */
  markAllProcessesDead(): void {
    for (const session of this.sessions.values()) {
      session.processAlive = false;
    }
    this.stmtMarkAllDead?.run();
    this.log.info({ count: this.sessions.size }, "marked all session processes dead");
  }

  private addToIndexes(session: SessionMetadata): void {
    this.sessions.set(session.sessionId, session);
    this.byContextId.set(session.contextId, session);
    this.byTaskId.set(session.taskId, session);

    let set = this.byClient.get(session.clientName);
    if (!set) {
      set = new Set();
      this.byClient.set(session.clientName, set);
    }
    set.add(session.sessionId);
  }

  private removeSession(session: SessionMetadata): void {
    this.sessions.delete(session.sessionId);
    this.byContextId.delete(session.contextId);
    this.byTaskId.delete(session.taskId);
    const clientSet = this.byClient.get(session.clientName);
    if (clientSet) {
      clientSet.delete(session.sessionId);
      if (clientSet.size === 0) {
        this.byClient.delete(session.clientName);
      }
    }
    // Persist the deletion
    this.stmtDelete?.run(session.sessionId);
    // Notify the runner to destroy the backing process
    if (session.processAlive) {
      this.onSessionEvicted?.(session.contextId);
    }
  }

  private cleanup(): void {
    const now = Date.now();
    let cleaned = 0;
    // Safe: Map iteration in JS handles deletions during traversal (skips deleted entries)
    for (const session of this.sessions.values()) {
      const tooOld = now - session.createdAt > this.maxLifetimeMs;
      const tooIdle = now - session.lastAccessedAt > this.maxIdleMs;
      if (tooOld || tooIdle) {
        this.removeSession(session);
        cleaned++;
      }
    }
    if (cleaned > 0) {
      this.log.debug({ cleaned, remaining: this.sessions.size }, "session cleanup");
    }
  }

  private loadFromDb(): void {
    if (!this.stmtSelectAll) return;
    const rows = this.stmtSelectAll.all() as SessionRow[];
    for (const row of rows) {
      const session: SessionMetadata = {
        sessionId: row.session_id,
        agentName: row.agent_name,
        clientName: row.client_name,
        contextId: row.context_id,
        taskId: row.task_id,
        createdAt: row.created_at,
        lastAccessedAt: row.last_accessed_at,
        totalCostUsd: row.total_cost_usd,
        messageCount: row.message_count,
        processAlive: false, // processes don't survive restart
      };
      this.addToIndexes(session);
      // Update the DB to reflect processAlive = false
      this.stmtUpdate?.run(
        session.lastAccessedAt, session.totalCostUsd,
        session.messageCount, 0,
        session.sessionId,
      );
    }
    if (rows.length > 0) {
      this.log.info({ count: rows.length }, "recovered sessions from database");
    }
  }
}
