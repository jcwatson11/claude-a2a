import * as esbuild from "esbuild";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync("package.json", "utf-8"));

const shared = {
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  sourcemap: true,
  external: [
    // Keep node_modules external — they'll be resolved at runtime
    "@a2a-js/sdk",
    "@a2a-js/sdk/server",
    "@a2a-js/sdk/server/express",
    "@a2a-js/sdk/client",
    "@modelcontextprotocol/sdk",
    "@modelcontextprotocol/sdk/server/mcp.js",
    "@modelcontextprotocol/sdk/server/stdio.js",
    "express",
    "jsonwebtoken",
    "pino",
    "yaml",
    "zod",
    "uuid",
    "better-sqlite3",
  ],
  define: {
    __VERSION__: JSON.stringify(pkg.version),
  },
  banner: {
    js: 'import { createRequire } from "module"; const require = createRequire(import.meta.url);',
  },
};

// Server CLI
await esbuild.build({
  ...shared,
  entryPoints: ["src/cli.ts"],
  outfile: "dist/cli.js",
});

// MCP Client
await esbuild.build({
  ...shared,
  entryPoints: ["src/client/index.ts"],
  outfile: "dist/client.js",
});

console.log("Build complete: dist/cli.js, dist/client.js");
