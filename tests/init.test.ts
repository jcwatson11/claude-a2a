import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { runInit } from "../src/init.js";
import {
  readFileSync,
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { loadConfig } from "../src/server/config.js";

const tmpDir = join(import.meta.dirname, ".tmp-init-test");

beforeEach(() => {
  mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("runInit --yes", () => {
  it("creates config.yaml with defaults", async () => {
    await runInit({ yes: true, dir: tmpDir });

    const configPath = join(tmpDir, "config.yaml");
    expect(existsSync(configPath)).toBe(true);

    const content = readFileSync(configPath, "utf-8");
    const parsed = parseYaml(content) as Record<string, unknown>;

    expect(parsed["data_dir"]).toBe("./data");
    expect(parsed["server"]).toBeDefined();

    const agents = parsed["agents"] as Record<string, Record<string, unknown>>;
    expect(agents["default"]).toBeDefined();
    expect(agents["default"]["enabled"]).toBe(true);
    expect(agents["default"]["max_budget_usd"]).toBe(1.0);
  });

  it("creates .claude/settings.json with all tools", async () => {
    await runInit({ yes: true, dir: tmpDir });

    const settingsPath = join(tmpDir, ".claude", "settings.json");
    expect(existsSync(settingsPath)).toBe(true);

    const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    expect(settings.permissions.allow).toContain("Read(*)");
    expect(settings.permissions.allow).toContain("Write(*)");
    expect(settings.permissions.allow).toContain("Edit(*)");
    expect(settings.permissions.allow).toContain("Glob(*)");
    expect(settings.permissions.allow).toContain("Grep(*)");
    expect(settings.permissions.allow).toContain("Bash(*)");
  });

  it("does not overwrite existing settings.json", async () => {
    const claudeDir = join(tmpDir, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(
      join(claudeDir, "settings.json"),
      '{"existing": true}',
      "utf-8",
    );

    await runInit({ yes: true, dir: tmpDir });

    const settings = JSON.parse(
      readFileSync(join(claudeDir, "settings.json"), "utf-8"),
    );
    expect(settings.existing).toBe(true);
    expect(settings.permissions).toBeUndefined();
  });

  it("generated YAML is parseable by loadConfig", async () => {
    await runInit({ yes: true, dir: tmpDir });

    const configPath = join(tmpDir, "config.yaml");
    const config = loadConfig(configPath);

    expect(config.agents["default"]).toBeDefined();
    expect(config.server.port).toBe(8462);
    expect(config.data_dir).toBe("./data");
  });
});
