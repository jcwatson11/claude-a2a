#!/usr/bin/env node

import { parseArgs } from "node:util";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    // Global options
    config: { type: "string", short: "c" },
    port: { type: "string", short: "p" },
    host: { type: "string", short: "H" },
    help: { type: "boolean", short: "h" },
    version: { type: "boolean", short: "v" },
    // Serve: single-agent flags
    agent: { type: "string" },
    "work-dir": { type: "string" },
    model: { type: "string" },
    "permission-mode": { type: "string" },
    "system-prompt": { type: "string" },
    "max-budget": { type: "string" },
    // Init flags
    yes: { type: "boolean", short: "y" },
    dir: { type: "string", short: "d" },
  },
});

const command = positionals[0] ?? "serve";

if (values.help) {
  console.log(`claude-a2a - A2A server wrapping the Claude CLI

Usage:
  claude-a2a serve [options]    Start the A2A server
  claude-a2a init [options]     Scaffold config files for a new project
  claude-a2a client             Start the MCP client (stdio)
  claude-a2a token <args>       Generate a JWT token

Serve options:
  -c, --config <path>           Config file path
  -p, --port <port>             Override server port
  -H, --host <host>             Override server host
  --agent <name>                Quick single-agent mode (no config file needed)
  --work-dir <path>             Agent working directory (with --agent)
  --model <model>               Claude model to use (with --agent)
  --permission-mode <mode>      Permission mode (with --agent)
  --system-prompt <text>        System prompt (with --agent)
  --max-budget <usd>            Max budget in USD (with --agent)

Init options:
  -y, --yes                     Non-interactive mode with defaults
  -d, --dir <path>              Target directory (default: current dir)

General:
  -h, --help                    Show help
  -v, --version                 Show version
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
    if (values.agent) {
      const { buildConfigFromFlags } = await import("./server/config.js");
      const { startServer } = await import("./server/index.js");

      const config = buildConfigFromFlags({
        agent: values.agent,
        workDir: values["work-dir"],
        model: values.model,
        permissionMode: values["permission-mode"],
        systemPrompt: values["system-prompt"],
        maxBudget: values["max-budget"]
          ? parseFloat(values["max-budget"])
          : undefined,
        port: values.port ? parseInt(values.port, 10) : undefined,
        host: values.host,
      });

      await startServer(config);
    } else {
      const { loadConfig } = await import("./server/config.js");
      const { startServer } = await import("./server/index.js");

      const config = loadConfig(values.config);

      // Override from CLI flags
      if (values.port) config.server.port = parseInt(values.port, 10);
      if (values.host) config.server.host = values.host;

      await startServer(config);
    }
    break;
  }

  case "init": {
    const { runInit } = await import("./init.js");
    await runInit({
      yes: values.yes,
      dir: values.dir,
    });
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
      console.error(
        "Example: claude-a2a token my-agent agent:general agent:code",
      );
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
