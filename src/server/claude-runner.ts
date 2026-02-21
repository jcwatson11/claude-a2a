import { spawn } from "node:child_process";
import type { Logger } from "pino";
import type { AgentConfig, Config } from "./config.js";

export interface ClaudeResponse {
  result: string;
  session_id: string;
  is_error: boolean;
  duration_ms: number;
  duration_api_ms: number;
  num_turns: number;
  total_cost_usd: number;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
  };
  model_used: string;
  permission_denials: string[];
  context?: {
    used_tokens: number;
    max_tokens: number;
    remaining_tokens: number;
    compact_recommended: boolean;
  };
}

export interface RunOptions {
  agentName: string;
  agentConfig: AgentConfig;
  message: string;
  sessionId?: string;
}

export class ClaudeRunner {
  private activeCount = 0;
  private readonly maxConcurrent: number;
  private readonly requestTimeout: number;
  private readonly config: Config;
  private readonly log: Logger;

  constructor(config: Config, log: Logger) {
    this.config = config;
    this.maxConcurrent = config.server.max_concurrent;
    this.requestTimeout = config.server.request_timeout;
    this.log = log.child({ component: "claude-runner" });
  }

  get concurrentCount(): number {
    return this.activeCount;
  }

  get isFull(): boolean {
    return this.activeCount >= this.maxConcurrent;
  }

  async run(options: RunOptions): Promise<ClaudeResponse> {
    if (this.isFull) {
      throw new CapacityError(
        `At capacity (${this.activeCount}/${this.maxConcurrent})`,
      );
    }

    this.activeCount++;
    try {
      return await this.executeProcess(options);
    } finally {
      this.activeCount--;
    }
  }

  private async executeProcess(options: RunOptions): Promise<ClaudeResponse> {
    const { agentConfig, message, sessionId } = options;
    const args = this.buildArgs(agentConfig, sessionId);

    this.log.info(
      {
        agent: options.agentName,
        sessionId,
        concurrent: this.activeCount,
      },
      "spawning claude process",
    );

    return new Promise<ClaudeResponse>((resolve, reject) => {
      const env = { ...process.env };
      // Unset CLAUDECODE to avoid "nested session" error
      delete env["CLAUDECODE"];

      const workDir =
        agentConfig.work_dir ?? this.config.claude.work_dir;

      const proc = spawn(this.config.claude.binary, args, {
        env,
        cwd: workDir,
        stdio: ["pipe", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";

      proc.stdout.on("data", (data: Buffer) => {
        stdout += data.toString();
      });
      proc.stderr.on("data", (data: Buffer) => {
        stderr += data.toString();
      });

      const timeout = setTimeout(() => {
        proc.kill("SIGTERM");
        setTimeout(() => {
          if (!proc.killed) proc.kill("SIGKILL");
        }, 5000);
        reject(new TimeoutError(`Claude process timed out after ${this.requestTimeout}s`));
      }, this.requestTimeout * 1000);

      proc.on("error", (err) => {
        clearTimeout(timeout);
        reject(new ClaudeProcessError(`Failed to spawn claude: ${err.message}`, stderr));
      });

      proc.on("close", (code) => {
        clearTimeout(timeout);

        if (code !== 0) {
          this.log.warn({ code, stderr: stderr.slice(0, 500) }, "claude process exited with error");
          reject(new ClaudeProcessError(`Claude exited with code ${code}`, stderr));
          return;
        }

        try {
          const parsed = JSON.parse(stdout) as Record<string, unknown>;
          const response = mapResponse(parsed);
          this.log.info(
            {
              agent: options.agentName,
              sessionId: response.session_id,
              cost: response.total_cost_usd,
              duration: response.duration_ms,
            },
            "claude process completed",
          );
          resolve(response);
        } catch (err) {
          reject(
            new ClaudeProcessError(
              `Failed to parse claude output: ${err instanceof Error ? err.message : String(err)}`,
              stdout.slice(0, 1000),
            ),
          );
        }
      });

      // Write the message to stdin
      proc.stdin.write(message);
      proc.stdin.end();
    });
  }

  private buildArgs(agentConfig: AgentConfig, sessionId?: string): string[] {
    const args = ["-p", "--output-format", "json"];

    if (sessionId) {
      args.push("--resume", sessionId);
    }

    const model = agentConfig.model ?? this.config.claude.default_model;
    if (model) {
      args.push("--model", model);
    }

    if (agentConfig.settings_file) {
      args.push("--settings", agentConfig.settings_file);
    }

    const permMode =
      agentConfig.permission_mode ?? this.config.claude.default_permission_mode;
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
}

function mapResponse(raw: Record<string, unknown>): ClaudeResponse {
  const usage = raw["usage"] as Record<string, number> | undefined;
  const context = raw["context"] as Record<string, unknown> | undefined;
  const permDenials = raw["permission_denials"] as string[] | undefined;

  return {
    result: String(raw["result"] ?? ""),
    session_id: String(raw["session_id"] ?? ""),
    is_error: Boolean(raw["is_error"]),
    duration_ms: Number(raw["duration_ms"] ?? 0),
    duration_api_ms: Number(raw["duration_api_ms"] ?? 0),
    num_turns: Number(raw["num_turns"] ?? 1),
    total_cost_usd: Number(raw["total_cost_usd"] ?? 0),
    usage: {
      input_tokens: Number(usage?.["input_tokens"] ?? 0),
      output_tokens: Number(usage?.["output_tokens"] ?? 0),
      cache_creation_input_tokens: Number(usage?.["cache_creation_input_tokens"] ?? 0),
      cache_read_input_tokens: Number(usage?.["cache_read_input_tokens"] ?? 0),
    },
    model_used: String(raw["model_used"] ?? "unknown"),
    permission_denials: permDenials ?? [],
    context: context
      ? {
          used_tokens: Number(context["used_tokens"] ?? 0),
          max_tokens: Number(context["max_tokens"] ?? 0),
          remaining_tokens: Number(context["remaining_tokens"] ?? 0),
          compact_recommended: Boolean(context["compact_recommended"]),
        }
      : undefined,
  };
}

export class CapacityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CapacityError";
  }
}

export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimeoutError";
  }
}

export class ClaudeProcessError extends Error {
  readonly stderr: string;
  constructor(message: string, stderr: string) {
    super(message);
    this.name = "ClaudeProcessError";
    this.stderr = stderr;
  }
}
