import type { AgentCard, AgentSkill } from "@a2a-js/sdk";
import type { Config } from "./config.js";

export function buildAgentCard(config: Config): AgentCard {
  const baseUrl = `http://${config.server.host === "0.0.0.0" ? "localhost" : config.server.host}:${config.server.port}`;

  const skills: AgentSkill[] = [];
  for (const [name, agentConfig] of Object.entries(config.agents)) {
    if (!agentConfig.enabled) continue;

    skills.push({
      id: name,
      name: `agent:${name}`,
      description: agentConfig.description,
      tags: [
        "claude",
        ...(agentConfig.model ? [agentConfig.model] : []),
        ...(agentConfig.allowed_tools.length > 0 ? ["tools"] : []),
      ],
      examples: [
        `Send a message to the "${name}" agent`,
      ],
    });
  }

  const securitySchemes: Record<string, Record<string, string>> = {};
  const security: Record<string, string[]>[] = [];

  if (config.auth.master_key) {
    securitySchemes["bearerAuth"] = {
      type: "http",
      scheme: "bearer",
    };
    security.push({ bearerAuth: [] });
  }

  if (config.auth.jwt.secret) {
    securitySchemes["jwtAuth"] = {
      type: "http",
      scheme: "bearer",
      bearerFormat: "JWT",
    };
    security.push({ jwtAuth: [] });
  }

  return {
    name: "claude-a2a",
    description:
      "A2A-compatible server wrapping the Claude CLI for agent-to-agent communication. " +
      "Supports session continuity, budget tracking, and multi-agent configurations.",
    url: `${baseUrl}/a2a/jsonrpc`,
    protocolVersion: "0.3.0",
    version: "0.1.0",
    skills,
    capabilities: {
      streaming: false,
      pushNotifications: false,
      stateTransitionHistory: true,
    },
    defaultInputModes: ["text"],
    defaultOutputModes: ["text"],
    preferredTransport: "JSONRPC",
    additionalInterfaces: [
      { url: `${baseUrl}/a2a/rest`, transport: "HTTP+JSON" },
    ],
    provider: {
      organization: "claude-a2a",
      url: baseUrl,
    },
    ...(security.length > 0
      ? { security, securitySchemes: securitySchemes as AgentCard["securitySchemes"] }
      : {}),
  };
}
