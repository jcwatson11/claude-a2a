import type { Task } from "@a2a-js/sdk";
import type { TaskStore, ServerCallContext } from "@a2a-js/sdk/server";
import type { AppDatabase } from "./database.js";
import type Database from "better-sqlite3";
import { AuthenticatedUser } from "../auth/user.js";

interface TaskRow {
  id: string;
  context_id: string;
  status_state: string;
  status_timestamp: string | null;
  status_message_json: string | null;
  artifacts_json: string | null;
  history_json: string | null;
  metadata_json: string | null;
  client_name: string | null;
  updated_at: string;
}

export class SqliteTaskStore implements TaskStore {
  private readonly stmtUpsert: Database.Statement;
  private readonly stmtLoad: Database.Statement;

  constructor(appDb: AppDatabase) {
    // client_name is set on INSERT but intentionally NOT updated on conflict —
    // the owner is fixed at task creation and cannot be changed.
    this.stmtUpsert = appDb.db.prepare(`
      INSERT INTO tasks (id, context_id, status_state, status_timestamp, status_message_json, artifacts_json, history_json, metadata_json, client_name, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(id) DO UPDATE SET
        context_id = excluded.context_id,
        status_state = excluded.status_state,
        status_timestamp = excluded.status_timestamp,
        status_message_json = excluded.status_message_json,
        artifacts_json = excluded.artifacts_json,
        history_json = excluded.history_json,
        metadata_json = excluded.metadata_json,
        updated_at = datetime('now')
    `);

    this.stmtLoad = appDb.db.prepare("SELECT * FROM tasks WHERE id = ?");
  }

  async save(task: Task, context?: ServerCallContext): Promise<void> {
    const clientName = resolveClientName(context);
    this.stmtUpsert.run(
      task.id,
      task.contextId,
      task.status.state,
      task.status.timestamp ?? null,
      task.status.message ? JSON.stringify(task.status.message) : null,
      task.artifacts ? JSON.stringify(task.artifacts) : null,
      task.history ? JSON.stringify(task.history) : null,
      task.metadata ? JSON.stringify(task.metadata) : null,
      clientName,
    );
  }

  async load(taskId: string, context?: ServerCallContext): Promise<Task | undefined> {
    const row = this.stmtLoad.get(taskId) as TaskRow | undefined;
    if (!row) return undefined;

    // Tenant isolation: check that the requesting user owns this task
    if (!canAccessTask(context, row.client_name)) {
      return undefined;
    }

    const task: Task = {
      id: row.id,
      contextId: row.context_id,
      kind: "task",
      status: {
        state: row.status_state as Task["status"]["state"],
        ...(row.status_timestamp ? { timestamp: row.status_timestamp } : {}),
        ...(row.status_message_json ? { message: JSON.parse(row.status_message_json) } : {}),
      },
      ...(row.artifacts_json ? { artifacts: JSON.parse(row.artifacts_json) } : {}),
      ...(row.history_json ? { history: JSON.parse(row.history_json) } : {}),
      ...(row.metadata_json ? { metadata: JSON.parse(row.metadata_json) } : {}),
    };

    return task;
  }
}

/**
 * Extract client name from the ServerCallContext for task ownership.
 * Returns null for internal/trusted calls (no context).
 */
function resolveClientName(context?: ServerCallContext): string | null {
  if (!context?.user) return null;
  if (context.user instanceof AuthenticatedUser) {
    return context.user.authContext.clientName;
  }
  return null;
}

/**
 * Check if the requesting user can access a task.
 * - No context (internal server call) → allow
 * - Master auth → allow
 * - Authenticated user whose clientName matches the task owner → allow
 * - Task has no owner (legacy / created by internal call) → allow
 * - Otherwise → deny
 */
function canAccessTask(context: ServerCallContext | undefined, taskOwner: string | null): boolean {
  // No context = trusted internal call (e.g., releaseAll, shutdown)
  if (!context) return true;

  // No user in context = unauthenticated → deny
  if (!context.user) return false;

  if (context.user instanceof AuthenticatedUser) {
    // Master key can access all tasks
    if (context.user.authContext.type === "master") return true;

    // Task has no owner (legacy data or internally created) → allow
    if (!taskOwner) return true;

    // Check ownership
    return context.user.userName === taskOwner;
  }

  // UnauthenticatedUser → deny
  return false;
}
