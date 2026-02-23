import { spawn, type ChildProcess } from "node:child_process";
import type { Logger } from "pino";
import { z } from "zod";
import type { AgentConfig, Config } from "./config.js";
import { TimeoutError, type ClaudeResponse } from "./claude-runner.js";

// ---------------------------------------------------------------------------
// Stream-JSON schemas (loose parsing for forward compatibility)
// ---------------------------------------------------------------------------

export const StreamSystemInitSchema = z.object({
  type: z.literal("system"),
  subtype: z.literal("init"),
  session_id: z.string(),
  model: z.string(),
  tools: z.array(z.string()).default([]),
  cwd: z.string().optional(),
  permissionMode: z.string().optional(),
}).passthrough();

export const StreamResultSchema = z.object({
  type: z.literal("result"),
  subtype: z.string(), // "success" | "error_max_turns" | "error_during_execution" | etc.
  session_id: z.string(),
  is_error: z.boolean(),
  duration_ms: z.number(),
  duration_api_ms: z.number(),
  num_turns: z.number(),
  result: z.string().optional().default(""),
  total_cost_usd: z.number(),
  usage: z.object({
    input_tokens: z.number().default(0),
    output_tokens: z.number().default(0),
    cache_creation_input_tokens: z.number().default(0),
    cache_read_input_tokens: z.number().default(0),
  }).passthrough(),
  permission_denials: z.array(z.unknown()).default([]),
  stop_reason: z.string().nullable().optional(),
}).passthrough();

/** Minimal discriminator for dispatching NDJSON lines by type. */
const StreamLineTypeSchema = z.object({
  type: z.string(),
}).passthrough();

// ---------------------------------------------------------------------------
// Content block types (Claude CLI stream-json stdin format)
// ---------------------------------------------------------------------------

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } }
  | { type: "document"; source: { type: "base64"; media_type: string; data: string } };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SessionState = "initializing" | "idle" | "processing" | "dead";

export interface ClaudeSessionOptions {
  agentName: string;
  agentConfig: AgentConfig;
  config: Config;
  log: Logger;
  resumeSessionId?: string;
}

// ---------------------------------------------------------------------------
// ClaudeSession
// ---------------------------------------------------------------------------

export class ClaudeSession {
  /** Claude's session ID (available after init message). */
  claudeSessionId: string | null = null;

  private proc: ChildProcess;
  private _state: SessionState = "initializing";
  private lineBuffer = "";
  private modelUsed = "unknown";
  private readonly log: Logger;
  private readonly maxBufferBytes: number;

  // Per-message promise plumbing
  private pendingResolve: ((response: ClaudeResponse) => void) | null = null;
  private pendingReject: ((error: Error) => void) | null = null;
  private messageTimeout: ReturnType<typeof setTimeout> | null = null;

  // Init wait plumbing
  private initResolve: (() => void) | null = null;
  private initReject: ((error: Error) => void) | null = null;

  // Stderr capture for diagnostics
  private stderrChunks: string[] = [];

  /** Called when the process dies unexpectedly. Set by the owner (ClaudeRunner). */
  onDeath: ((error: Error) => void) | null = null;

  /** Timestamp of last message send or result receive. */
  lastActivityAt = Date.now();

