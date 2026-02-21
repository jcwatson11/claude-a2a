import jwt from "jsonwebtoken";
import { randomUUID } from "node:crypto";
import type { Config } from "../config.js";

export interface TokenClaims {
  sub: string; // client name
  jti: string; // token ID
  scopes: string[]; // which agents
  budget_daily_usd?: number;
  rate_limit_rpm?: number;
  allowed_models?: string[];
  ephemeral?: boolean;
}

export interface DecodedToken extends TokenClaims {
  iat: number;
  exp: number;
}

const revokedTokens = new Set<string>();

export function createToken(
  config: Config,
  claims: Omit<TokenClaims, "jti">,
  expiresInHours?: number,
): string {
  const secret = config.auth.jwt.secret;
  if (!secret) {
    throw new Error("JWT secret not configured");
  }

  const jti = randomUUID();
  const expiry = expiresInHours ?? config.auth.jwt.default_expiry_hours;

  return jwt.sign(
    { ...claims, jti },
    secret,
    {
      algorithm: config.auth.jwt.algorithm as jwt.Algorithm,
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
    algorithms: [config.auth.jwt.algorithm as jwt.Algorithm],
  }) as DecodedToken;

  if (revokedTokens.has(decoded.jti)) {
    throw new Error("Token has been revoked");
  }

  return decoded;
}

export function revokeToken(jti: string): void {
  revokedTokens.add(jti);
}

export function isRevoked(jti: string): boolean {
  return revokedTokens.has(jti);
}

export function listRevokedTokens(): string[] {
  return [...revokedTokens];
}
