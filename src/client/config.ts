import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { z } from "zod";

const ServerEntrySchema = z.object({
  url: z.string().url(),
  token: z.string(),
});

const ClientConfigSchema = z.object({
  servers: z.record(z.string(), ServerEntrySchema).default({}),
});

export type ServerEntry = z.infer<typeof ServerEntrySchema>;
export type ClientConfig = z.infer<typeof ClientConfigSchema>;

export function loadClientConfig(): ClientConfig {
  const candidates = [
    process.env["CLAUDE_A2A_CLIENT_CONFIG"],
    resolve(homedir(), ".claude-a2a", "client.json"),
    resolve(process.cwd(), "client.json"),
  ];

  for (const path of candidates) {
    if (path && existsSync(path)) {
      const content = readFileSync(path, "utf-8");
      const parsed: unknown = JSON.parse(content);
      return ClientConfigSchema.parse(parsed);
    }
  }

  return { servers: {} };
}
