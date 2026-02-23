import { describe, it, expect, vi, beforeEach } from "vitest";
import { ClaudeRunner, CapacityError, TimeoutError } from "../../src/server/claude-runner.js";
import { SessionBusyError, ClaudeSessionError } from "../../src/server/claude-session.js";
import { loadConfig } from "../../src/server/config.js";
import pino from "pino";

// ---------------------------------------------------------------------------
// Mock child_process.spawn — simulates stream-json Claude process
// ---------------------------------------------------------------------------

const spawnedProcs: any[] = [];
let autoInit = true;
let autoResult = true;

vi.mock("node:child_process", () => {
  const { EventEmitter } = require("node:events");
  const { Readable, Writable } = require("node:stream");

  return {
    spawn: vi.fn(() => {
      const proc = new EventEmitter();
      proc.stdout = new Readable({ read() {} });
      proc.stderr = new Readable({ read() {} });
      proc.stdin = new Writable({
        write(chunk: Buffer, _enc: unknown, cb: () => void) {
          if (autoResult) {
            try {
              const msg = JSON.parse(chunk.toString());
              if (msg.type === "user") {
                setTimeout(() => {
                  if (proc.killed) return;
                  const resultLine = JSON.stringify({
                    type: "result",
                    subtype: "success",
                    session_id: "test-session-123",
                    is_error: false,
                    duration_ms: 500,
                    duration_api_ms: 450,
                    num_turns: 1,
                    result: "Hello from Claude!",
                    total_cost_usd: 0.01,
                    usage: {
                      input_tokens: 100,
                      output_tokens: 50,
                      cache_creation_input_tokens: 0,
                      cache_read_input_tokens: 0,
                    },
                    permission_denials: [],
                    uuid: "r-1",
                  });
                  proc.stdout.push(Buffer.from(resultLine + "\n"));
                }, 5);
              }
            } catch {
              // ignore
            }
          }
          cb();
        },
      });
      proc.stdin.end = vi.fn();
      proc.killed = false;
      proc.kill = vi.fn((signal: string) => {
        proc.killed = true;
        if (signal === "SIGTERM" || signal === "SIGKILL") {
          setTimeout(() => proc.emit("close", 1), 5);
        }
      });
      proc.unref = vi.fn();
      proc.pid = 99000 + spawnedProcs.length;

      spawnedProcs.push(proc);

      if (autoInit) {
        setTimeout(() => {
          if (proc.killed) return;
          const initLine = JSON.stringify({
            type: "system",
            subtype: "init",
            session_id: "test-session-123",
            model: "claude-sonnet-4-6",
            tools: [],
            cwd: "/tmp",
            uuid: "init-1",
          });
          proc.stdout.push(Buffer.from(initLine + "\n"));
        }, 2);
      }

      return proc;
    }),
  };
});

const log = pino({ level: "silent" });

