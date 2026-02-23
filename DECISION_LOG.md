# Decision Log

Architectural and design decisions for the claude-a2a project, with rationale. Referenced from [CLAUDE.md](./CLAUDE.md).

---

## Module-level state in token revocation store (tokens.ts)

The revocation store uses module-level `let` variables (`revokedTokens`, `persistPath`, `loaded`) as a singleton rather than a class instance with dependency injection. This is intentional:

- The server runs as a single systemd process — there is no multi-instance scenario.
- Test isolation is handled via `_resetRevocationStore()` in `beforeEach`/`afterEach`.
- The stateless token functions (`createToken`, `verifyToken`) stay clean — no store instance threading.

This is a pragmatic trade-off. Revisit if the project needs multi-tenant or in-process multi-instance support.

---

## Long-lived Claude sessions via stream-json protocol

Claude processes are long-lived — one process per session (contextId), not per request. The process stays alive across multiple messages using the Claude CLI's stream-json protocol (`-p --verbose --input-format stream-json --output-format stream-json`). This enables:

- Background processes spawned by Claude survive between messages.
- The client agent interacts with a peer-level agent on the server.
- Lower latency on subsequent messages (no process spawn overhead).

**Key classes:**
- `ClaudeSession` (`claude-session.ts`) — wraps a single long-lived process with NDJSON I/O and a state machine (`initializing → idle ⇄ processing → dead`).
- `ClaudeRunner` (`claude-runner.ts`) — session pool manager mapping `contextId → ClaudeSession`.

**Timeout behavior:** Per-message timeouts do NOT kill the process. The server stops waiting, but the process continues running. When the result eventually arrives, it is silently consumed and the session returns to idle. This preserves background processes.

**Capacity:** `max_concurrent` means max concurrent Claude processes (sessions). Idle sessions still count. Process idle timeout (`sessions.process_idle_timeout_minutes`) reaps idle sessions.

---

## Process lifecycle and survivability

All Claude processes are spawned with `detached: true`. This is required because when the server process exits, child processes that write to their stdout pipe receive SIGPIPE and die. Detached processes in their own process group survive the parent's exit — confirmed via POC testing (`poc-nohup.mjs`, since removed).

Two methods exist for ending a session:
- `destroy()` — sends SIGTERM → SIGKILL. Used for explicit cancellation (admin, `cancelTask()`, idle timeout eviction).
- `release()` — closes stdin (EOF), unrefs process and streams. Does NOT signal the process. Used during graceful shutdown so Claude can finish its current work.

**Graceful shutdown sequence** (in `index.ts`):
1. `runner.releaseAll(taskStore)` — updates in-flight tasks to "working" status with a restart message, then releases all sessions
2. `sessionStore.markAllProcessesDead()` — bulk-updates SQLite so restart recovery knows all processes may be orphaned
3. Stop timers, close database, close HTTP server

On restart, `--resume` picks up the conversation including any results the orphaned process completed while the server was down. Claude persists conversation state progressively, so even if the orphaned process eventually dies from SIGPIPE on stdout, the work up to that point is recoverable.

---

## Orphan detection — client decides

After restart, if a client sends a message to a contextId whose previous process is still running (detected via persisted PID + `kill(pid, 0)`), the server responds with an informative message instead of spawning a new process. The client can then `cancelTask()` to kill the orphan, or wait for it to finish naturally and retry.

The server never silently kills an orphaned process — the client always decides. This is consistent with the no-server-side-retry philosophy: the client has better context about whether in-progress work should be preserved or discarded.

---

## SQLite unified persistence layer

All persistent state is stored in a single SQLite database (`${data_dir}/claude-a2a.db`) using `better-sqlite3`. This replaces the earlier ad-hoc JSON file persistence and provides ACID transactions for data integrity.

**Tables:** `budget_records`, `revoked_tokens`, `sessions`, `tasks`, `migrations`.

**Design:**
- `AppDatabase` class (`services/database.ts`) manages the connection and runs forward-only migrations.
- Budget tracking writes immediately (no debounce) — SQLite is fast enough.
- Token revocation uses an in-memory `Set` as a read cache for O(1) checks on every request, backed by SQLite for persistence.
- Session metadata is dual-stored: in-memory Maps for fast lookups, SQLite for restart recovery. On restart, sessions load with `processAlive = false`.
- A2A task state (`SqliteTaskStore`) implements the SDK's `TaskStore` interface. Complex fields (artifacts, history) are JSON-serialized.
- Legacy JSON files (`budget.json`, `revoked-tokens.json`) are auto-migrated to SQLite on first startup and renamed to `.migrated`.

**Testing:** All stores use `:memory:` SQLite databases for test isolation.

---

## No server-side retry for Claude process failures

The server does not retry failed Claude CLI invocations. This is intentional:

- Each invocation costs money — silent retries risk doubling costs unexpectedly.
- The upstream A2A client has better context (urgency, budget, whether the failure is transient) to decide whether to retry.
- The A2A protocol supports task status reporting, so callers can observe failures and retry at their discretion.

Retry logic belongs at the caller level, not the server level.

---

## Stdout buffer limit (`claude.max_stdout_buffer_mb`)

Claude's NDJSON output is accumulated in a line buffer until a newline arrives. If a bug or malformed output produces data without newlines, the buffer could grow unbounded. The `max_stdout_buffer_mb` config (default 10MB) is a safety valve — if the buffer exceeds it, the session is destroyed. This is configurable rather than a hardcoded constant because legitimate large responses (e.g., base64 artifacts) may need a higher limit.

