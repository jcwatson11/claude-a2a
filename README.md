# claude-a2a

An A2A-compatible server that wraps the [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code), enabling any A2A client to send messages to Claude agents on a machine and receive responses. Also includes an MCP client so that interactive Claude Code sessions can natively call remote agents.

## What problem does this solve?

Claude Code agents running on different machines have no built-in way to communicate with each other. There is no push mechanism in MCP, no way to inject messages into an active Claude Code session, and no standard protocol for bridging separate Claude instances.

**claude-a2a** solves this by exposing the local `claude` CLI as a network service using the A2A protocol. Any machine that can reach the server over HTTP can send messages to Claude and get responses back, complete with session continuity, cost tracking, and access controls.

## Protocols

claude-a2a implements two protocols:

### A2A (Agent-to-Agent)

[A2A](https://a2aprotocol.ai/) is Google's open protocol for communication between AI agents. It defines how agents discover each other (via Agent Cards), exchange messages, and track tasks. claude-a2a implements A2A v0.3.0 using the official [@a2a-js/sdk](https://github.com/a2aproject/a2a-js).

The server exposes both JSON-RPC and REST transports:
- `POST /a2a/jsonrpc` — A2A JSON-RPC 2.0 endpoint
- `/a2a/rest/v1/...` — A2A REST endpoints
- `GET /.well-known/agent-card.json` — Agent Card for discovery

### MCP (Model Context Protocol)

[MCP](https://modelcontextprotocol.io/) is Anthropic's protocol for giving AI models access to tools and data. The included MCP client runs as a stdio server that Claude Code can connect to, giving an interactive Claude session tools to call remote claude-a2a servers.

## How it works

```
Remote Agent / A2A Client
        |
        | A2A Protocol (HTTP)
        v
+------------------+
|    claude-a2a    |   Express + @a2a-js/sdk
|                  |
|  Agent Card      |   /.well-known/agent-card.json
|  Auth layer      |   Master key / JWT tokens
|  Rate limiter    |
|  Budget tracker  |
|  Claude Runner   |   --> spawns: claude -p --output-format json --resume <session-id>
+------------------+
        |
        v
   Claude CLI (local)
```

The core insight is that `claude -p --output-format json --resume <session-id>` provides stateless invocation with session continuity. claude-a2a maps A2A protocol concepts onto this:

| A2A Concept | claude-a2a Implementation |
|---|---|
| Agent Card | Describes each configured Claude agent |
| Message (user) | Forwarded to `claude -p` via stdin |
| Message (agent) | Claude CLI's JSON response |
| Task context | Maps to a Claude CLI session via `--resume` |
| Skills | Agent configurations (tools, model, description) |

Each response includes Claude-specific metadata (session ID, token usage, cost, model used) in the message's `metadata.claude` field.

## Requirements

- **Node.js** >= 18 (tested with 24)
- **Claude Code CLI** installed and authenticated (`claude` command available in PATH)

## Quick start

```bash
# Clone and install
cd claude-a2a
npm install
npm run build

# Start with a master key for auth
CLAUDE_A2A_MASTER_KEY=my-secret-key node dist/cli.js serve

# In another terminal — check health
curl http://localhost:8462/health

# Send a message
curl -X POST http://localhost:8462/a2a/jsonrpc \
  -H "Authorization: Bearer my-secret-key" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": "1",
    "method": "message/send",
    "params": {
      "message": {
        "kind": "message",
        "messageId": "msg-1",
        "role": "user",
        "parts": [{"kind": "text", "text": "What is 2+2?"}]
      },
      "configuration": {"blocking": true}
    }
  }'
```

## Configuration

claude-a2a is configured via a YAML file. It looks for config in this order:

1. Path passed via `--config` / `-c` flag
2. `./config.yaml` in the current directory
3. `/etc/claude-a2a/config.yaml`

If no file is found, sensible defaults are used. Copy `config/example.yaml` to get started:

```bash
cp config/example.yaml config.yaml
```

### Environment variables

Secrets should be set via environment variables rather than in the config file:

| Variable | Purpose |
|---|---|
| `CLAUDE_A2A_MASTER_KEY` | Master authentication key (full access) |
| `CLAUDE_A2A_JWT_SECRET` | Secret for signing/verifying JWT tokens |
| `CLAUDE_A2A_PORT` | Override server port (default: 8462) |
| `CLAUDE_A2A_CONFIG` | Override config file path |
| `LOG_LEVEL` | Logging level: `debug`, `info`, `warn`, `error` (default: `info`) |

### Key config sections

**server** — Host, port, TLS, max concurrent Claude processes, request timeout.

**auth** — Master key and JWT settings. If neither is configured, the server allows unauthenticated access.

**rate_limiting** — Token-bucket rate limiter. Per-client, configurable requests per minute and burst.

**budgets** — Daily spending limits (global and per-client) to prevent runaway costs.

**sessions** — Max session lifetime, idle timeout, and per-client session limits.

**claude** — Path to the `claude` binary, default model, default permission mode, and working directory.

**agents** — The most important section. This is where you define your Agent Cards.

## Agent Cards

In the A2A protocol, an **Agent Card** is a JSON document that describes what an agent can do. It is served at a well-known URL (`/.well-known/agent-card.json`) so that other agents and tools can discover and understand the agent's capabilities before sending it messages.

claude-a2a automatically generates an Agent Card from the `agents` section of your config. Each entry in `agents` becomes a **skill** on the card.

### Defining agents

Each agent is a named configuration that controls how Claude behaves when it receives messages for that agent. Here is a full example:

```yaml
agents:
  general:
    description: "General-purpose Claude assistant"
    enabled: true
    model: null                  # null = use Claude's default model
    append_system_prompt: "You are responding via the claude-a2a A2A API. Be concise."
    settings_file: null          # path to a Claude settings file
    permission_mode: "default"   # Claude's permission mode
    allowed_tools:               # which tools Claude can use
      - "Read(*)"
      - "Glob(*)"
      - "Grep(*)"
      - "WebSearch(*)"
      - "WebFetch(*)"
    max_budget_usd: 1.0          # max spend per invocation
    required_scopes:             # JWT scopes needed to use this agent
      - "agent:general"
    work_dir: null               # working directory (null = use global default)
```

### Agent config fields

| Field | Description |
|---|---|
| `description` | Human-readable description. Appears in the Agent Card. |
| `enabled` | Set to `false` to disable an agent without removing its config. |
| `model` | Claude model to use (e.g. `claude-sonnet-4-6`). `null` uses the CLI default. |
| `append_system_prompt` | Extra instructions appended to Claude's system prompt for this agent. |
| `settings_file` | Path to a Claude Code settings JSON file (for advanced configuration). |
| `permission_mode` | Claude's permission mode: `default`, `plan`, `bypasstool`, etc. |
| `allowed_tools` | List of tools Claude is allowed to use. Uses glob patterns like `Read(*)`. |
| `max_budget_usd` | Maximum spend (in USD) per single invocation. |
| `required_scopes` | JWT scopes required to call this agent. Ignored for master key auth. |
| `work_dir` | Working directory for Claude. Determines what files Claude can see. |

### Example: multiple agents

```yaml
agents:
  general:
    description: "General-purpose assistant for questions and research"
    enabled: true
    allowed_tools:
      - "WebSearch(*)"
      - "WebFetch(*)"
    max_budget_usd: 0.50
    required_scopes: ["agent:general"]

  code:
    description: "Code assistant that can read, write, and run code"
    enabled: true
    model: "claude-sonnet-4-6"
    append_system_prompt: "You are a code assistant. Focus on writing clean, correct code."
    permission_mode: "default"
    allowed_tools:
      - "Read(*)"
      - "Write(*)"
      - "Edit(*)"
      - "Glob(*)"
      - "Grep(*)"
      - "Bash(*)"
    max_budget_usd: 5.0
    required_scopes: ["agent:code"]
    work_dir: "/home/projects/my-app"

  reviewer:
    description: "Code reviewer that reads code and provides feedback"
    enabled: true
    allowed_tools:
      - "Read(*)"
      - "Glob(*)"
      - "Grep(*)"
    max_budget_usd: 1.0
    required_scopes: ["agent:reviewer"]
    work_dir: "/home/projects/my-app"
```

Clients target a specific agent by including `"metadata": {"agent": "code"}` in their message. If no agent is specified, the first enabled agent is used.

### Viewing the Agent Card

Once the server is running, view the generated Agent Card:

```bash
curl http://localhost:8462/.well-known/agent-card.json
```

This returns the full A2A Agent Card JSON, including all enabled agents as skills, supported authentication schemes, and capability declarations.

## Authentication

claude-a2a supports three tiers of authentication:

### 1. Master key

A shared secret that grants full access. Set via the `CLAUDE_A2A_MASTER_KEY` environment variable. Pass it as a Bearer token:

```bash
curl -H "Authorization: Bearer my-secret-key" http://localhost:8462/admin/stats
```

Best for: trusted agents on the same network or VPN.

### 2. JWT tokens

Scoped tokens with per-client controls. Generate them using the CLI:

```bash
# Generate a token for "my-agent" with access to the "general" agent
CLAUDE_A2A_JWT_SECRET=your-jwt-secret \
  node dist/cli.js token my-agent agent:general

# Generate a token with access to all agents
CLAUDE_A2A_JWT_SECRET=your-jwt-secret \
  node dist/cli.js token my-agent '*'
```

JWT claims can include:
- `scopes` — which agents the token can access (e.g. `agent:general`, `agent:code`, or `*`)
- `budget_daily_usd` — per-client daily spending limit
- `rate_limit_rpm` — per-client rate limit override

### 3. No authentication

If neither `CLAUDE_A2A_MASTER_KEY` nor `CLAUDE_A2A_JWT_SECRET` is set, the server allows unauthenticated access. Only appropriate for local development.

## Session continuity

claude-a2a maintains session continuity across messages using A2A's `contextId`. When you send a first message, the response includes a `contextId`. Include that same `contextId` in subsequent messages to continue the conversation in the same Claude session:

```bash
# First message — note the contextId in the response
RESPONSE=$(curl -s -X POST http://localhost:8462/a2a/jsonrpc \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0", "id": "1",
    "method": "message/send",
    "params": {
      "message": {
        "kind": "message", "messageId": "m1", "role": "user",
        "parts": [{"kind": "text", "text": "Remember the number 42."}]
      },
      "configuration": {"blocking": true}
    }
  }')

# Extract contextId from response
CONTEXT_ID=$(echo "$RESPONSE" | jq -r '.result.contextId')

# Second message — same contextId, Claude remembers the conversation
curl -s -X POST http://localhost:8462/a2a/jsonrpc \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"jsonrpc\": \"2.0\", \"id\": \"2\",
    \"method\": \"message/send\",
    \"params\": {
      \"message\": {
        \"kind\": \"message\", \"messageId\": \"m2\", \"role\": \"user\",
        \"contextId\": \"$CONTEXT_ID\",
        \"parts\": [{\"kind\": \"text\", \"text\": \"What number did I say?\"}]
      },
      \"configuration\": {\"blocking\": true}
    }
  }"
```

Under the hood, claude-a2a maps `contextId` to a Claude CLI session ID and passes `--resume <session-id>` to maintain conversation state.

## MCP client (for interactive Claude Code sessions)

The included MCP client lets an interactive Claude Code session call remote claude-a2a servers as tools. This means a Claude agent on your laptop can ask a Claude agent on your server to do work.

### Setup

1. Create a client config file at `~/.claude-a2a/client.json`:

```json
{
  "servers": {
    "my-server": {
      "url": "http://192.168.1.80:8462",
      "token": "Bearer my-secret-key"
    }
  }
}
```

2. Add the MCP server to your Claude Code configuration. In `.claude/settings.json` or `.mcp.json`:

```json
{
  "mcpServers": {
    "claude-a2a": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/claude-a2a/dist/client.js"]
    }
  }
}
```

### Available MCP tools

Once connected, Claude Code gains these tools:

| Tool | Description |
|---|---|
| `list_remote_servers` | List configured remote servers |
| `list_remote_agents` | Fetch the Agent Card from a remote server |
| `send_message` | Send a message to a remote agent and get a response |
| `get_server_health` | Check server health and status |
| `list_sessions` | List active sessions (admin) |
| `delete_session` | Clean up a remote session (admin) |

## Admin API

Admin endpoints require master key authentication.

```bash
# Server stats
curl -H "Authorization: Bearer $MASTER_KEY" http://localhost:8462/admin/stats

# List active sessions
curl -H "Authorization: Bearer $MASTER_KEY" http://localhost:8462/admin/sessions

# Delete a session
curl -X DELETE -H "Authorization: Bearer $MASTER_KEY" \
  http://localhost:8462/admin/sessions/<session-id>

# Create a JWT token
curl -X POST -H "Authorization: Bearer $MASTER_KEY" \
  -H "Content-Type: application/json" \
  http://localhost:8462/admin/tokens \
  -d '{"sub": "my-client", "scopes": ["agent:general"]}'

# Revoke a token
curl -X DELETE -H "Authorization: Bearer $MASTER_KEY" \
  http://localhost:8462/admin/tokens/<token-jti>
```

## Production deployment

A systemd service file is included for production deployment:

```bash
# Build
npm run build

# Run the install script (creates user, directories, copies files)
sudo bash scripts/install.sh

# Configure
sudo vim /etc/claude-a2a/config.yaml
sudo vim /etc/claude-a2a/env    # set CLAUDE_A2A_MASTER_KEY, CLAUDE_A2A_JWT_SECRET

# Start
sudo systemctl enable --now claude-a2a

# Check status
sudo systemctl status claude-a2a
curl http://localhost:8462/health
```

The systemd service runs with security hardening (read-only filesystem, no new privileges, restricted syscalls).

## Development

```bash
# Run in dev mode (uses tsx, no build step)
CLAUDE_A2A_MASTER_KEY=dev-key npm run dev

# Run tests
npm test

# Run tests in watch mode
npm run test:watch

# Build
npm run build
```

## Project structure

```
claude-a2a/
  src/
    cli.ts                        # CLI entry point (serve, client, token)
    server/
      index.ts                    # Express server setup, wires everything together
      config.ts                   # YAML config loading + Zod validation
      agent-card.ts               # Generates A2A Agent Card from config
      claude-runner.ts            # Spawns and manages claude CLI subprocesses
      agent-executor.ts           # A2A AgentExecutor: bridges A2A protocol to Claude Runner
      auth/
        middleware.ts             # Express auth middleware (master key + JWT)
        tokens.ts                 # JWT creation, verification, revocation
      services/
        session-store.ts          # Tracks Claude sessions by context ID
        rate-limiter.ts           # Token-bucket rate limiter
        budget-tracker.ts         # Daily per-client and global cost tracking
      routes/
        admin.ts                  # Token CRUD, session management, stats
        health.ts                 # Health check endpoint
    client/
      index.ts                    # MCP client entry point
      mcp-server.ts               # MCP tool definitions
      a2a-client.ts               # HTTP client for remote A2A servers
      config.ts                   # Client config loading
  tests/                          # Vitest unit tests
  config/
    example.yaml                  # Example server configuration
  systemd/
    claude-a2a.service            # systemd unit file
  scripts/
    install.sh                    # Production install script
```

## Response metadata

Every response from claude-a2a includes Claude-specific metadata in `result.metadata.claude`:

```json
{
  "claude": {
    "agent": "general",
    "session_id": "7fcfc468-2111-4fc2-97ad-bcb4d91ce0c8",
    "context": null,
    "cost_usd": 0.014664,
    "duration_ms": 1932,
    "duration_api_ms": 1859,
    "permission_denials": [],
    "model_used": "claude-sonnet-4-6",
    "num_turns": 1,
    "usage": {
      "input_tokens": 3,
      "output_tokens": 5,
      "cache_creation_input_tokens": 816,
      "cache_read_input_tokens": 18848
    }
  }
}
```

This lets clients track costs, monitor token usage, detect permission issues, and manage session state.

## Built with

- [@a2a-js/sdk](https://github.com/a2aproject/a2a-js) — Official A2A TypeScript SDK (Google)
- [@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/typescript-sdk) — Official MCP TypeScript SDK (Anthropic)
- [Express 5](https://expressjs.com/) — HTTP framework
- [Zod](https://zod.dev/) — Config validation
- [pino](https://getpino.io/) — Structured logging
- [Vitest](https://vitest.dev/) — Testing
- [esbuild](https://esbuild.github.io/) — Build tool
