import { describe, it, expect, vi, beforeEach } from "vitest";
import { ClaudeSession, ClaudeSessionError, SessionBusyError, type ContentBlock } from "../../src/server/claude-session.js";
import { TimeoutError } from "../../src/server/claude-runner.js";
import { loadConfig } from "../../src/server/config.js";
import pino from "pino";

// ---------------------------------------------------------------------------
// Mock child_process.spawn — simulates a stream-json Claude process
// ---------------------------------------------------------------------------

const spawnedProcs: MockProc[] = [];

interface MockProc {
  stdout: { push: (data: Buffer | null) => void; on: ReturnType<typeof vi.fn> };
  stderr: { on: ReturnType<typeof vi.fn> };
  stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
  killed: boolean;
  kill: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  emit: (event: string, ...args: unknown[]) => void;
}

/** Whether the mock auto-emits a system init message on spawn. */
let autoInit = true;
/** Whether the mock auto-emits a result message on stdin write. */
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
          // Parse the incoming message so we can auto-respond
          if (autoResult) {
            try {
              const msg = JSON.parse(chunk.toString());
              if (msg.type === "user") {
                setTimeout(() => {
                  if (proc.killed) return;
                  // Emit an assistant message then a result
                  const assistantLine = JSON.stringify({
                    type: "assistant",
                    message: { content: [{ type: "text", text: "Mock response" }] },
                    session_id: "mock-session-1",
                    uuid: "asst-1",
                  });
                  const resultLine = JSON.stringify({
                    type: "result",
                    subtype: "success",
                    session_id: "mock-session-1",
                    is_error: false,
                    duration_ms: 500,
                    duration_api_ms: 450,
                    num_turns: 1,
                    result: "Mock response",
                    total_cost_usd: 0.01,
                    usage: {
                      input_tokens: 100,
                      output_tokens: 50,
                      cache_creation_input_tokens: 0,
                      cache_read_input_tokens: 0,
                    },
                    permission_denials: [],
                    uuid: "result-1",
                  });
                  proc.stdout.push(Buffer.from(assistantLine + "\n"));
                  proc.stdout.push(Buffer.from(resultLine + "\n"));
                }, 5);
              }
            } catch {
              // ignore parse errors
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
      proc.pid = 12345;

      spawnedProcs.push(proc);

      // Auto-emit system init message
      if (autoInit) {
        setTimeout(() => {
          if (proc.killed) return;
          const initLine = JSON.stringify({
            type: "system",
            subtype: "init",
            session_id: "mock-session-1",
            model: "claude-sonnet-4-6",
            tools: ["Read", "Write"],
            cwd: "/tmp",
            permissionMode: "default",
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

function makeSessionOptions(overrides?: Partial<{ resumeSessionId: string }>) {
  const config = loadConfig("/nonexistent");
  const agentConfig = config.agents["general"]!;
  return {
    agentName: "general",
    agentConfig,
    config,
    log,
    ...overrides,
  };
}

describe("ClaudeSession", () => {
  beforeEach(() => {
    spawnedProcs.length = 0;
    autoInit = true;
    autoResult = true;
  });

  it("initializes from system init message", async () => {
    const session = new ClaudeSession(makeSessionOptions());
    await session.waitForInit();

    expect(session.state).toBe("idle");
    expect(session.claudeSessionId).toBe("mock-session-1");
    expect(session.isAlive).toBe(true);
    expect(session.isIdle).toBe(true);

    session.destroy();
  });

  it("sendMessage resolves with mapped ClaudeResponse", async () => {
    const session = new ClaudeSession(makeSessionOptions());
    await session.waitForInit();

    const response = await session.sendMessage("Hello", 5000);

    expect(response.result).toBe("Mock response");
    expect(response.session_id).toBe("mock-session-1");
    expect(response.is_error).toBe(false);
    expect(response.total_cost_usd).toBe(0.01);
    expect(response.model_used).toBe("claude-sonnet-4-6");
    expect(response.duration_ms).toBe(500);
    expect(response.usage.input_tokens).toBe(100);
    expect(response.usage.output_tokens).toBe(50);

    session.destroy();
  });

  it("handles multiple sequential messages", async () => {
    const session = new ClaudeSession(makeSessionOptions());
    await session.waitForInit();

    const r1 = await session.sendMessage("First", 5000);
    expect(r1.result).toBe("Mock response");
    expect(session.isIdle).toBe(true);

    const r2 = await session.sendMessage("Second", 5000);
    expect(r2.result).toBe("Mock response");
    expect(session.isIdle).toBe(true);

    session.destroy();
  });

  it("throws SessionBusyError when sending during processing", async () => {
    autoResult = false;
    const session = new ClaudeSession(makeSessionOptions());
    await session.waitForInit();

    // Start a message that won't auto-complete
    const p1 = session.sendMessage("First", 5000);

    // Try to send another — should throw
    await expect(
      session.sendMessage("Second", 5000),
    ).rejects.toThrow(SessionBusyError);

    // Clean up: manually emit a result to resolve p1
    const proc = spawnedProcs[0]!;
    const resultLine = JSON.stringify({
      type: "result",
      subtype: "success",
      session_id: "mock-session-1",
      is_error: false,
      duration_ms: 100,
      duration_api_ms: 90,
      num_turns: 1,
      result: "late",
      total_cost_usd: 0.005,
      usage: { input_tokens: 10, output_tokens: 5 },
      permission_denials: [],
      uuid: "r-1",
    });
    proc.stdout.push(Buffer.from(resultLine + "\n"));
    await p1;

    session.destroy();
  });

  it("rejects with TimeoutError when message times out", async () => {
    autoResult = false;
    const session = new ClaudeSession(makeSessionOptions());
    await session.waitForInit();

    const promise = session.sendMessage("Slow", 50); // 50ms timeout

    await expect(promise).rejects.toThrow(TimeoutError);
    await expect(promise).rejects.toThrow(/timed out/);

    // Session should be back to idle (process NOT killed)
    expect(session.isIdle).toBe(true);
    expect(session.isAlive).toBe(true);
    expect(spawnedProcs[0]!.kill).not.toHaveBeenCalled();

    session.destroy();
  });

  it("silently consumes late result after timeout", async () => {
    autoResult = false;
    const session = new ClaudeSession(makeSessionOptions());
    await session.waitForInit();

    const promise = session.sendMessage("Slow", 50);
    await expect(promise).rejects.toThrow(TimeoutError);

    // Now emit the late result
    const proc = spawnedProcs[0]!;
    const resultLine = JSON.stringify({
      type: "result",
      subtype: "success",
      session_id: "mock-session-1",
      is_error: false,
      duration_ms: 100,
      duration_api_ms: 90,
      num_turns: 1,
      result: "late arrival",
      total_cost_usd: 0.005,
      usage: { input_tokens: 10, output_tokens: 5 },
      permission_denials: [],
      uuid: "r-late",
    });
    proc.stdout.push(Buffer.from(resultLine + "\n"));

    // Session should still be idle — no crash, no unhandled rejection
    expect(session.isIdle).toBe(true);

    // Can send another message successfully
    autoResult = true;
    const r2 = await session.sendMessage("Next", 5000);
    expect(r2.result).toBe("Mock response");

    session.destroy();
  });

  it("transitions to dead when process closes unexpectedly", async () => {
    const session = new ClaudeSession(makeSessionOptions());
    await session.waitForInit();

    const onDeath = vi.fn();
    session.onDeath = onDeath;

    // Simulate unexpected process death
    const proc = spawnedProcs[0]!;
    proc.emit("close", 137);

    expect(session.state).toBe("dead");
    expect(session.isAlive).toBe(false);
    expect(onDeath).toHaveBeenCalled();
  });

  it("rejects pending message when process dies", async () => {
    autoResult = false;
    const session = new ClaudeSession(makeSessionOptions());
    await session.waitForInit();

    const promise = session.sendMessage("Hello", 5000);

    // Kill the process
    const proc = spawnedProcs[0]!;
    proc.emit("close", 1);

    await expect(promise).rejects.toThrow(ClaudeSessionError);
    expect(session.state).toBe("dead");
  });

  it("throws ClaudeSessionError when sending to dead session", async () => {
    const session = new ClaudeSession(makeSessionOptions());
    await session.waitForInit();

    session.destroy();

    await expect(
      session.sendMessage("Hello", 5000),
    ).rejects.toThrow(ClaudeSessionError);
  });

  it("handles malformed NDJSON lines gracefully", async () => {
    const session = new ClaudeSession(makeSessionOptions());
    await session.waitForInit();

    // Push garbage to stdout
    const proc = spawnedProcs[0]!;
    proc.stdout.push(Buffer.from("this is not json\n"));
    proc.stdout.push(Buffer.from("{invalid json}\n"));

    // Session should still be functional
    expect(session.isIdle).toBe(true);
    const response = await session.sendMessage("Hello", 5000);
    expect(response.result).toBe("Mock response");

    session.destroy();
  });

  it("destroy kills the process", async () => {
    const session = new ClaudeSession(makeSessionOptions());
    await session.waitForInit();

    session.destroy();

    const proc = spawnedProcs[0]!;
    expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
    expect(session.state).toBe("dead");
  });

  it("waits for init before sending if still initializing", async () => {
    // Init happens automatically after 2ms, so sendMessage should wait
    const session = new ClaudeSession(makeSessionOptions());

    // Don't explicitly waitForInit — sendMessage should handle it
    const response = await session.sendMessage("Hello", 5000);
    expect(response.result).toBe("Mock response");
    expect(session.claudeSessionId).toBe("mock-session-1");

    session.destroy();
  });

  it("exposes the process PID", async () => {
    const session = new ClaudeSession(makeSessionOptions());
    await session.waitForInit();

    expect(session.pid).toBe(12345);

    session.destroy();
  });

  // -------------------------------------------------------------------------
  // release()
  // -------------------------------------------------------------------------

  it("release sets state to dead without killing the process", async () => {
    const session = new ClaudeSession(makeSessionOptions());
    await session.waitForInit();

    session.release();

    const proc = spawnedProcs[0]!;
    expect(session.state).toBe("dead");
    expect(proc.kill).not.toHaveBeenCalled();
    expect(proc.stdin.end).toHaveBeenCalled();
    expect(proc.unref).toHaveBeenCalled();
  });

  it("release nulls onDeath callback", async () => {
    const session = new ClaudeSession(makeSessionOptions());
    await session.waitForInit();

    const onDeath = vi.fn();
    session.onDeath = onDeath;

    session.release();

    // onDeath should be nulled — simulate a late process close
    expect(session.onDeath).toBeNull();
  });

  it("release rejects pending message promise", async () => {
    autoResult = false;
    const session = new ClaudeSession(makeSessionOptions());
    await session.waitForInit();

    const promise = session.sendMessage("Hello", 5000);
    session.release();

    await expect(promise).rejects.toThrow(ClaudeSessionError);
    await expect(promise).rejects.toThrow(/released/);
  });

  it("release is idempotent on dead session", async () => {
    const session = new ClaudeSession(makeSessionOptions());
    await session.waitForInit();

    session.release();
    session.release(); // should not throw

    expect(session.state).toBe("dead");
  });

  // -------------------------------------------------------------------------
  // stdout buffer limit
  // -------------------------------------------------------------------------

  it("destroys session when stdout buffer exceeds limit", async () => {
    const opts = makeSessionOptions();
    opts.config.claude.max_stdout_buffer_mb = 0.001; // ~1KB limit
    const session = new ClaudeSession(opts);
    await session.waitForInit();

    // Push a large chunk without a newline — stays in lineBuffer
    const proc = spawnedProcs[0]!;
    proc.stdout.push(Buffer.from("x".repeat(2000)));

    // Session should be destroyed
    expect(session.state).toBe("dead");
    expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("accepts content blocks array and completes round-trip", async () => {
    const session = new ClaudeSession(makeSessionOptions());
    await session.waitForInit();

    const blocks: ContentBlock[] = [
      { type: "text", text: "Describe this image:" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "abc123" } },
    ];

    // sendMessage should accept ContentBlock[] and complete the round-trip
    // (the mock stdin handler parses the JSON and auto-responds)
    const response = await session.sendMessage(blocks, 5000);
    expect(response.result).toBe("Mock response");
    expect(session.isIdle).toBe(true);

    session.destroy();
  });
});
