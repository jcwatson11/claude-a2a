import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { A2AClient } from "../../src/client/a2a-client.js";

// ---------------------------------------------------------------------------
// Mock fetch
// ---------------------------------------------------------------------------

const mockFetch = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Helper: create a mock Response with JSON body */
function jsonResponse(body: unknown, status = 200, statusText = "OK"): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: new Headers(),
  } as unknown as Response;
}

function makeClient(token = "test-token"): A2AClient {
  return new A2AClient({ url: "http://localhost:8462", token });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("A2AClient", () => {
  // -- Constructor --

  describe("constructor", () => {
    it("strips trailing slash from URL", () => {
      // Verified indirectly: fetch should be called with the clean URL
      const client = new A2AClient({ url: "http://localhost:8462/", token: "t" });
      mockFetch.mockResolvedValueOnce(jsonResponse({ status: "ok" }));

      client.getHealth();

      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:8462/health",
        expect.any(Object),
      );
    });
  });

  // -- Authorization header --

  describe("auth headers", () => {
    it("adds Bearer prefix when token does not have it", async () => {
      const client = makeClient("my-token");
      mockFetch.mockResolvedValueOnce(jsonResponse({ status: "ok" }));

      await client.getHealth();

      const call = mockFetch.mock.calls[0]!;
      const opts = call[1] as RequestInit;
      expect((opts.headers as Record<string, string>)["Authorization"]).toBe("Bearer my-token");
    });

    it("does not double-prefix Bearer", async () => {
      const client = makeClient("Bearer already-prefixed");
      mockFetch.mockResolvedValueOnce(jsonResponse({ status: "ok" }));

      await client.getHealth();

      const call = mockFetch.mock.calls[0]!;
      const opts = call[1] as RequestInit;
      expect((opts.headers as Record<string, string>)["Authorization"]).toBe("Bearer already-prefixed");
    });
  });

  // -- getAgentCard --

  describe("getAgentCard", () => {
    it("fetches from /.well-known/agent-card.json", async () => {
      const card = { name: "test-agent", skills: [] };
      mockFetch.mockResolvedValueOnce(jsonResponse(card));

      const result = await makeClient().getAgentCard();

      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:8462/.well-known/agent-card.json",
        expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer test-token" }) }),
      );
      expect(result).toEqual(card);
    });

    it("throws on non-ok response", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({}, 404, "Not Found"));

      await expect(makeClient().getAgentCard()).rejects.toThrow("Failed to get agent card: 404 Not Found");
    });
  });

  // -- sendMessage --

  describe("sendMessage", () => {
    it("sends correct JSON-RPC payload", async () => {
      const taskResult = { id: "task-1", status: { state: "completed" } };
      mockFetch.mockResolvedValueOnce(jsonResponse({ jsonrpc: "2.0", id: "1", result: taskResult }));

      const result = await makeClient().sendMessage("Hello");

      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:8462/a2a/jsonrpc",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            "Content-Type": "application/json",
            Authorization: "Bearer test-token",
          }),
        }),
      );

      // Verify payload structure
      const call = mockFetch.mock.calls[0]!;
      const body = JSON.parse((call[1] as RequestInit).body as string);
      expect(body.jsonrpc).toBe("2.0");
      expect(body.method).toBe("message/send");
      expect(body.params.message.role).toBe("user");
      expect(body.params.message.parts[0].text).toBe("Hello");
      expect(body.params.configuration.blocking).toBe(true);

      expect(result).toEqual(taskResult);
    });

    it("includes contextId and taskId when provided", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ jsonrpc: "2.0", id: "1", result: {} }));

      await makeClient().sendMessage("Continue", {
        contextId: "ctx-123",
        taskId: "task-456",
        agent: "code",
      });

      const call = mockFetch.mock.calls[0]!;
      const body = JSON.parse((call[1] as RequestInit).body as string);
      expect(body.params.message.contextId).toBe("ctx-123");
      expect(body.params.message.taskId).toBe("task-456");
      expect(body.params.message.metadata.agent).toBe("code");
    });

    it("omits optional fields when not provided", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ jsonrpc: "2.0", id: "1", result: {} }));

      await makeClient().sendMessage("Hello");

      const call = mockFetch.mock.calls[0]!;
      const body = JSON.parse((call[1] as RequestInit).body as string);
      expect(body.params.message).not.toHaveProperty("contextId");
      expect(body.params.message).not.toHaveProperty("taskId");
      expect(body.params.message.metadata).toEqual({});
    });

    it("throws on HTTP error", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse("Unauthorized", 401, "Unauthorized"));

      await expect(makeClient().sendMessage("Hello")).rejects.toThrow(
        /A2A request failed: 401 Unauthorized/,
      );
    });

    it("throws on JSON-RPC error response", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          jsonrpc: "2.0",
          id: "1",
          error: { code: -32600, message: "Invalid request" },
        }),
      );

      await expect(makeClient().sendMessage("Hello")).rejects.toThrow(
        "A2A error: Invalid request (code: -32600)",
      );
    });
  });

  // -- getHealth --

  describe("getHealth", () => {
    it("fetches from /health", async () => {
      const health = { status: "ok", uptime: 1234 };
      mockFetch.mockResolvedValueOnce(jsonResponse(health));

      const result = await makeClient().getHealth();

      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:8462/health",
        expect.any(Object),
      );
      expect(result).toEqual(health);
    });

    it("throws on non-ok response", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({}, 503, "Service Unavailable"));

      await expect(makeClient().getHealth()).rejects.toThrow("Health check failed: 503");
    });
  });

  // -- listSessions --

  describe("listSessions", () => {
    it("fetches from /admin/sessions", async () => {
      const sessions = { sessions: [], count: 0 };
      mockFetch.mockResolvedValueOnce(jsonResponse(sessions));

      const result = await makeClient().listSessions();

      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:8462/admin/sessions",
        expect.any(Object),
      );
      expect(result).toEqual(sessions);
    });

    it("throws on non-ok response", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({}, 403, "Forbidden"));

      await expect(makeClient().listSessions()).rejects.toThrow("List sessions failed: 403");
    });
  });

  // -- deleteSession --

  describe("deleteSession", () => {
    it("sends DELETE to /admin/sessions/:id", async () => {
      const result = { deleted: true, session_id: "s1" };
      mockFetch.mockResolvedValueOnce(jsonResponse(result));

      const res = await makeClient().deleteSession("s1");

      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:8462/admin/sessions/s1",
        expect.objectContaining({ method: "DELETE" }),
      );
      expect(res).toEqual(result);
    });

    it("throws on non-ok response", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({}, 404, "Not Found"));

      await expect(makeClient().deleteSession("nope")).rejects.toThrow("Delete session failed: 404");
    });
  });
});
