import type { Logger } from "pino";
import { z } from "zod";
import type { AgentConfig, Config } from "./config.js";
import { ClaudeSession, ClaudeSessionError, SessionBusyError, type ContentBlock } from "./claude-session.js";
import type { SqliteTaskStore } from "./services/task-store.js";
import type { SessionStore } from "./services/session-store.js";

// ---------------------------------------------------------------------------
// Response schema (unchanged — used by executor, budget tracker, tests)
// ---------------------------------------------------------------------------

export const ClaudeResponseSchema = z.object({
  result: z.string(),
  session_id: z.string(),
  is_error: z.boolean(),
  duration_ms: z.number(),
  duration_api_ms: z.number(),
  num_turns: z.number(),
  total_cost_usd: z.number(),
  usage: z.object({
    input_tokens: z.number(),
    output_tokens: z.number(),
    cache_creation_input_tokens: z.number().default(0),
    cache_read_input_tokens: z.number().default(0),
  }),
  model_used: z.string(),
  permission_denials: z.array(z.string()).default([]),
  context: z.object({
    used_tokens: z.number(),
    max_tokens: z.number(),
    remaining_tokens: z.number(),
    compact_recommended: z.boolean(),
  }).optional(),
});

export type ClaudeResponse = z.infer<typeof ClaudeResponseSchema>;

export interface RunOptions {
  agentName: string;
  agentConfig: AgentConfig;
  message: string | ContentBlock[];
  contextId: string;
  taskId?: string;
  /** Claude session ID for resuming after process death. Typically supplied by SessionStore. */
  resumeSessionId?: string;
}

// ---------------------------------------------------------------------------
// ClaudeRunner — session pool manager
// ---------------------------------------------------------------------------

export class ClaudeRunner {
  private readonly sessions = new Map<string, ClaudeSession>();
  private readonly taskToContext = new Map<string, string>();
  private readonly maxConcurrent: number;
  private readonly requestTimeout: number;
  private readonly config: Config;
  private readonly log: Logger;

  constructor(config: Config, log: Logger) {
    this.config = config;
    this.maxConcurrent = config.server.max_concurrent;
    this.requestTimeout = config.server.request_timeout;
    this.log = log.child({ component: "claude-runner" });
  }

  /** Number of active sessions (live Claude processes). */
  get concurrentCount(): number {
    return this.sessions.size;
  }

  /** Whether we're at the maximum number of concurrent sessions. */
  get isFull(): boolean {
    return this.sessions.size >= this.maxConcurrent;
  }

  /** Check if a live session exists for a contextId. */
  hasSession(contextId: string): boolean {
    const session = this.sessions.get(contextId);
    return !!session && session.isAlive;
  }

  /** Get the PID of the Claude process for a contextId, if a live session exists. */
  getSessionPid(contextId: string): number | undefined {
    return this.sessions.get(contextId)?.pid;
  }

  /**
   * Send a message to the session for a contextId.
   * Creates a new session if none exists. Reuses existing session otherwise.
   * Throws CapacityError if no session exists and we're at capacity.
   * Throws SessionBusyError if the session is currently processing.
   */
  async sendMessage(options: RunOptions): Promise<ClaudeResponse> {
    let session = this.sessions.get(options.contextId);

    // If session is dead, remove it and allow re-creation
    if (session && !session.isAlive) {
      this.sessions.delete(options.contextId);
      session = undefined;
    }

    // Create new session if needed
    if (!session) {
      if (this.isFull) {
        throw new CapacityError(
          `At capacity (${this.sessions.size}/${this.maxConcurrent})`,
        );
      }

      this.log.info(
        {
          agent: options.agentName,
          contextId: options.contextId,
          resumeSessionId: options.resumeSessionId,
          concurrent: this.sessions.size + 1,
        },
        "creating new claude session",
      );

      session = new ClaudeSession({
        agentName: options.agentName,
        agentConfig: options.agentConfig,
        config: this.config,
        log: this.log,
        resumeSessionId: options.resumeSessionId,
      });

      session.onDeath = (err) => {
        this.log.warn(
          { contextId: options.contextId, error: err.message },
          "claude session died",
        );
        this.sessions.delete(options.contextId);
      };

      this.sessions.set(options.contextId, session);
    }

    // Track taskId → contextId for cancellation
    if (options.taskId) {
      this.taskToContext.set(options.taskId, options.contextId);
    }

    const response = await session.sendMessage(
      options.message,
      this.requestTimeout * 1000,
    );

    this.log.info(
      {
        agent: options.agentName,
        contextId: options.contextId,
        sessionId: response.session_id,
        cost: response.total_cost_usd,
        duration: response.duration_ms,
      },
      "claude message completed",
    );

    return response;
  }

