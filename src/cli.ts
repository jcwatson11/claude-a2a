#!/usr/bin/env node

import { parseArgs } from "node:util";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    config: { type: "string", short: "c" },
    port: { type: "string", short: "p" },
    host: { type: "string", short: "H" },
    help: { type: "boolean", short: "h" },
    version: { type: "boolean", short: "v" },
  },
});

const command = positionals[0] ?? "serve";

if (values.help) {
  console.log(`claude-a2a - A2A server wrapping the Claude CLI

Usage:
  claude-a2a serve [options]    Start the A2A server
  claude-a2a client             Start the MCP client (stdio)
  claude-a2a token <args>       Generate a JWT token

Options:
  -c, --config <path>    Config file path
  -p, --port <port>      Override server port
  -H, --host <host>      Override server host
  -h, --help             Show help
  -v, --version          Show version
`);
  process.exit(0);
}

if (values.version) {
  const { VERSION } = await import("./version.js");
  console.log(`claude-a2a ${VERSION}`);
  process.exit(0);
}

switch (command) {
  case "serve": {
    const { loadConfig } = await import("./server/config.js");
    const { startServer } = await import("./server/index.js");

    const config = loadConfig(values.config);

    // Override from CLI flags
    if (values.port) config.server.port = parseInt(values.port, 10);
    if (values.host) config.server.host = values.host;

    await startServer(config);
    break;
  }

  case "client": {
    const { startMcpClient } = await import("./client/index.js");
    await startMcpClient();
    break;
  }

  case "token": {
    const { loadConfig } = await import("./server/config.js");
    const { createToken } = await import("./server/auth/tokens.js");

    const config = loadConfig(values.config);
    const sub = positionals[1];
    const scopes = positionals.slice(2);

    if (!sub) {
      console.error("Usage: claude-a2a token <client-name> [scopes...]");
      console.error("Example: claude-a2a token my-agent agent:general agent:code");
      process.exit(1);
    }

    if (scopes.length === 0) {
      scopes.push("*");
    }

    const token = createToken(config, { sub, scopes });
    console.log(JSON.stringify({ token, sub, scopes }, null, 2));
    break;
  }

  default:
    console.error(`Unknown command: ${command}`);
    process.exit(1);
}
