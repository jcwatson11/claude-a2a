import { v4 as uuidv4 } from "uuid";
import type { Message, TaskStatusUpdateEvent } from "@a2a-js/sdk";
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
  type ClaudeResponse,
} from "./claude-runner.js";
import type { Config } from "./config.js";
import { SessionStore } from "./services/session-store.js";
import { BudgetTracker } from "./services/budget-tracker.js";

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

    // Extract the text from the incoming message
    const textParts = userMessage.parts.filter((p) => p.kind === "text");
    const messageText = textParts.map((p) => p.text).join("\n");

    if (!messageText.trim()) {
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

    // Extract client name from message metadata or request context
    const clientName =
      (requestContext.context as Record<string, unknown> | undefined)?.[
        "clientName"
      ] as string | undefined
      ?? (userMessage.metadata?.["clientName"] as string | undefined)
      ?? "anonymous";

    // Check budget
    const budgetError = this.budgetTracker.check(clientName);
    if (budgetError) {
      this.publishMessage(eventBus, contextId, `Error: ${budgetError}`);
      return;
    }

    // Check capacity
    if (this.runner.isFull) {
      this.publishMessage(
        eventBus,
        contextId,
        "Error: Server at capacity, please retry later",
      );
      return;
    }

    // Look up existing session for this context
    const existingSession = this.sessionStore.getByContextId(contextId);
    const sessionId = existingSession?.sessionId;

    try {
      const response = await this.runner.run({
        agentName,
        agentConfig,
        message: messageText,
        sessionId,
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
    _taskId: string,
    _eventBus: ExecutionEventBus,
  ): Promise<void> {
    this.log.warn("cancelTask not implemented");
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
