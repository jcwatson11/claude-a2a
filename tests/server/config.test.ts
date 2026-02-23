import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadConfig } from "../../src/server/config.js";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const tmpDir = join(import.meta.dirname, ".tmp-config-test");

beforeEach(() => {
  mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env["CLAUDE_A2A_MASTER_KEY"];
  delete process.env["CLAUDE_A2A_JWT_SECRET"];
  delete process.env["CLAUDE_A2A_PORT"];
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
    delete process.env["CLAUDE_A2A_DATA_DIR"];
  });
});
