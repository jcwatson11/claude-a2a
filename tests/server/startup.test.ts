import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";
import { checkClaudeBinary, requestTimeoutMiddleware, requestIdMiddleware } from "../../src/server/index.js";
import type { Request, Response, NextFunction } from "express";

describe("checkClaudeBinary", () => {
  it("returns ok with version for a valid binary", () => {
    // "node" is always available in the test environment
    const result = checkClaudeBinary("node");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.version).toBeTruthy();
    }
  });

  it("returns not ok for a nonexistent binary", () => {
    const result = checkClaudeBinary("/nonexistent/binary");
    expect(result.ok).toBe(false);
  });
});

describe("requestTimeoutMiddleware", () => {
  it("calls next and sets timeout on the request", () => {
    const middleware = requestTimeoutMiddleware(30);

    let timeoutMs = 0;
    const req = {
      setTimeout: (ms: number, _cb: () => void) => { timeoutMs = ms; },
    } as unknown as Request;
    const res = {} as Response;
    let nextCalled = false;

    middleware(req, res, () => { nextCalled = true; });

    expect(nextCalled).toBe(true);
    expect(timeoutMs).toBe(30_000);
  });

  it("sends 408 when timeout fires and headers not yet sent", () => {
    const middleware = requestTimeoutMiddleware(1);

    let timeoutCallback: (() => void) | undefined;
    const req = {
      setTimeout: (_ms: number, cb: () => void) => { timeoutCallback = cb; },
    } as unknown as Request;

    let statusCode = 0;
    let body: unknown;
    const res = {
      headersSent: false,
      status: (code: number) => {
        statusCode = code;
        return { json: (data: unknown) => { body = data; } };
      },
    } as unknown as Response;

    middleware(req, res, () => {});

    // Simulate the timeout firing
    expect(timeoutCallback).toBeDefined();
    timeoutCallback!();

    expect(statusCode).toBe(408);
    expect(body).toEqual({ error: "Request timeout" });
  });

  it("does not send response if headers already sent", () => {
    const middleware = requestTimeoutMiddleware(1);

    let timeoutCallback: (() => void) | undefined;
    const req = {
      setTimeout: (_ms: number, cb: () => void) => { timeoutCallback = cb; },
    } as unknown as Request;

    let statusCalled = false;
    const res = {
      headersSent: true,
      status: () => { statusCalled = true; return { json: () => {} }; },
    } as unknown as Response;

    middleware(req, res, () => {});
    timeoutCallback!();

    expect(statusCalled).toBe(false);
  });
});

describe("requestIdMiddleware", () => {
  it("generates a UUID when no X-Request-ID header is provided", () => {
    const middleware = requestIdMiddleware();

    const headers: Record<string, string> = {};
    const req = { headers: {} } as unknown as Request;
    const res = {
      setHeader: (k: string, v: string) => { headers[k] = v; },
    } as unknown as Response;
    let nextCalled = false;

    middleware(req, res, () => { nextCalled = true; });

    expect(nextCalled).toBe(true);
    expect(req.requestId).toBeTruthy();
    expect(req.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(headers["X-Request-ID"]).toBe(req.requestId);
  });

  it("uses existing X-Request-ID header when provided", () => {
    const middleware = requestIdMiddleware();

    const headers: Record<string, string> = {};
    const req = {
      headers: { "x-request-id": "client-provided-id" },
    } as unknown as Request;
    const res = {
      setHeader: (k: string, v: string) => { headers[k] = v; },
    } as unknown as Response;

    middleware(req, res, () => {});

    expect(req.requestId).toBe("client-provided-id");
    expect(headers["X-Request-ID"]).toBe("client-provided-id");
  });

  it("echoes the ID back in the response header", () => {
    const middleware = requestIdMiddleware();

    const responseHeaders: Record<string, string> = {};
    const req = { headers: {} } as unknown as Request;
    const res = {
      setHeader: (k: string, v: string) => { responseHeaders[k] = v; },
    } as unknown as Response;

    middleware(req, res, () => {});

    expect(responseHeaders["X-Request-ID"]).toBe(req.requestId);
  });

  it("rejects X-Request-ID with control characters", () => {
    const middleware = requestIdMiddleware();

    const req = {
      headers: { "x-request-id": "bad\nid\r\ninjection" },
    } as unknown as Request;
    const res = { setHeader: () => {} } as unknown as Response;

    middleware(req, res, () => {});

    expect(req.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it("rejects X-Request-ID exceeding 128 characters", () => {
    const middleware = requestIdMiddleware();

    const req = {
      headers: { "x-request-id": "a".repeat(129) },
    } as unknown as Request;
    const res = { setHeader: () => {} } as unknown as Response;

    middleware(req, res, () => {});

    expect(req.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it("accepts X-Request-ID with valid characters", () => {
    const middleware = requestIdMiddleware();

    const validId = "req_abc-123.456";
    const req = {
      headers: { "x-request-id": validId },
    } as unknown as Request;
    const res = { setHeader: () => {} } as unknown as Response;

    middleware(req, res, () => {});

    expect(req.requestId).toBe(validId);
  });
});

describe("max_body_size", () => {
  const app = express();
  app.use(express.json({ limit: "1kb" }));
  app.post("/test", (_req, res) => { res.json({ ok: true }); });

  it("rejects request bodies exceeding the configured limit", async () => {
    await request(app)
      .post("/test")
      .send({ data: "x".repeat(2000) })
      .expect(413);
  });

  it("accepts request bodies within the configured limit", async () => {
    await request(app)
      .post("/test")
      .send({ data: "hello" })
      .expect(200);
  });
});
