import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";

export interface ServerEntry {
  url: string;
  token: string;
}

export interface ClientConfig {
  servers: Record<string, ServerEntry>;
}

export function loadClientConfig(): ClientConfig {
  const candidates = [
    process.env["CLAUDE_A2A_CLIENT_CONFIG"],
    resolve(homedir(), ".claude-a2a", "client.json"),
    resolve(process.cwd(), "client.json"),
  ];

  for (const path of candidates) {
    if (path && existsSync(path)) {
      const content = readFileSync(path, "utf-8");
      return JSON.parse(content) as ClientConfig;
    }
  }

  return { servers: {} };
}
