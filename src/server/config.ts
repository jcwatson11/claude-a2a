import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

const AgentConfigSchema = z.object({
  description: z.string().default("General-purpose Claude assistant"),
  enabled: z.boolean().default(true),
  model: z.string().nullable().default(null),
  append_system_prompt: z
    .string()
    .nullable()
    .default(
      "You are responding via the claude-a2a A2A API. Be concise.",
    ),
  settings_file: z.string().nullable().default(null),
  permission_mode: z.string().default("default"),
  allowed_tools: z.array(z.string()).default([]),
  max_budget_usd: z.number().positive().default(1.0),
  required_scopes: z.array(z.string()).default([]),
  work_dir: z.string().nullable().default(null),
});

const ConfigSchema = z.object({
  server: z
    .object({
      host: z.string().default("0.0.0.0"),
      port: z.number().int().min(1).max(65535).default(8462),
      max_concurrent: z.number().int().positive().default(4),
      request_timeout: z.number().positive().default(300),
      max_body_size: z.string().default("10mb"),
    })
    .default({}),
  auth: z
    .object({
      master_key: z.string().nullable().default(null),
      jwt: z
        .object({
          secret: z.string().nullable().default(null),
          algorithm: z.enum(["HS256", "HS384", "HS512"]).default("HS256"),
          default_expiry_hours: z.number().positive().default(168),
          refresh_enabled: z.boolean().default(false),
          refresh_max_expiry_hours: z.number().positive().default(720),
          debug: z.boolean().default(false),
        })
        .default({}),
    })
    .default({}),
  sessions: z
    .object({
      max_lifetime_hours: z.number().positive().default(168),
      max_idle_hours: z.number().positive().default(24),
      max_per_client: z.number().int().positive().default(50),
      process_idle_timeout_minutes: z.number().positive().default(30),
    })
    .default({}),
  rate_limiting: z
    .object({
      enabled: z.boolean().default(true),
      requests_per_minute: z.number().positive().default(30),
      burst: z.number().int().positive().default(5),
    })
    .default({}),
  budgets: z
    .object({
      global_daily_limit_usd: z.number().positive().default(100.0),
      default_client_daily_limit_usd: z.number().positive().default(25.0),
    })
    .default({}),
  data_dir: z.string().default("/var/lib/claude-a2a"),
  claude: z
    .object({
      binary: z.string().default("claude"),
      default_model: z.string().nullable().default(null),
      default_permission_mode: z.string().default("default"),
      max_stdout_buffer_mb: z.number().positive().default(10),
      work_dir: z.string().nullable().default(null),
    })
    .default({}),
  agents: z.record(z.string(), AgentConfigSchema).default({
    general: AgentConfigSchema.parse({}),
  }),
});

export type Config = z.infer<typeof ConfigSchema>;
export type AgentConfig = z.infer<typeof AgentConfigSchema>;

export function applyEnvOverrides(raw: Record<string, unknown>): void {
  if (process.env["CLAUDE_A2A_MASTER_KEY"]) {
    raw["auth"] = {
      ...(raw["auth"] as Record<string, unknown> | undefined),
      master_key: process.env["CLAUDE_A2A_MASTER_KEY"],
    };
  }
  if (process.env["CLAUDE_A2A_JWT_SECRET"]) {
    const existingAuth = (raw["auth"] as Record<string, unknown>) ?? {};
    raw["auth"] = {
      ...existingAuth,
      jwt: {
        ...(existingAuth["jwt"] as Record<string, unknown> | undefined),
        secret: process.env["CLAUDE_A2A_JWT_SECRET"],
      },
    };
  }
  if (process.env["CLAUDE_A2A_PORT"]) {
    raw["server"] = {
      ...(raw["server"] as Record<string, unknown> | undefined),
      port: parseInt(process.env["CLAUDE_A2A_PORT"], 10),
    };
  }
  if (process.env["CLAUDE_A2A_DATA_DIR"]) {
    raw["data_dir"] = process.env["CLAUDE_A2A_DATA_DIR"];
  }
}

export function loadConfig(configPath?: string): Config {
  const path = configPath ?? resolveConfigPath();

  let raw: Record<string, unknown> = {};
  if (path && existsSync(path)) {
    const content = readFileSync(path, "utf-8");
    raw = (parseYaml(content) as Record<string, unknown>) ?? {};
  }

  applyEnvOverrides(raw);

  const config = ConfigSchema.parse(raw);

  // Derive work_dir from data_dir if not explicitly set
  if (!config.claude.work_dir) {
    config.claude.work_dir = `${config.data_dir}/workdir`;
  }

  return config;
}

export interface ServeFlags {
  agent: string;
  workDir?: string;
  model?: string;
  permissionMode?: string;
  systemPrompt?: string;
  maxBudget?: number;
  port?: number;
  host?: string;
}

export function buildConfigFromFlags(flags: ServeFlags): Config {
  const raw: Record<string, unknown> = {};

  // Set data_dir to local ./data unless env override
  if (!process.env["CLAUDE_A2A_DATA_DIR"]) {
    raw["data_dir"] = "./data";
  }

  // Apply port/host if provided via flags
  if (flags.port !== undefined || flags.host !== undefined) {
    const server: Record<string, unknown> = {};
    if (flags.port !== undefined) server["port"] = flags.port;
    if (flags.host !== undefined) server["host"] = flags.host;
    raw["server"] = server;
  }

  applyEnvOverrides(raw);

  const config = ConfigSchema.parse(raw);

  // Build the single agent entry
  const workDir = flags.workDir
    ? resolve(flags.workDir)
    : undefined;

  const settingsFile =
    workDir && existsSync(resolve(workDir, ".claude", "settings.json"))
      ? resolve(workDir, ".claude", "settings.json")
      : null;

  const agentConfig: Record<string, unknown> = {
    work_dir: workDir ?? null,
    settings_file: settingsFile,
  };
  if (flags.model) agentConfig["model"] = flags.model;
  if (flags.permissionMode)
    agentConfig["permission_mode"] = flags.permissionMode;
  if (flags.systemPrompt)
    agentConfig["append_system_prompt"] = flags.systemPrompt;
  if (flags.maxBudget) agentConfig["max_budget_usd"] = flags.maxBudget;

  const parsedAgent = AgentConfigSchema.parse(agentConfig);
  config.agents = { [flags.agent]: parsedAgent };

  // Derive work_dir from data_dir if not explicitly set
  if (!config.claude.work_dir) {
    config.claude.work_dir = `${config.data_dir}/workdir`;
  }

  return config;
}

function resolveConfigPath(): string | undefined {
  const candidates = [
    process.env["CLAUDE_A2A_CONFIG"],
    resolve(process.cwd(), "config.yaml"),
    resolve("/etc/claude-a2a/config.yaml"),
  ];
  for (const c of candidates) {
    if (c && existsSync(c)) return c;
  }
  return undefined;
}
