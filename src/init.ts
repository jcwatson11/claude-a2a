import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { stringify as stringifyYaml } from "yaml";

export interface InitOptions {
  yes?: boolean;
  dir?: string;
}

interface InitAnswers {
  agentName: string;
  description: string;
  workDir: string;
  allowedTools: string[];
  permissionMode: string;
  model: string;
  maxBudget: number;
  systemPrompt: string;
}

const DEFAULT_TOOLS = ["Read", "Write", "Edit", "Glob", "Grep", "Bash"];

function getDefaults(targetDir: string): InitAnswers {
  return {
    agentName: "default",
    description: "General-purpose Claude assistant",
    workDir: targetDir,
    allowedTools: DEFAULT_TOOLS,
    permissionMode: "default",
    model: "",
    maxBudget: 1.0,
    systemPrompt: "You are responding via the claude-a2a A2A API. Be concise.",
  };
}

async function promptUser(targetDir: string): Promise<InitAnswers> {
  const defaults = getDefaults(targetDir);
  const rl = createInterface({ input: stdin, output: stdout });

  try {
    const agentName =
      (await rl.question(`Agent name [${defaults.agentName}]: `)).trim() ||
      defaults.agentName;

    const description =
      (await rl.question(`Description [${defaults.description}]: `)).trim() ||
      defaults.description;

    const workDir =
      (await rl.question(`Working directory [${defaults.workDir}]: `)).trim() ||
      defaults.workDir;

    const toolsInput = (
      await rl.question(
        `Allowed tools (comma-separated) [${defaults.allowedTools.join(",")}]: `,
      )
    ).trim();
    const allowedTools = toolsInput
      ? toolsInput.split(",").map((t) => t.trim())
      : defaults.allowedTools;

    const permissionMode =
      (
        await rl.question(
          `Permission mode [${defaults.permissionMode}]: `,
        )
      ).trim() || defaults.permissionMode;

    const model =
      (await rl.question(`Model (blank for CLI default): `)).trim() ||
      defaults.model;

    const budgetInput = (
      await rl.question(`Max budget USD [${defaults.maxBudget}]: `)
    ).trim();
    const maxBudget = budgetInput ? parseFloat(budgetInput) : defaults.maxBudget;

    const systemPrompt =
      (
        await rl.question(
          `System prompt [${defaults.systemPrompt}]: `,
        )
      ).trim() || defaults.systemPrompt;

    return {
      agentName,
      description,
      workDir,
      allowedTools,
      permissionMode,
      model,
      maxBudget,
      systemPrompt,
    };
  } finally {
    rl.close();
  }
}

function generateConfigYaml(answers: InitAnswers): string {
  const agentEntry: Record<string, unknown> = {
    description: answers.description,
    enabled: true,
    model: answers.model || null,
    append_system_prompt: answers.systemPrompt,
    permission_mode: answers.permissionMode,
    allowed_tools: answers.allowedTools,
    max_budget_usd: answers.maxBudget,
    work_dir: resolve(answers.workDir),
  };

  const settingsPath = resolve(answers.workDir, ".claude", "settings.json");
  if (existsSync(settingsPath)) {
    agentEntry["settings_file"] = settingsPath;
  }

  const config = {
    server: {
      host: "0.0.0.0",
      port: 8462,
    },
    data_dir: "./data",
    agents: {
      [answers.agentName]: agentEntry,
    },
  };

  return stringifyYaml(config, { lineWidth: 120 });
}

function generateSettingsJson(allowedTools: string[]): string {
  const settings = {
    permissions: {
      allow: allowedTools.map((tool) => `${tool}(*)`),
    },
  };
  return JSON.stringify(settings, null, 2) + "\n";
}

export async function runInit(options: InitOptions): Promise<void> {
  const targetDir = resolve(options.dir ?? ".");

  const answers = options.yes
    ? getDefaults(targetDir)
    : await promptUser(targetDir);

  // Ensure target directory exists
  mkdirSync(targetDir, { recursive: true });

  // Write config.yaml
  const configPath = join(targetDir, "config.yaml");
  const configContent = generateConfigYaml(answers);
  writeFileSync(configPath, configContent, "utf-8");
  console.log(`Created ${configPath}`);

  // Write .claude/settings.json (skip if already exists)
  const workDir = resolve(answers.workDir);
  const claudeDir = join(workDir, ".claude");
  const settingsPath = join(claudeDir, "settings.json");

  if (!existsSync(settingsPath)) {
    mkdirSync(claudeDir, { recursive: true });
    const settingsContent = generateSettingsJson(answers.allowedTools);
    writeFileSync(settingsPath, settingsContent, "utf-8");
    console.log(`Created ${settingsPath}`);
  } else {
    console.log(`Skipped ${settingsPath} (already exists)`);
  }

  console.log("\nTo start the server:");
  console.log(`  claude-a2a serve -c ${configPath}`);
}