  /** Destroy a specific session by contextId. */
  destroySession(contextId: string): void {
    const session = this.sessions.get(contextId);
    if (session) {
      session.destroy();
      this.sessions.delete(contextId);
      this.log.info({ contextId }, "session destroyed");
    }
  }

  /** Kill all active sessions (used for explicit kills: admin, task cancellation, tests). */
  killAll(): void {
    for (const [contextId, session] of this.sessions) {
      session.destroy();
      this.log.debug({ contextId }, "killing session");
    }
    this.sessions.clear();
    this.taskToContext.clear();
  }

  /**
   * Release all active sessions during graceful shutdown.
   * Processes continue running independently. In-flight tasks are updated
   * to "working" status with an informative message.
   */
  async releaseAll(taskStore: SqliteTaskStore): Promise<void> {
    // Update in-flight tasks before releasing sessions
    for (const [taskId, contextId] of this.taskToContext) {
      const session = this.sessions.get(contextId);
      if (session?.isAlive) {
        try {
          const task = await taskStore.load(taskId);
          if (task && task.status.state === "working") {
            task.status = {
              state: "working",
              message: {
                kind: "message",
                messageId: `shutdown-${Date.now()}`,
                role: "agent",
                parts: [{
                  kind: "text",
                  text: "Server restarting — the agent is still processing. Reconnect with the same contextId to retrieve results.",
                }],
                contextId,
              },
              timestamp: new Date().toISOString(),
            };
            await taskStore.save(task);
            this.log.info({ taskId, contextId }, "updated in-flight task status for shutdown");
          }
        } catch (err) {
          this.log.warn(
            { taskId, error: err instanceof Error ? err.message : String(err) },
            "failed to update task status during shutdown",
          );
        }
      }
    }

    // Release all sessions (close stdin, unref — process continues)
    for (const [contextId, session] of this.sessions) {
      session.release();
      this.log.info({ contextId, pid: session.pid }, "released session (process continues)");
    }
    this.sessions.clear();
    this.taskToContext.clear();
  }

  /**
   * Cancel a specific task's session. Returns true if found and destroyed.
   * Also handles orphaned processes from before a restart (via sessionStore PID lookup).
   */
  cancelByTaskId(taskId: string, sessionStore?: SessionStore): boolean {
    const contextId = this.taskToContext.get(taskId);
    if (contextId) {
      const session = this.sessions.get(contextId);
      if (session?.isAlive) {
        session.destroy();
        this.sessions.delete(contextId);
        this.taskToContext.delete(taskId);
        this.log.info({ taskId, contextId }, "cancelled session for task");
        return true;
      }
    }

    // No live session — check for orphaned process via session store
    if (sessionStore) {
      const sessionMeta = sessionStore.getByTaskId(taskId);
      if (sessionMeta) {
        const pid = sessionStore.getLastPid(sessionMeta.contextId);
        if (pid) {
          return this.killOrphanPid(pid, taskId, sessionMeta.contextId);
        }
      }
    }

    return false;
  }

  /**
   * Kill an orphaned process by PID. Returns true if the process was found and killed.
   */
  private killOrphanPid(pid: number, taskId: string, contextId: string): boolean {
    try {
      process.kill(pid, 0); // existence check
    } catch {
      // Process is already dead
      return false;
    }

    this.log.info({ pid, taskId, contextId }, "killing orphaned process");
    try {
      process.kill(pid, "SIGTERM");
      // Schedule SIGKILL as fallback
      setTimeout(() => {
        try {
          process.kill(pid, 0); // still alive?
          process.kill(pid, "SIGKILL");
        } catch {
          // already dead
        }
      }, 5000);
      return true;
    } catch {
      return false;
    }
  }
}

// ---------------------------------------------------------------------------
// Error classes (re-exported for backward compatibility)
// ---------------------------------------------------------------------------

export class CapacityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CapacityError";
  }
}

export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimeoutError";
  }
}

export class ClaudeProcessError extends Error {
  readonly stderr: string;
  constructor(message: string, stderr: string) {
    super(message);
    this.name = "ClaudeProcessError";
    this.stderr = stderr;
  }
}

export { SessionBusyError, ClaudeSessionError };
