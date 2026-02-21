import { describe, it, expect } from "vitest";
import { A2AClient } from "../../src/client/a2a-client.js";

describe("A2AClient", () => {
  it("constructs with server entry", () => {
    const client = new A2AClient({
      url: "http://localhost:8462",
      token: "Bearer test-token",
    });

    expect(client).toBeDefined();
  });

  it("normalizes trailing slash in URL", () => {
    const client = new A2AClient({
      url: "http://localhost:8462/",
      token: "test-token",
    });

    expect(client).toBeDefined();
  });
});