  constructor(options: ClaudeSessionOptions) {
    this.log = options.log.child({
      component: "claude-session",
      agent: options.agentName,
    });
    this.maxBufferBytes = options.config.claude.max_stdout_buffer_mb * 1024 * 1024;

    const args = buildArgs(options);
    const env = { ...process.env };
    delete env["CLAUDECODE"];

    const workDir =
      options.agentConfig.work_dir ?? options.config.claude.work_dir ?? process.cwd();

    this.proc = spawn(options.config.claude.binary, args, {
      env,
      cwd: workDir,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });

    this.proc.stdout!.on("data", (chunk: Buffer) => this.handleStdoutData(chunk));
    this.stderrChunks = [];
    this.proc.stderr!.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      this.stderrChunks.push(text);
      this.log.warn({ stderr: text.slice(0, 500) }, "claude stderr");
    });

    this.proc.on("error", (err) => {
      this.log.error({ err }, "claude process spawn error");
      this._state = "dead";
      this.rejectPending(new ClaudeSessionError(`Failed to spawn claude: ${err.message}`));
      this.resolveInitError(new ClaudeSessionError(`Failed to spawn claude: ${err.message}`));
      this.onDeath?.(err);
    });

    this.proc.on("close", (code) => {
      if (this._state === "dead") return; // already handled
      this.log.info({ code }, "claude process exited");
      this._state = "dead";
      const err = new ClaudeSessionError(`Claude process exited with code ${code}`);
      this.rejectPending(err);
      this.resolveInitError(err);
      this.onDeath?.(err);
    });
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  get state(): SessionState {
    return this._state;
  }

  get isAlive(): boolean {
    return this._state !== "dead";
  }

  get isIdle(): boolean {
    return this._state === "idle";
  }

  /** PID of the underlying Claude process. */
  get pid(): number | undefined {
    return this.proc.pid;
  }

  /**
   * Wait for the session to finish initializing (system init message received).
   * Note: Claude CLI in stream-json mode only emits the init message after
   * receiving stdin input, so this will not resolve until a message is sent.
   */
  async waitForInit(timeoutMs = 30_000): Promise<void> {
    if (this._state !== "initializing") return;
    return new Promise<void>((resolve, reject) => {
      this.initResolve = resolve;
      this.initReject = reject;
      setTimeout(() => {
        if (this._state === "initializing") {
          this._state = "dead";
          this.proc.kill("SIGTERM");
          reject(new ClaudeSessionError("Session initialization timed out"));
        }
      }, timeoutMs);
    });
  }

  /**
   * Send a user message and wait for the result.
   * The session must be idle. Throws SessionBusyError if processing.
   *
   * Note: Claude CLI in stream-json mode does not emit the system init
   * message until it receives input on stdin. When the session is still
   * initializing we write the message immediately — the init message
   * always arrives on stdout before the result, so processLine() will
   * set claudeSessionId and transition state correctly in sequence.
   */
  async sendMessage(message: string | ContentBlock[], timeoutMs: number): Promise<ClaudeResponse> {
    if (this._state === "dead") {
      throw new ClaudeSessionError("Session process is dead");
    }
    if (this._state === "processing") {
      throw new SessionBusyError("Session is currently processing another message");
    }

    this.lastActivityAt = Date.now();

    return new Promise<ClaudeResponse>((resolve, reject) => {
      this.pendingResolve = resolve;
      this.pendingReject = reject;
      this._state = "processing";

      this.messageTimeout = setTimeout(() => {
        this.messageTimeout = null;
        // Do NOT kill the process — just stop waiting.
        // The result will arrive eventually and be silently consumed.
        this._state = "idle";
        const savedReject = this.pendingReject;
        this.pendingResolve = null;
        this.pendingReject = null;
        savedReject?.(new TimeoutError(`Message timed out after ${timeoutMs / 1000}s`));
      }, timeoutMs);

      this.writeMessage(message);
    });
  }

  /** Kill the process gracefully. */
  destroy(): void {
    if (this._state === "dead") return;
    this._state = "dead";
    this.clearTimeout();
    this.rejectPending(new ClaudeSessionError("Session destroyed"));
    this.resolveInitError(new ClaudeSessionError("Session destroyed"));
    if (!this.proc.killed) {
      this.proc.kill("SIGTERM");
      setTimeout(() => {
        if (!this.proc.killed) this.proc.kill("SIGKILL");
      }, 5000);
    }
  }

  /**
   * Release the process without killing it. The process continues running
   * independently after the server exits. Used during graceful shutdown so
   * Claude can finish its current work. On restart, `--resume` recovers the
   * conversation including any results the orphaned process completed.
   */
  release(): void {
    if (this._state === "dead") return;
    this._state = "dead";
    this.clearTimeout();
    this.rejectPending(new ClaudeSessionError("Session released (server shutting down)"));
    this.resolveInitError(new ClaudeSessionError("Session released (server shutting down)"));

    // Prevent runner's death handler from firing during teardown
    this.onDeath = null;

    // Remove all listeners so events from the orphaned process don't fire
    this.proc.stdout!.removeAllListeners();
    this.proc.stderr!.removeAllListeners();
    this.proc.removeAllListeners();

    // Graceful EOF — tells Claude "no more input"
    this.proc.stdin!.end();

    // Unref so Node.js can exit even though the child is still running
    this.proc.unref();
    this.proc.stdout!.destroy();
    this.proc.stderr!.destroy();
  }

  // -------------------------------------------------------------------------
  // NDJSON parsing
  // -------------------------------------------------------------------------

  private handleStdoutData(chunk: Buffer): void {
    this.lineBuffer += chunk.toString();

    if (this.lineBuffer.length > this.maxBufferBytes) {
      this.log.error(
        { bytes: this.lineBuffer.length, limit: this.maxBufferBytes },
        "stdout buffer exceeded limit — destroying session",
      );
      this.destroy();
      return;
    }

    let newlineIndex: number;
    while ((newlineIndex = this.lineBuffer.indexOf("\n")) !== -1) {
      const line = this.lineBuffer.slice(0, newlineIndex).trim();
      this.lineBuffer = this.lineBuffer.slice(newlineIndex + 1);
      if (line.length > 0) {
        this.processLine(line);
      }
    }
  }

  private processLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.log.warn({ line: line.slice(0, 200) }, "unparseable NDJSON line from claude");
      return;
    }

    const base = StreamLineTypeSchema.safeParse(parsed);
    if (!base.success) return;

    const type = base.data.type;

    if (type === "system") {
      const init = StreamSystemInitSchema.safeParse(parsed);
      if (init.success && init.data.subtype === "init") {
        this.claudeSessionId = init.data.session_id;
        this.modelUsed = init.data.model;
        this._state = "idle";
        this.log.info(
          { sessionId: this.claudeSessionId, model: this.modelUsed },
          "claude session initialized",
        );
        // Resolve init waiters
        this.initResolve?.();
        this.initResolve = null;
        this.initReject = null;
      }
    } else if (type === "result") {
      const result = StreamResultSchema.safeParse(parsed);
      if (result.success) {
        this.lastActivityAt = Date.now();
        const response = streamResultToClaudeResponse(result.data, this.modelUsed);
        this.clearTimeout();
        this._state = "idle";

        if (this.pendingResolve) {
          const savedResolve = this.pendingResolve;
          this.pendingResolve = null;
          this.pendingReject = null;
          savedResolve(response);
        } else {
          // Result arrived after timeout — silently consume
          this.log.debug("result arrived after timeout, silently consumed");
        }
      } else {
        this.log.warn({ errors: result.error.issues }, "failed to parse stream result");
      }
    }
    // assistant, user, rate_limit_event, stream_event: debug-level noise
    else if (type !== "assistant" && type !== "user" && type !== "rate_limit_event") {
      this.log.debug({ type }, "unhandled NDJSON message type");
    }
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private writeMessage(message: string | ContentBlock[]): void {
    const msg = JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: message,
      },
    });
    this.proc.stdin!.write(msg + "\n");
  }

  private clearTimeout(): void {
    if (this.messageTimeout) {
      clearTimeout(this.messageTimeout);
      this.messageTimeout = null;
    }
  }

  private rejectPending(error: Error): void {
    this.clearTimeout();
    if (this.pendingReject) {
      const savedReject = this.pendingReject;
      this.pendingResolve = null;
      this.pendingReject = null;
      savedReject(error);
    }
  }

  private resolveInitError(error: Error): void {
    if (this.initReject) {
      const savedReject = this.initReject;
      this.initResolve = null;
      this.initReject = null;
      savedReject(error);
    }
  }
}

