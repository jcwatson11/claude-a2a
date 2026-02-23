import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadConfig, buildConfigFromFlags } from "../../src/server/config.js";
import { writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

const tmpDir = join(import.meta.dirname, ".tmp-config-test");

beforeEach(() => {
  mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env["CLAUDE_A2A_MASTER_KEY"];
  delete process.env["CLAUDE_A2A_JWT_SECRET"];
  delete process.env["CLAUDE_A2A_PORT"];
  delete process.env["CLAUDE_A2A_DATA_DIR"];
});

describe("loadConfig", () => {
  it("returns defaults with no config file", () => {
    const config = loadConfig("/nonexistent/path.yaml");
    expect(config.server.port).toBe(8462);
    expect(config.server.host).toBe("0.0.0.0");
    expect(config.server.max_concurrent).toBe(4);
    expect(config.auth.master_key).toBeNull();
    expect(config.agents["general"]).toBeDefined();
    expect(config.agents["general"]!.enabled).toBe(true);
  });

  it("loads YAML config", () => {
    const configPath = join(tmpDir, "test.yaml");
    writeFileSync(
      configPath,
      `
server:
  port: 9999
  host: "127.0.0.1"
agents:
  custom:
    description: "Custom agent"
    enabled: true
    max_budget_usd: 5.0
`,
    );

    const config = loadConfig(configPath);
    expect(config.server.port).toBe(9999);
    expect(config.server.host).toBe("127.0.0.1");
    expect(config.agents["custom"]).toBeDefined();
    expect(config.agents["custom"]!.max_budget_usd).toBe(5.0);
  });

  it("rejects JWT algorithm 'none'", () => {
    const configPath = join(tmpDir, "none-alg.yaml");
    writeFileSync(
      configPath,
      `
auth:
  jwt:
    algorithm: "none"
`,
    );

    expect(() => loadConfig(configPath)).toThrow();
  });

  it("rejects unsupported JWT algorithms", () => {
    const configPath = join(tmpDir, "bad-alg.yaml");
    writeFileSync(
      configPath,
      `
auth:
  jwt:
    algorithm: "RS256"
`,
    );

    expect(() => loadConfig(configPath)).toThrow();
  });

  it("accepts valid JWT algorithms", () => {
    for (const alg of ["HS256", "HS384", "HS512"]) {
      const configPath = join(tmpDir, `${alg}.yaml`);
      writeFileSync(configPath, `\nauth:\n  jwt:\n    algorithm: "${alg}"\n`);
      const config = loadConfig(configPath);
      expect(config.auth.jwt.algorithm).toBe(alg);
    }
  });

  it("applies env var overrides", () => {
    process.env["CLAUDE_A2A_MASTER_KEY"] = "test-key-123";
    process.env["CLAUDE_A2A_JWT_SECRET"] = "jwt-secret-456";
    process.env["CLAUDE_A2A_PORT"] = "7777";

    const config = loadConfig("/nonexistent/path.yaml");
    expect(config.auth.master_key).toBe("test-key-123");
    expect(config.auth.jwt.secret).toBe("jwt-secret-456");
    expect(config.server.port).toBe(7777);
  });

  it("derives work_dir from data_dir when not set", () => {
    const config = loadConfig("/nonexistent/path.yaml");
    expect(config.data_dir).toBe("/var/lib/claude-a2a");
    expect(config.claude.work_dir).toBe("/var/lib/claude-a2a/workdir");
  });

  it("respects explicit work_dir over data_dir", () => {
    const configPath = join(tmpDir, "workdir.yaml");
    writeFileSync(configPath, `
data_dir: "/data/a2a"
claude:
  work_dir: "/custom/workdir"
`);
    const config = loadConfig(configPath);
    expect(config.data_dir).toBe("/data/a2a");
    expect(config.claude.work_dir).toBe("/custom/workdir");
  });

  it("applies CLAUDE_A2A_DATA_DIR env var", () => {
    process.env["CLAUDE_A2A_DATA_DIR"] = "/docker/volume";
    const config = loadConfig("/nonexistent/path.yaml");
    expect(config.data_dir).toBe("/docker/volume");
    expect(config.claude.work_dir).toBe("/docker/volume/workdir");
  });
});

describe("buildConfigFromFlags", () => {
  it("creates valid config with just agent name", () => {
    const config = buildConfigFromFlags({ agent: "myagent" });
    expect(config.agents["myagent"]).toBeDefined();
    expect(config.agents["myagent"]!.enabled).toBe(true);
    expect(config.agents["general"]).toBeUndefined();
    expect(config.server.port).toBe(8462);
  });

  it("applies workDir and auto-detects settings.json", () => {
    const workDir = join(tmpDir, "workspace");
    const claudeDir = join(workDir, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(join(claudeDir, "settings.json"), "{}");

    const config = buildConfigFromFlags({ agent: "test", workDir });
    const agent = config.agents["test"]!;
    expect(agent.work_dir).toBe(resolve(workDir));
    expect(agent.settings_file).toBe(
      resolve(workDir, ".claude", "settings.json"),
    );
  });

  it("sets settings_file to null when no settings.json exists", () => {
    const config = buildConfigFromFlags({
      agent: "test",
      workDir: "/nonexistent/path",
    });
    expect(config.agents["test"]!.settings_file).toBeNull();
  });

  it("applies model, permissionMode, systemPrompt, maxBudget", () => {
    const config = buildConfigFromFlags({
      agent: "test",
      model: "claude-sonnet-4-6",
      permissionMode: "bypassPermissions",
      systemPrompt: "Be helpful.",
      maxBudget: 5.0,
    });
    const agent = config.agents["test"]!;
    expect(agent.model).toBe("claude-sonnet-4-6");
    expect(agent.permission_mode).toBe("bypassPermissions");
    expect(agent.append_system_prompt).toBe("Be helpful.");
    expect(agent.max_budget_usd).toBe(5.0);
  });

  it("applies port and host overrides", () => {
    const config = buildConfigFromFlags({
      agent: "test",
      port: 9000,
      host: "127.0.0.1",
    });
    expect(config.server.port).toBe(9000);
    expect(config.server.host).toBe("127.0.0.1");
  });

  it("applies env var overrides for auth", () => {
    process.env["CLAUDE_A2A_MASTER_KEY"] = "flag-key";
    const config = buildConfigFromFlags({ agent: "test" });
    expect(config.auth.master_key).toBe("flag-key");
  });

  it("uses local data_dir by default", () => {
    const config = buildConfigFromFlags({ agent: "test" });
    expect(config.data_dir).toBe("./data");
    expect(config.claude.work_dir).toBe("./data/workdir");
  });

  it("respects CLAUDE_A2A_DATA_DIR env var", () => {
    process.env["CLAUDE_A2A_DATA_DIR"] = "/custom/data";
    const config = buildConfigFromFlags({ agent: "test" });
    expect(config.data_dir).toBe("/custom/data");
  });
});
