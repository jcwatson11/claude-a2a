import { describe, it, expect, beforeEach } from "vitest";
import { buildAgentCard } from "../../src/server/agent-card.js";
import { loadConfig } from "../../src/server/config.js";
import type { Config } from "../../src/server/config.js";
import { VERSION } from "../../src/version.js";

let config: Config;

beforeEach(() => {
  config = loadConfig("/nonexistent");
});

describe("buildAgentCard", () => {
  // -- URL construction --

  it("replaces 0.0.0.0 with localhost in URL", () => {
    config.server.host = "0.0.0.0";
    config.server.port = 8462;
    const card = buildAgentCard(config);

    expect(card.url).toBe("http://localhost:8462/a2a/jsonrpc");
  });

  it("uses configured host when not 0.0.0.0", () => {
    config.server.host = "192.168.1.10";
    config.server.port = 9000;
    const card = buildAgentCard(config);

    expect(card.url).toBe("http://192.168.1.10:9000/a2a/jsonrpc");
  });

  it("includes REST additional interface with correct URL", () => {
    config.server.host = "localhost";
    config.server.port = 8462;
    const card = buildAgentCard(config);

    expect(card.additionalInterfaces).toEqual([
      { url: "http://localhost:8462/a2a/rest", transport: "HTTP+JSON" },
    ]);
  });

  // -- Skills from agents --

  it("includes only enabled agents as skills", () => {
    // Default config has "general" enabled
    config.agents["code"] = {
      ...config.agents["general"]!,
      description: "Code agent",
      enabled: true,
    };
    config.agents["disabled"] = {
      ...config.agents["general"]!,
      description: "Disabled agent",
      enabled: false,
    };

    const card = buildAgentCard(config);
    const skillIds = card.skills.map((s) => s.id);

    expect(skillIds).toContain("general");
    expect(skillIds).toContain("code");
    expect(skillIds).not.toContain("disabled");
  });

  it("builds skill with correct fields", () => {
    const card = buildAgentCard(config);
    const skill = card.skills.find((s) => s.id === "general")!;

    expect(skill).toBeDefined();
    expect(skill.name).toBe("agent:general");
    expect(skill.description).toBe(config.agents["general"]!.description);
    expect(skill.examples).toEqual(['Send a message to the "general" agent']);
  });

  it("includes model tag when agent has a model", () => {
    config.agents["general"]!.model = "claude-sonnet-4-6";
    const card = buildAgentCard(config);
    const skill = card.skills.find((s) => s.id === "general")!;

    expect(skill.tags).toContain("claude-sonnet-4-6");
    expect(skill.tags).toContain("claude");
  });

  it("omits model tag when agent has no model", () => {
    config.agents["general"]!.model = null;
    const card = buildAgentCard(config);
    const skill = card.skills.find((s) => s.id === "general")!;

    expect(skill.tags).toContain("claude");
    expect(skill.tags).not.toContain(null);
  });

  it("includes tools tag when agent has allowed_tools", () => {
    config.agents["general"]!.allowed_tools = ["Read(*)", "Write(*)"];
    const card = buildAgentCard(config);
    const skill = card.skills.find((s) => s.id === "general")!;

    expect(skill.tags).toContain("tools");
  });

  it("omits tools tag when agent has no allowed_tools", () => {
    config.agents["general"]!.allowed_tools = [];
    const card = buildAgentCard(config);
    const skill = card.skills.find((s) => s.id === "general")!;

    expect(skill.tags).not.toContain("tools");
  });

  // -- Security schemes --

  it("includes bearerAuth when master_key is set", () => {
    config.auth.master_key = "secret-key";
    config.auth.jwt.secret = null;
    const card = buildAgentCard(config);

    expect(card.securitySchemes).toEqual({
      bearerAuth: { type: "http", scheme: "bearer" },
    });
    expect(card.security).toEqual([{ bearerAuth: [] }]);
  });

  it("includes jwtAuth when jwt.secret is set", () => {
    config.auth.master_key = null;
    config.auth.jwt.secret = "jwt-secret";
    const card = buildAgentCard(config);

    expect(card.securitySchemes).toEqual({
      jwtAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
    });
    expect(card.security).toEqual([{ jwtAuth: [] }]);
  });

  it("includes both schemes when both are configured", () => {
    config.auth.master_key = "master";
    config.auth.jwt.secret = "jwt";
    const card = buildAgentCard(config);

    expect(card.securitySchemes).toHaveProperty("bearerAuth");
    expect(card.securitySchemes).toHaveProperty("jwtAuth");
    expect(card.security).toHaveLength(2);
  });

  it("omits security fields when no auth is configured", () => {
    config.auth.master_key = null;
    config.auth.jwt.secret = null;
    const card = buildAgentCard(config);

    expect(card.security).toBeUndefined();
    expect(card.securitySchemes).toBeUndefined();
  });

  // -- Static fields --

  it("includes correct static metadata", () => {
    const card = buildAgentCard(config);

    expect(card.name).toBe("claude-a2a");
    expect(card.version).toBe(VERSION);
    expect(card.protocolVersion).toBe("0.3.0");
    expect(card.preferredTransport).toBe("JSONRPC");
    expect(card.defaultInputModes).toEqual(["text", "image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf"]);
    expect(card.defaultOutputModes).toEqual(["text"]);
    expect(card.capabilities).toEqual({
      streaming: false,
      pushNotifications: false,
      stateTransitionHistory: true,
    });
  });
});
