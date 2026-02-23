# CLAUDE.md

## Project

claude-a2a is an A2A-compatible server wrapping the Claude CLI for agent-to-agent communication. Supports multimodal input (images, PDFs via A2A `FilePart`), multi-agent configurations, tenant isolation, and session continuity across restarts. TypeScript/Node.js with Express, Zod, and pino.

## Build & Test

```bash
npm run build          # esbuild → dist/cli.js, dist/client.js
npm run dev            # run server with tsx
npm test               # vitest run
npm run lint           # eslint src/
```

## Architecture Decisions

All architectural and design decisions with rationale are documented in [DECISION_LOG.md](./DECISION_LOG.md). Read it before making changes to understand existing trade-offs.

## Key Components

- **`ClaudeSession`** (`claude-session.ts`) — wraps a long-lived Claude CLI process with NDJSON I/O. Defines the `ContentBlock` type for multimodal input.
- **`ClaudeRunner`** (`claude-runner.ts`) — session pool manager. `RunOptions.message` accepts `string | ContentBlock[]`.
- **`ClaudeAgentExecutor`** (`agent-executor.ts`) — A2A executor. `convertPartsToMessage()` maps A2A `Part[]` to Claude content format.
- **`SqliteTaskStore`** (`services/task-store.ts`) — A2A task persistence with tenant isolation via `client_name` ownership.
- **`SessionStore`** (`services/session-store.ts`) — in-memory + SQLite session metadata for restart recovery.
- **`BudgetTracker`** (`services/budget-tracker.ts`) — per-client daily spend tracking with JWT-overridable limits.
- **`AppDatabase`** (`services/database.ts`) — SQLite connection with forward-only migrations (currently v3).

## Conventions

- **Config validation**: All configuration (server and client) uses Zod schemas with sensible defaults. Never use `as Type` casts on parsed config.
- **Auth**: JWT algorithms are restricted to `HS256 | HS384 | HS512` via Zod enum. Never accept arbitrary algorithm strings.
- **Error responses**: Auth error details (JWT failure reasons) are only included in responses when `auth.jwt.debug: true`. Default is off.
- **Testing**: Use `supertest` for HTTP-level tests against Express apps. Use `vitest` with `pino({ level: "silent" })` for unit tests. All stores use `:memory:` SQLite databases.
- **Naming**: camelCase in TypeScript, snake_case in config YAML and JSON API payloads.
- **Multimodal input**: A2A `Part[]` is converted via `convertPartsToMessage()` in `agent-executor.ts`. Text-only messages stay as plain strings for backward compatibility. Non-text parts produce a `ContentBlock[]` array. Never silently drop message parts — unsupported types should be converted to text descriptions.
- **Tenant isolation**: All task operations go through `SqliteTaskStore.load()` which enforces ownership. Internal server calls pass no context (trusted). Never bypass the store's ownership check.
