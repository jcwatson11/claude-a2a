#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadClientConfig } from "./config.js";
import { createMcpServer } from "./mcp-server.js";

export async function startMcpClient(): Promise<void> {
  const config = loadClientConfig();
  const server = createMcpServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// If run directly
const isDirectRun =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("client/index.ts") ||
  process.argv[1]?.endsWith("client.js");

if (isDirectRun) {
  startMcpClient().catch((err) => {
    console.error("MCP client failed:", err);
    process.exit(1);
  });
}
