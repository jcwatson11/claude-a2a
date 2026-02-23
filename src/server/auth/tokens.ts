import jwt from "jsonwebtoken";
import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import type { Config } from "../config.js";
import type { AppDatabase } from "../services/database.js";
import type Database from "better-sqlite3";

export interface TokenClaims {
  sub: string; // client name
  jti: string; // token ID
  scopes: string[]; // which agents
  token_type?: "access" | "refresh";
  budget_daily_usd?: number;
  rate_limit_rpm?: number;
  allowed_models?: string[];
  ephemeral?: boolean;
}

export interface DecodedToken extends TokenClaims {
  iat: number;
  exp: number;
}

// In-memory cache for O(1) revocation checks on every request
let revokedTokens = new Set<string>();
let log: Logger | null = null;

// SQLite prepared statements
let stmtInsert: Database.Statement | null = null;
let stmtSelectAll: Database.Statement | null = null;

/** Initialize the revocation store from SQLite. Call once at startup. */
export function initRevocationStore(appDb: AppDatabase, logger: Logger): void {
  log = logger.child({ component: "revocation-store" });
  stmtInsert = appDb.db.prepare(
    "INSERT OR IGNORE INTO revoked_tokens (jti) VALUES (?)",
  );
  stmtSelectAll = appDb.db.prepare("SELECT jti FROM revoked_tokens");
  loadFromDb();
}

function loadFromDb(): void {
  if (!stmtSelectAll) return;
  try {
    const rows = stmtSelectAll.all() as { jti: string }[];
    revokedTokens = new Set(rows.map((r) => r.jti));
  } catch (err) {
    log?.warn(
      { error: err instanceof Error ? err.message : String(err) },
      "failed to load revocation store, starting fresh",
    );
    revokedTokens = new Set();
  }
}

export function createToken(
  config: Config,
  claims: Omit<TokenClaims, "jti" | "token_type">,
  expiresInHours?: number,
): string {
  const secret = config.auth.jwt.secret;
  if (!secret) {
    throw new Error("JWT secret not configured");
  }

  const jti = randomUUID();
  const expiry = expiresInHours ?? config.auth.jwt.default_expiry_hours;

  return jwt.sign(
    { ...claims, jti, token_type: "access" },
    secret,
    {
      algorithm: config.auth.jwt.algorithm,
      expiresIn: `${expiry}h`,
    },
  );
}

export function createRefreshToken(
  config: Config,
  claims: Omit<TokenClaims, "jti" | "token_type">,
): string {
  const secret = config.auth.jwt.secret;
  if (!secret) {
    throw new Error("JWT secret not configured");
  }

  if (!config.auth.jwt.refresh_enabled) {
    throw new Error("Refresh tokens are not enabled");
  }

  const jti = randomUUID();
  const expiry = config.auth.jwt.refresh_max_expiry_hours;

  return jwt.sign(
    { ...claims, jti, token_type: "refresh" },
    secret,
    {
      algorithm: config.auth.jwt.algorithm,
      expiresIn: `${expiry}h`,
    },
  );
}

export function verifyToken(
  config: Config,
  token: string,
): DecodedToken {
  const secret = config.auth.jwt.secret;
  if (!secret) {
    throw new Error("JWT secret not configured");
  }

  const decoded = jwt.verify(token, secret, {
    algorithms: [config.auth.jwt.algorithm],
  }) as DecodedToken;

  if (revokedTokens.has(decoded.jti)) {
    throw new Error("Token has been revoked");
  }

  return decoded;
}

export function verifyRefreshToken(
  config: Config,
  token: string,
): DecodedToken {
  const decoded = verifyToken(config, token);

  if (decoded.token_type !== "refresh") {
    throw new Error("Token is not a refresh token");
  }

  return decoded;
}

export function revokeToken(jti: string): void {
  revokedTokens.add(jti);
  if (stmtInsert) {
    try {
      stmtInsert.run(jti);
    } catch (err) {
      log?.warn(
        { error: err instanceof Error ? err.message : String(err), jti },
        "failed to persist token revocation",
      );
    }
  }
}

export function isRevoked(jti: string): boolean {
  return revokedTokens.has(jti);
}

export function listRevokedTokens(): string[] {
  return [...revokedTokens];
}

/** Reset state — for testing only. */
export function _resetRevocationStore(): void {
  revokedTokens = new Set();
  log = null;
  stmtInsert = null;
  stmtSelectAll = null;
}
