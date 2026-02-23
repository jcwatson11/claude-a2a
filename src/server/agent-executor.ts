import { v4 as uuidv4 } from "uuid";
import type { Message, Part } from "@a2a-js/sdk";
import type {
  AgentExecutor,
  RequestContext,
  ExecutionEventBus,
} from "@a2a-js/sdk/server";
import type { Logger } from "pino";
import {
  ClaudeRunner,
  CapacityError,
  TimeoutError,
  ClaudeProcessError,
  SessionBusyError,
  type ClaudeResponse,
} from "./claude-runner.js";
import type { ContentBlock } from "./claude-session.js";
import type { Config } from "./config.js";
import { AuthenticatedUser } from "./auth/user.js";
import { SessionStore } from "./services/session-store.js";
import { BudgetTracker } from "./services/budget-tracker.js";

// ---------------------------------------------------------------------------
// A2A Part[] → Claude content block conversion
// ---------------------------------------------------------------------------

const IMAGE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

/**
 * Convert A2A message parts to Claude CLI content format.
 *
 * When all parts are text, returns a plain string (backward compat).
 * When non-text parts are present, returns a ContentBlock[] array.
 */
export function convertPartsToMessage(
  parts: Part[],
): { message: string | ContentBlock[]; hasNonText: boolean } {
  const hasNonText = parts.some((p) => p.kind !== "text");

  // Fast path: text-only → plain string (identical to previous behavior)
  if (!hasNonText) {
    const text = parts
      .filter((p): p is Extract<Part, { kind: "text" }> => p.kind === "text")
      .map((p) => p.text)
      .join("\n");
    return { message: text, hasNonText: false };
  }

  // Multimodal path: build content blocks array
  const blocks: ContentBlock[] = [];

  for (const part of parts) {
    if (part.kind === "text") {
      blocks.push({ type: "text", text: part.text });
    } else if (part.kind === "file") {
      const file = part.file;
      if ("bytes" in file) {
        const mime = file.mimeType ?? "application/octet-stream";
        if (IMAGE_MIME_TYPES.has(mime)) {
          blocks.push({
            type: "image",
            source: { type: "base64", media_type: mime, data: file.bytes },
          });
        } else {
          blocks.push({
            type: "document",
            source: { type: "base64", media_type: mime, data: file.bytes },
          });
        }
        if (file.name) {
          blocks.push({ type: "text", text: `[File: ${file.name}]` });
        }
      } else if ("uri" in file) {
        const label = file.name ?? file.uri;
        const mimeHint = file.mimeType ? ` (${file.mimeType})` : "";
        blocks.push({
          type: "text",
          text: `[Referenced file: ${label}${mimeHint} — URI: ${file.uri}] (URI file download not supported; the file was not included.)`,
        });
      }
    } else if (part.kind === "data") {
      blocks.push({
        type: "text",
        text: JSON.stringify(part.data, null, 2),
      });
    }
  }

  return { message: blocks, hasNonText: true };
}

export class ClaudeAgentExecutor implements AgentExecutor {
  private readonly runner: ClaudeRunner;
  private readonly config: Config;
  private readonly sessionStore: SessionStore;
  private readonly budgetTracker: BudgetTracker;
  private readonly log: Logger;

  constructor(
    runner: ClaudeRunner,
    config: Config,
    sessionStore: SessionStore,
    budgetTracker: BudgetTracker,
    log: Logger,
  ) {
    this.runner = runner;
    this.config = config;
    this.sessionStore = sessionStore;
    this.budgetTracker = budgetTracker;
    this.log = log.child({ component: "agent-executor" });
  }

