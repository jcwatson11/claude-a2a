import type { Logger } from "pino";
import type { Config } from "../config.js";

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
}

export class SessionStore {
  private readonly sessions = new Map<string, SessionMetadata>();
  private readonly maxLifetimeMs: number;
  private readonly maxIdleMs: number;
  private readonly maxPerClient: number;
  private readonly log: Logger;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: Config, log: Logger) {
    this.maxLifetimeMs = config.sessions.max_lifetime_hours * 3600_000;
    this.maxIdleMs = config.sessions.max_idle_hours * 3600_000;
    this.maxPerClient = config.sessions.max_per_client;
    this.log = log.child({ component: "session-store" });
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

  /** Get session by A2A task/context IDs */
  getByTaskId(taskId: string): SessionMetadata | undefined {
    for (const s of this.sessions.values()) {
      if (s.taskId === taskId) {
        s.lastAccessedAt = Date.now();
        return s;
      }
    }
    return undefined;
  }

  getByContextId(contextId: string): SessionMetadata | undefined {
    for (const s of this.sessions.values()) {
      if (s.contextId === contextId) {
        s.lastAccessedAt = Date.now();
        return s;
      }
    }
    return undefined;
  }

  create(
    sessionId: string,
    agentName: string,
    clientName: string,
    contextId: string,
    taskId: string,
  ): SessionMetadata {
    // Check per-client limit
    const clientSessions = [...this.sessions.values()].filter(
      (s) => s.clientName === clientName,
    );
    if (clientSessions.length >= this.maxPerClient) {
      // Evict oldest idle session
      clientSessions.sort((a, b) => a.lastAccessedAt - b.lastAccessedAt);
      const evict = clientSessions[0]!;
      this.log.info(
        { sessionId: evict.sessionId, client: clientName },
        "evicting oldest session (per-client limit)",
      );
      this.sessions.delete(evict.sessionId);
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
    };
    this.sessions.set(sessionId, session);
    return session;
  }

  update(sessionId: string, costUsd: number): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.totalCostUsd += costUsd;
      session.messageCount++;
      session.lastAccessedAt = Date.now();
    }
  }

  delete(sessionId: string): boolean {
    return this.sessions.delete(sessionId);
  }

  listForClient(clientName: string): SessionMetadata[] {
    return [...this.sessions.values()].filter(
      (s) => s.clientName === clientName,
    );
  }

  listAll(): SessionMetadata[] {
    return [...this.sessions.values()];
  }

  get size(): number {
    return this.sessions.size;
  }

  private cleanup(): void {
    const now = Date.now();
    let cleaned = 0;
    for (const [id, session] of this.sessions) {
      const tooOld = now - session.createdAt > this.maxLifetimeMs;
      const tooIdle = now - session.lastAccessedAt > this.maxIdleMs;
      if (tooOld || tooIdle) {
        this.sessions.delete(id);
        cleaned++;
      }
    }
    if (cleaned > 0) {
      this.log.debug({ cleaned, remaining: this.sessions.size }, "session cleanup");
    }
  }
}