---

## Observability decisions

- **No periodic runtime health check for Claude binary.** The startup check (`checkClaudeBinary`) catches misconfiguration. The binary disappearing at runtime is rare, and `sendMessage` already fails with a clear error when it happens.
- **No request ID propagation to executor/runner logs.** The HTTP request logging middleware logs `requestId` with every response. Executor logs include `taskId` and `contextId`, which are sufficient for correlation. Threading `requestId` through the SDK abstraction layer would add complexity for marginal debugging value.
- **No Prometheus/metrics endpoint.** The health endpoint, request logging middleware, and budget stats API cover current monitoring needs. Revisit when there's an actual monitoring stack to consume metrics.
- **Budget cost recording logs at `info` level.** Cost is important operational data that should be visible in production logs without enabling debug.

---

## JWT token expiry

Default token expiry is 168 hours (7 days). Tokens can be refreshed up to `refresh_max_expiry_hours` (default 720 hours / 30 days). The example config previously showed 720h as the default expiry, which was incorrect — that value is the refresh ceiling.

---

## Data directory (`data_dir`)

All persistent data lives under `data_dir` (default: `/var/lib/claude-a2a`) in a SQLite database (`claude-a2a.db`). The Claude `work_dir` defaults to `${data_dir}/workdir` if not explicitly set. No data paths should be hardcoded — they must all derive from `data_dir` or be explicitly configured. Override via `CLAUDE_A2A_DATA_DIR` env var. Docker deployments should mount a volume at `data_dir`.

---

## Agent-context binding (multi-agent security)

A `contextId` is permanently bound to the agent it was created with. If a client tries to reuse a contextId with a different agent, the server rejects the request with an error message. This prevents a client from bypassing an agent's permission, tool, and model configuration by switching agents mid-session. This is a security concern in multi-tenant deployments where different agents have different trust levels.

---

## Tenant isolation on task operations

The A2A SDK passes `ServerCallContext` (containing the authenticated `User`) to `TaskStore.load()` and `TaskStore.save()`. The `SqliteTaskStore` enforces per-client ownership:

- **`save()`** stores the authenticated user's `clientName` as the task owner on creation. The owner is immutable — updates (UPSERT conflict) do not overwrite it.
- **`load()`** checks ownership before returning a task:
  - No context (internal server call, e.g., `releaseAll`) → allow (trusted)
  - Master key auth → allow (admin access to all tasks)
  - Authenticated user whose `clientName` matches the task owner → allow
  - Legacy tasks with no owner (pre-migration data) → allow
  - Otherwise → return `undefined` (SDK throws "task not found")

This gates both `tasks/get` and `tasks/cancel` since both call `load()` first. Without this, any authenticated client could read or cancel any other client's tasks.

---

## Per-client budget limits from JWT

JWT tokens can carry a `budget_daily_usd` claim that overrides the server's `default_client_daily_limit_usd` for that client. The executor extracts this from the authenticated user's auth context and passes it to `BudgetTracker.check()`. This allows issuing tokens with different spending limits per client without changing server config.

---

## Integration testing strategy

Full end-to-end integration tests (standing up the real HTTP server with middleware ordering) were skipped in favor of focused unit tests per component: auth middleware, rate limiter, admin routes (via supertest), agent executor, session/budget stores. The individual tests cover the behavior; remaining end-to-end validation happens with actual use. Revisit if middleware ordering bugs surface in practice.

---

## Health endpoint visibility

The `GET /health` endpoint is unauthenticated by design (standard for health checks and load balancer probes). It exposes `active_sessions` and `total_sessions` counts, which is minor operational information. This was noted during the endpoint auth audit but accepted as standard practice. Revisit if session counts become sensitive in a multi-tenant deployment.

---

## Agent card endpoint visibility

The agent card endpoints (`/.well-known/agent-card.json`, `/.well-known/agent.json`) are unauthenticated by design per the A2A protocol — agent cards are meant for discovery. The SDK's `getAuthenticatedExtendedCard` method does check authentication for extended capabilities.

---

## Multimodal input support (FilePart/DataPart → Claude CLI)

The A2A protocol supports three message part types: `TextPart`, `FilePart` (base64 or URI), and `DataPart` (JSON). The Claude CLI in stream-json mode accepts multimodal content blocks on stdin (images, documents). The server bridges these:

- `TextPart` → `{ type: "text" }` content block
- `FilePart` with base64 bytes + image MIME → `{ type: "image", source: { type: "base64" } }`
- `FilePart` with base64 bytes + other MIME → `{ type: "document", source: { type: "base64" } }`
- `FilePart` with URI → text description (URI download not implemented)
- `DataPart` → `{ type: "text" }` with pretty-printed JSON

**Backward compatibility:** When all parts are text, the message is sent as a plain string (unchanged from before). Content blocks array is only used when non-text parts are present.

**Output is text-only.** Claude's `result` field is always a string. The agent card advertises `defaultOutputModes: ["text"]`.

**Body size limit** was increased from 100KB to 10MB default to accommodate base64-encoded files. A 1MB image is ~1.3MB in base64.

**URI file download** is explicitly out of scope. URI-based `FilePart` values are converted to descriptive text blocks so nothing is silently dropped. Revisit if clients need server-side file fetching.