  async execute(
    requestContext: RequestContext,
    eventBus: ExecutionEventBus,
  ): Promise<void> {
    const { userMessage, taskId, contextId } = requestContext;

    // Convert A2A parts to Claude content format
    const { message: messageContent } = convertPartsToMessage(userMessage.parts);
    const isEmpty = typeof messageContent === "string"
      ? !messageContent.trim()
      : messageContent.length === 0;
    if (isEmpty) {
      this.publishMessage(eventBus, contextId, "Error: Empty message");
      return;
    }

    // Determine which agent to target
    const agentName = this.resolveAgentName(userMessage);
    const agentConfig = this.config.agents[agentName];

    if (!agentConfig || !agentConfig.enabled) {
      this.publishMessage(
        eventBus,
        contextId,
        `Error: Agent "${agentName}" not found or disabled`,
      );
      return;
    }

    // Check scope authorization
    if (agentConfig.required_scopes.length > 0) {
      const userScopes = this.resolveScopes(requestContext, userMessage);
      if (!userScopes.includes("*") &&
          !agentConfig.required_scopes.some((s) => userScopes.includes(s))) {
        this.publishMessage(
          eventBus,
          contextId,
          `Error: Insufficient scope for agent "${agentName}". Required: ${agentConfig.required_scopes.join(", ")}`,
        );
        return;
      }
    }

    // Extract client name from authenticated user or message metadata
    const user = requestContext.context?.user;
    const clientName =
      (user instanceof AuthenticatedUser ? user.authContext.clientName : undefined)
      ?? (userMessage.metadata?.["clientName"] as string | undefined)
      ?? "anonymous";

    // Check budget (per-client limit from JWT overrides the default)
    const clientBudgetLimit = user instanceof AuthenticatedUser ? user.authContext.budgetDailyUsd : undefined;
    const budgetError = this.budgetTracker.check(clientName, clientBudgetLimit);
    if (budgetError) {
      this.publishMessage(eventBus, contextId, `Error: ${budgetError}`);
      return;
    }

    // Look up existing session for resume capability
    const existingSession = this.sessionStore.getByContextId(contextId);

    // Reject agent mismatch — a contextId is bound to the agent it was created with.
    // Allowing reuse with a different agent would silently bypass the original agent's
    // permissions, tools, and model config. This is a security concern in multi-tenant use.
    if (existingSession && existingSession.agentName !== agentName) {
      this.publishMessage(
        eventBus,
        contextId,
        `Error: Context "${contextId}" belongs to agent "${existingSession.agentName}", ` +
        `not "${agentName}". Use a new contextId to talk to a different agent.`,
      );
      return;
    }

    // Check for orphaned process from a previous server run
    if (existingSession && !existingSession.processAlive) {
      const lastPid = this.sessionStore.getLastPid(contextId);
      if (lastPid && this.isProcessAlive(lastPid)) {
        this.publishMessage(
          eventBus,
          contextId,
          "A previous Claude process for this session is still running. " +
          "Cancel the task to terminate it, or wait for it to complete and retry.",
          { orphan_pid: lastPid },
        );
        return;
      }
    }

    try {
      const response = await this.runner.sendMessage({
        agentName,
        agentConfig,
        message: messageContent,
        contextId,
        taskId,
        resumeSessionId: existingSession?.sessionId,
      });

      // Track session
      if (!existingSession) {
        this.sessionStore.create(
          response.session_id,
          agentName,
          clientName,
          contextId,
          taskId,
        );
      } else {
        this.sessionStore.update(response.session_id, response.total_cost_usd);
      }

      // Persist PID for orphan detection after restart
      const pid = this.runner.getSessionPid(contextId);
      if (pid) {
        this.sessionStore.savePid(contextId, pid);
      }

      // Track budget
      this.budgetTracker.record_cost(clientName, response.total_cost_usd);

      // Build the response message with claude extension metadata
      const metadata = buildClaudeExtension(response, agentName);

      if (response.permission_denials.length > 0) {
        metadata["error_type"] = "permission_denied";
      }

      const responseMessage: Message = {
        kind: "message",
        messageId: uuidv4(),
        role: "agent",
        parts: [{ kind: "text", text: response.result }],
        contextId,
        metadata,
      };

      eventBus.publish(responseMessage);
      eventBus.finished();
    } catch (err) {
      let errorText: string;
      if (err instanceof CapacityError) {
        errorText = `Error: ${err.message}`;
      } else if (err instanceof SessionBusyError) {
        errorText = "Error: Session is currently processing another message. Please wait.";
      } else if (err instanceof TimeoutError) {
        errorText = `Error: ${err.message}`;
      } else if (err instanceof ClaudeProcessError) {
        errorText = `Error: Claude process failed — ${err.message}`;
        this.log.error({ stderr: err.stderr.slice(0, 500) }, "claude process error");
      } else {
        errorText = `Error: ${err instanceof Error ? err.message : String(err)}`;
      }

      this.publishMessage(eventBus, contextId, errorText);
    }
  }

  async cancelTask(
    taskId: string,
    _eventBus: ExecutionEventBus,
  ): Promise<void> {
    const cancelled = this.runner.cancelByTaskId(taskId, this.sessionStore);
    if (cancelled) {
      this.log.info({ taskId }, "task cancelled");
    } else {
      this.log.warn({ taskId }, "cancelTask: no active process found for task");
    }
  }

  /** Check if a process with the given PID is still alive. */
  private isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  private resolveScopes(
    requestContext: RequestContext,
    message: Message,
  ): string[] {
    // From message metadata (used in tests and direct API calls)
    const metaScopes = message.metadata?.["scopes"];
    if (Array.isArray(metaScopes)) return metaScopes as string[];

    // From the authenticated user (set by auth middleware → userBuilder → ServerCallContext)
    const user = requestContext.context?.user;
    if (user instanceof AuthenticatedUser) {
      return user.authContext.scopes;
    }

    // No scopes found — default to empty (deny)
    return [];
  }

  private resolveAgentName(message: Message): string {
    const metaAgent = message.metadata?.["agent"] as string | undefined;
    if (metaAgent && this.config.agents[metaAgent]) {
      return metaAgent;
    }
    for (const [name, cfg] of Object.entries(this.config.agents)) {
      if (cfg.enabled) return name;
    }
    return "general";
  }

  /** Publish a simple agent Message and signal finished — the pattern the A2A SDK expects for blocking requests */
  private publishMessage(
    eventBus: ExecutionEventBus,
    contextId: string,
    text: string,
    metadata?: Record<string, unknown>,
  ): void {
    const msg: Message = {
      kind: "message",
      messageId: uuidv4(),
      role: "agent",
      parts: [{ kind: "text", text }],
      contextId,
      ...(metadata ? { metadata } : {}),
    };
    eventBus.publish(msg);
    eventBus.finished();
  }
}

function buildClaudeExtension(
  response: ClaudeResponse,
  agentName: string,
): Record<string, unknown> {
  return {
    claude: {
      agent: agentName,
      session_id: response.session_id,
      context: response.context ?? null,
      cost_usd: response.total_cost_usd,
      duration_ms: response.duration_ms,
      duration_api_ms: response.duration_api_ms,
      permission_denials: response.permission_denials,
      model_used: response.model_used,
      num_turns: response.num_turns,
      usage: response.usage,
    },
  };
}