describe("ClaudeRunner", () => {
  let runner: ClaudeRunner;

  beforeEach(() => {
    spawnedProcs.length = 0;
    autoInit = true;
    autoResult = true;
    const config = loadConfig("/nonexistent");
    runner = new ClaudeRunner(config, log);
  });

  it("starts with zero sessions", () => {
    expect(runner.concurrentCount).toBe(0);
    expect(runner.isFull).toBe(false);
  });

  it("creates a session and returns response on first message", async () => {
    const config = loadConfig("/nonexistent");
    const agentConfig = config.agents["general"]!;

    const result = await runner.sendMessage({
      agentName: "general",
      agentConfig,
      message: "Hello",
      contextId: "ctx-1",
    });

    expect(result.result).toBe("Hello from Claude!");
    expect(result.session_id).toBe("test-session-123");
    expect(result.total_cost_usd).toBe(0.01);
    expect(result.model_used).toBe("claude-sonnet-4-6");
    expect(result.is_error).toBe(false);
    expect(runner.concurrentCount).toBe(1);
    expect(runner.hasSession("ctx-1")).toBe(true);
  });

  it("reuses existing session for same contextId", async () => {
    const config = loadConfig("/nonexistent");
    const agentConfig = config.agents["general"]!;

    await runner.sendMessage({
      agentName: "general",
      agentConfig,
      message: "First",
      contextId: "ctx-1",
    });

    // Should only have spawned one process
    expect(spawnedProcs.length).toBe(1);

    await runner.sendMessage({
      agentName: "general",
      agentConfig,
      message: "Second",
      contextId: "ctx-1",
    });

    // Still only one process — reused
    expect(spawnedProcs.length).toBe(1);
    expect(runner.concurrentCount).toBe(1);
  });

  it("creates separate sessions for different contextIds", async () => {
    const config = loadConfig("/nonexistent");
    const agentConfig = config.agents["general"]!;

    await runner.sendMessage({
      agentName: "general",
      agentConfig,
      message: "Hello",
      contextId: "ctx-1",
    });

    await runner.sendMessage({
      agentName: "general",
      agentConfig,
      message: "Hello",
      contextId: "ctx-2",
    });

    expect(spawnedProcs.length).toBe(2);
    expect(runner.concurrentCount).toBe(2);
  });

  it("rejects with CapacityError when at session limit", async () => {
    const config = loadConfig("/nonexistent");
    config.server.max_concurrent = 1;
    const singleRunner = new ClaudeRunner(config, log);
    const agentConfig = config.agents["general"]!;

    await singleRunner.sendMessage({
      agentName: "general",
      agentConfig,
      message: "First",
      contextId: "ctx-1",
    });

    await expect(
      singleRunner.sendMessage({
        agentName: "general",
        agentConfig,
        message: "Second",
        contextId: "ctx-2",
      }),
    ).rejects.toThrow(CapacityError);
  });

  it("killAll destroys all sessions", async () => {
    const config = loadConfig("/nonexistent");
    const agentConfig = config.agents["general"]!;

    await runner.sendMessage({
      agentName: "general",
      agentConfig,
      message: "Hello",
      contextId: "ctx-1",
    });

    await runner.sendMessage({
      agentName: "general",
      agentConfig,
      message: "Hello",
      contextId: "ctx-2",
    });

    expect(runner.concurrentCount).toBe(2);

    runner.killAll();

    expect(runner.concurrentCount).toBe(0);
    expect(spawnedProcs[0].kill).toHaveBeenCalledWith("SIGTERM");
    expect(spawnedProcs[1].kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("cancelByTaskId destroys the session", async () => {
    const config = loadConfig("/nonexistent");
    const agentConfig = config.agents["general"]!;

    await runner.sendMessage({
      agentName: "general",
      agentConfig,
      message: "Hello",
      contextId: "ctx-1",
      taskId: "task-1",
    });

    const cancelled = runner.cancelByTaskId("task-1");
    expect(cancelled).toBe(true);
    expect(runner.concurrentCount).toBe(0);
    expect(spawnedProcs[0].kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("cancelByTaskId returns false for unknown task", () => {
    expect(runner.cancelByTaskId("nonexistent")).toBe(false);
  });

  it("destroySession removes session by contextId", async () => {
    const config = loadConfig("/nonexistent");
    const agentConfig = config.agents["general"]!;

    await runner.sendMessage({
      agentName: "general",
      agentConfig,
      message: "Hello",
      contextId: "ctx-1",
    });

    expect(runner.hasSession("ctx-1")).toBe(true);
    runner.destroySession("ctx-1");
    expect(runner.hasSession("ctx-1")).toBe(false);
    expect(runner.concurrentCount).toBe(0);
  });

  it("rejects with TimeoutError when message times out", async () => {
    autoResult = false;
    const config = loadConfig("/nonexistent");
    config.server.request_timeout = 0.05; // 50ms
    const timeoutRunner = new ClaudeRunner(config, log);
    const agentConfig = config.agents["general"]!;

    await expect(
      timeoutRunner.sendMessage({
        agentName: "general",
        agentConfig,
        message: "Slow",
        contextId: "ctx-1",
      }),
    ).rejects.toThrow(TimeoutError);

    // Session should still be alive (process NOT killed on timeout)
    expect(timeoutRunner.hasSession("ctx-1")).toBe(true);
  });

  it("re-creates session after process death", async () => {
    const config = loadConfig("/nonexistent");
    const agentConfig = config.agents["general"]!;

    await runner.sendMessage({
      agentName: "general",
      agentConfig,
      message: "Hello",
      contextId: "ctx-1",
    });

    expect(spawnedProcs.length).toBe(1);

    // Simulate process death
    spawnedProcs[0].emit("close", 137);

    // Wait for death handler to fire
    await new Promise((r) => setTimeout(r, 10));

    expect(runner.hasSession("ctx-1")).toBe(false);

    // Next message creates a new session
    await runner.sendMessage({
      agentName: "general",
      agentConfig,
      message: "Hello again",
      contextId: "ctx-1",
    });

    expect(spawnedProcs.length).toBe(2);
    expect(runner.hasSession("ctx-1")).toBe(true);
  });

  it("releaseAll releases all sessions without killing them", async () => {
    const config = loadConfig("/nonexistent");
    const agentConfig = config.agents["general"]!;

    await runner.sendMessage({
      agentName: "general",
      agentConfig,
      message: "Hello",
      contextId: "ctx-1",
      taskId: "task-1",
    });

    await runner.sendMessage({
      agentName: "general",
      agentConfig,
      message: "Hello",
      contextId: "ctx-2",
      taskId: "task-2",
    });

    expect(runner.concurrentCount).toBe(2);

    // Mock task store
    const mockTaskStore = {
      load: vi.fn().mockResolvedValue(null),
      save: vi.fn().mockResolvedValue(undefined),
    } as any;

    await runner.releaseAll(mockTaskStore);

    expect(runner.concurrentCount).toBe(0);
    // Processes should NOT be killed — release() was called instead of destroy()
    expect(spawnedProcs[0].kill).not.toHaveBeenCalled();
    expect(spawnedProcs[1].kill).not.toHaveBeenCalled();
    // stdin should be ended and proc unrefed
    expect(spawnedProcs[0].stdin.end).toHaveBeenCalled();
    expect(spawnedProcs[1].stdin.end).toHaveBeenCalled();
    expect(spawnedProcs[0].unref).toHaveBeenCalled();
    expect(spawnedProcs[1].unref).toHaveBeenCalled();
  });

  it("releaseAll updates in-flight tasks to working status", async () => {
    const config = loadConfig("/nonexistent");
    const agentConfig = config.agents["general"]!;

    await runner.sendMessage({
      agentName: "general",
      agentConfig,
      message: "Hello",
      contextId: "ctx-1",
      taskId: "task-1",
    });

    const mockTask = {
      id: "task-1",
      contextId: "ctx-1",
      status: { state: "working", timestamp: new Date().toISOString() },
    };
    const mockTaskStore = {
      load: vi.fn().mockResolvedValue(mockTask),
      save: vi.fn().mockResolvedValue(undefined),
    } as any;

    await runner.releaseAll(mockTaskStore);

    expect(mockTaskStore.save).toHaveBeenCalled();
    const savedTask = mockTaskStore.save.mock.calls[0][0];
    expect(savedTask.status.state).toBe("working");
    expect(savedTask.status.message.parts[0].text).toContain("Server restarting");
  });
});
