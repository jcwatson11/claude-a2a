import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ClientConfig } from "./config.js";
import { A2AClient } from "./a2a-client.js";

export function createMcpServer(config: ClientConfig): McpServer {
  const server = new McpServer({
    name: "claude-a2a-client",
    version: "0.1.0",
  });

  // Cache A2A clients per server
  const clients = new Map<string, A2AClient>();
  function getClient(serverName: string): A2AClient {
    let client = clients.get(serverName);
    if (!client) {
      const entry = config.servers[serverName];
      if (!entry) {
        throw new Error(
          `Unknown server "${serverName}". Available: ${Object.keys(config.servers).join(", ")}`,
        );
      }
      client = new A2AClient(entry);
      clients.set(serverName, client);
    }
    return client;
  }

  // Tool: list_remote_servers
  server.tool(
    "list_remote_servers",
    "List configured remote claude-a2a servers",
    {},
    async () => {
      const servers = Object.entries(config.servers).map(([name, entry]) => ({
        name,
        url: entry.url,
      }));
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(servers, null, 2),
          },
        ],
      };
    },
  );

  // Tool: list_remote_agents
  server.tool(
    "list_remote_agents",
    "Fetch the Agent Card from a remote claude-a2a server to see available agents and capabilities",
    { server: z.string().describe("Name of the remote server (from config)") },
    async ({ server: serverName }) => {
      const client = getClient(serverName);
      const card = await client.getAgentCard();
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(card, null, 2),
          },
        ],
      };
    },
  );

  // Tool: send_message
  server.tool(
    "send_message",
    "Send a message to a remote Claude agent via the A2A protocol. Returns the agent's response along with session and cost metadata.",
    {
      server: z.string().describe("Name of the remote server"),
      message: z.string().describe("The message to send to the remote agent"),
      agent: z
        .string()
        .optional()
        .describe("Target agent name (defaults to first enabled agent)"),
      context_id: z
        .string()
        .optional()
        .describe("Context ID for session continuity (from previous response)"),
      task_id: z
        .string()
        .optional()
        .describe("Task ID for continuing an existing task"),
    },
    async ({ server: serverName, message, agent, context_id, task_id }) => {
      const client = getClient(serverName);
      const result = await client.sendMessage(message, {
        agent,
        contextId: context_id,
        taskId: task_id,
      });
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    },
  );

  // Tool: get_server_health
  server.tool(
    "get_server_health",
    "Check the health and status of a remote claude-a2a server",
    { server: z.string().describe("Name of the remote server") },
    async ({ server: serverName }) => {
      const client = getClient(serverName);
      const health = await client.getHealth();
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(health, null, 2),
          },
        ],
      };
    },
  );

  // Tool: list_sessions
  server.tool(
    "list_sessions",
    "List active sessions on a remote claude-a2a server (requires admin/master key auth)",
    { server: z.string().describe("Name of the remote server") },
    async ({ server: serverName }) => {
      const client = getClient(serverName);
      const sessions = await client.listSessions();
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(sessions, null, 2),
          },
        ],
      };
    },
  );

  // Tool: delete_session
  server.tool(
    "delete_session",
    "Delete/clean up a session on a remote claude-a2a server",
    {
      server: z.string().describe("Name of the remote server"),
      session_id: z.string().describe("The session ID to delete"),
    },
    async ({ server: serverName, session_id }) => {
      const client = getClient(serverName);
      const result = await client.deleteSession(session_id);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    },
  );

  return server;
}
