import { describe, it, expect, vi, beforeEach } from "vitest";
import { ClaudeRunner, CapacityError } from "../../src/server/claude-runner.js";
import { loadConfig } from "../../src/server/config.js";
import pino from "pino";

// Mock child_process.spawn
vi.mock("node:child_process", () => {
  const { EventEmitter } = require("node:events");
  const { Readable, Writable } = require("node:stream");

  return {
    spawn: vi.fn(() => {
      const proc = new EventEmitter();
      proc.stdout = new Readable({ read() {} });
      proc.stderr = new Readable({ read() {} });
      proc.stdin = new Writable({ write(_c: unknown, _e: unknown, cb: () => void) { cb(); } });
      proc.stdin.end = vi.fn();
      proc.killed = false;
      proc.kill = vi.fn(() => { proc.killed = true; });

      // Simulate successful response after a tick
      setTimeout(() => {
        const response = JSON.stringify({
          result: "Hello from Claude!",
          session_id: "test-session-123",
          is_error: false,
          duration_ms: 1000,
          duration_api_ms: 900,
          num_turns: 1,
          total_cost_usd: 0.01,
          usage: {
            input_tokens: 100,
            output_tokens: 50,
          },
          model_used: "claude-sonnet-4-6",
        });
        proc.stdout.push(Buffer.from(response));
        proc.stdout.push(null);
        proc.emit("close", 0);
      }, 10);

      return proc;
    }),
  };
});

const log = pino({ level: "silent" });

describe("ClaudeRunner", () => {
  let runner: ClaudeRunner;

  beforeEach(() => {
    const config = loadConfig("/nonexistent");
    runner = new ClaudeRunner(config, log);
  });

  it("tracks concurrent count", () => {
    expect(runner.concurrentCount).toBe(0);
    expect(runner.isFull).toBe(false);
  });

  it("runs a claude process and parses output", async () => {
    const config = loadConfig("/nonexistent");
    const agentConfig = config.agents["general"]!;

    const result = await runner.run({
      agentName: "general",
      agentConfig,
      message: "Hello",
    });

    expect(result.result).toBe("Hello from Claude!");
    expect(result.session_id).toBe("test-session-123");
    expect(result.total_cost_usd).toBe(0.01);
    expect(result.model_used).toBe("claude-sonnet-4-6");
    expect(result.is_error).toBe(false);
  });

  it("rejects when at capacity", async () => {
    // Config with max_concurrent = 1
    const config = loadConfig("/nonexistent");
    config.server.max_concurrent = 1;
    const singleRunner = new ClaudeRunner(config, log);
    const agentConfig = config.agents["general"]!;

    // Start one process
    const p1 = singleRunner.run({
      agentName: "general",
      agentConfig,
      message: "First",
    });

    // Second should fail
    await expect(
      singleRunner.run({
        agentName: "general",
        agentConfig,
        message: "Second",
      }),
    ).rejects.toThrow(CapacityError);

    await p1;
  });
});
