import { describe, it, expect } from "vitest";
import { ClaudeResponseSchema } from "../../src/server/claude-runner.js";

describe("ClaudeResponseSchema", () => {
  const validResponse = {
    result: "Hello!",
    session_id: "sess-123",
    is_error: false,
    duration_ms: 1000,
    duration_api_ms: 900,
    num_turns: 1,
    total_cost_usd: 0.01,
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_input_tokens: 10,
      cache_read_input_tokens: 5,
    },
    model_used: "claude-sonnet-4-6",
    permission_denials: [],
  };

  it("accepts a valid full response", () => {
    const result = ClaudeResponseSchema.safeParse(validResponse);
    expect(result.success).toBe(true);
  });

  it("defaults cache token fields when missing from usage", () => {
    const response = {
      ...validResponse,
      usage: { input_tokens: 100, output_tokens: 50 },
    };
    const result = ClaudeResponseSchema.safeParse(response);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.usage.cache_creation_input_tokens).toBe(0);
      expect(result.data.usage.cache_read_input_tokens).toBe(0);
    }
  });

  it("defaults permission_denials when missing", () => {
    const { permission_denials: _, ...response } = validResponse;
    const result = ClaudeResponseSchema.safeParse(response);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.permission_denials).toEqual([]);
    }
  });

  it("accepts optional context field", () => {
    const response = {
      ...validResponse,
      context: {
        used_tokens: 500,
        max_tokens: 10000,
        remaining_tokens: 9500,
        compact_recommended: false,
      },
    };
    const result = ClaudeResponseSchema.safeParse(response);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.context?.used_tokens).toBe(500);
    }
  });

  it("rejects missing result field", () => {
    const { result: _, ...response } = validResponse;
    const parsed = ClaudeResponseSchema.safeParse(response);
    expect(parsed.success).toBe(false);
  });

  it("rejects missing session_id", () => {
    const { session_id: _, ...response } = validResponse;
    const parsed = ClaudeResponseSchema.safeParse(response);
    expect(parsed.success).toBe(false);
  });

  it("rejects wrong type for total_cost_usd", () => {
    const response = { ...validResponse, total_cost_usd: "not a number" };
    const parsed = ClaudeResponseSchema.safeParse(response);
    expect(parsed.success).toBe(false);
  });

  it("rejects missing usage object", () => {
    const { usage: _, ...response } = validResponse;
    const parsed = ClaudeResponseSchema.safeParse(response);
    expect(parsed.success).toBe(false);
  });

  it("rejects non-boolean is_error", () => {
    const response = { ...validResponse, is_error: "yes" };
    const parsed = ClaudeResponseSchema.safeParse(response);
    expect(parsed.success).toBe(false);
  });
});
