import { v4 as uuidv4 } from "uuid";
import type { ServerEntry } from "./config.js";

/** Minimal A2A client that uses fetch directly (avoids SDK client dependency complexities) */
export class A2AClient {
  private readonly url: string;
  private readonly token: string;

  constructor(server: ServerEntry) {
    this.url = server.url.replace(/\/$/, "");
    this.token = server.token;
  }

  async getAgentCard(): Promise<Record<string, unknown>> {
    const res = await fetch(
      `${this.url}/.well-known/agent-card.json`,
      { headers: this.headers() },
    );
    if (!res.ok) {
      throw new Error(`Failed to get agent card: ${res.status} ${res.statusText}`);
    }
    return (await res.json()) as Record<string, unknown>;
  }

  async sendMessage(
    message: string,
    options?: {
      agent?: string;
      contextId?: string;
      taskId?: string;
    },
  ): Promise<Record<string, unknown>> {
    const payload = {
      jsonrpc: "2.0",
      id: uuidv4(),
      method: "message/send",
      params: {
        message: {
          kind: "message",
          messageId: uuidv4(),
          role: "user",
          parts: [{ kind: "text", text: message }],
          ...(options?.contextId ? { contextId: options.contextId } : {}),
          ...(options?.taskId ? { taskId: options.taskId } : {}),
          metadata: {
            ...(options?.agent ? { agent: options.agent } : {}),
          },
        },
        configuration: {
          blocking: true,
        },
      },
    };

    const res = await fetch(`${this.url}/a2a/jsonrpc`, {
      method: "POST",
      headers: {
        ...this.headers(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`A2A request failed: ${res.status} ${res.statusText} — ${body}`);
    }

    const jsonRpcResponse = (await res.json()) as Record<string, unknown>;

    if (jsonRpcResponse["error"]) {
      const err = jsonRpcResponse["error"] as Record<string, unknown>;
      throw new Error(`A2A error: ${err["message"]} (code: ${err["code"]})`);
    }

    return jsonRpcResponse["result"] as Record<string, unknown>;
  }

  async getHealth(): Promise<Record<string, unknown>> {
    const res = await fetch(`${this.url}/health`, {
      headers: this.headers(),
    });
    if (!res.ok) {
      throw new Error(`Health check failed: ${res.status}`);
    }
    return (await res.json()) as Record<string, unknown>;
  }

  async listSessions(): Promise<Record<string, unknown>> {
    const res = await fetch(`${this.url}/admin/sessions`, {
      headers: this.headers(),
    });
    if (!res.ok) {
      throw new Error(`List sessions failed: ${res.status}`);
    }
    return (await res.json()) as Record<string, unknown>;
  }

  async deleteSession(sessionId: string): Promise<Record<string, unknown>> {
    const res = await fetch(`${this.url}/admin/sessions/${sessionId}`, {
      method: "DELETE",
      headers: this.headers(),
    });
    if (!res.ok) {
      throw new Error(`Delete session failed: ${res.status}`);
    }
    return (await res.json()) as Record<string, unknown>;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = {};
    if (this.token) {
      h["Authorization"] = this.token.startsWith("Bearer ")
        ? this.token
        : `Bearer ${this.token}`;
    }
    return h;
  }
}
