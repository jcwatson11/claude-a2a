import { describe, it, expect } from "vitest";
import { createMcpServer } from "../../src/client/mcp-server.js";

describe("MCP Server", () => {
  it("creates server with tools", () => {
    const server = createMcpServer({
      servers: {
        test: { url: "http://localhost:8462", token: "Bearer test-token" },
      },
    });

    expect(server).toBeDefined();
  });

  it("handles empty config", () => {
    const server = createMcpServer({ servers: {} });
    expect(server).toBeDefined();
  });
});