// ---------------------------------------------------------------------------
// Mapping stream result → ClaudeResponse
// ---------------------------------------------------------------------------

type StreamResult = z.infer<typeof StreamResultSchema>;

function streamResultToClaudeResponse(result: StreamResult, modelUsed: string): ClaudeResponse {
  return {
    result: result.result ?? "",
    session_id: result.session_id,
    is_error: result.is_error,
    duration_ms: result.duration_ms,
    duration_api_ms: result.duration_api_ms,
    num_turns: result.num_turns,
    total_cost_usd: result.total_cost_usd,
    usage: {
      input_tokens: result.usage.input_tokens,
      output_tokens: result.usage.output_tokens,
      cache_creation_input_tokens: result.usage.cache_creation_input_tokens,
      cache_read_input_tokens: result.usage.cache_read_input_tokens,
    },
    model_used: modelUsed,
    permission_denials: result.permission_denials
      .map((d) => (typeof d === "string" ? d : (d as Record<string, unknown>)?.["tool_name"] as string ?? ""))
      .filter(Boolean),
  };
}

// ---------------------------------------------------------------------------
// Build CLI args for stream-json mode
// ---------------------------------------------------------------------------

function buildArgs(options: ClaudeSessionOptions): string[] {
  const { agentConfig, config, resumeSessionId } = options;
  const args = ["-p", "--verbose", "--input-format", "stream-json", "--output-format", "stream-json"];

  if (resumeSessionId) {
    args.push("--resume", resumeSessionId);
  }

  const model = agentConfig.model ?? config.claude.default_model;
  if (model) {
    args.push("--model", model);
  }

  if (agentConfig.settings_file) {
    args.push("--settings", agentConfig.settings_file);
  }

  const permMode =
    agentConfig.permission_mode ?? config.claude.default_permission_mode;
  if (permMode) {
    args.push("--permission-mode", permMode);
  }

  if (agentConfig.allowed_tools.length > 0) {
    args.push("--allowedTools", ...agentConfig.allowed_tools);
  }

  if (agentConfig.max_budget_usd) {
    args.push("--max-budget-usd", agentConfig.max_budget_usd.toString());
  }

  if (agentConfig.append_system_prompt) {
    args.push("--append-system-prompt", agentConfig.append_system_prompt);
  }

  return args;
}

// ---------------------------------------------------------------------------
// Error classes
// ---------------------------------------------------------------------------

export class ClaudeSessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClaudeSessionError";
  }
}

export class SessionBusyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionBusyError";
  }
}

export { TimeoutError };
