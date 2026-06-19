// Verifies tokens issued by Google so this server can act as an MCP Resource Server.
//
// Two token shapes are accepted:
//   1. A Google **ID token** (a JWT) — verified offline against Google's JWKS.
//   2. A Google **access token** (opaque) — verified online via the tokeninfo endpoint.
//
// In both cases the token's audience MUST equal the configured GOOGLE_CLIENT_ID,
// the account email must be verified, and any configured domain/email allowlist
// must match.

import { createRemoteJWKSet, jwtVerify } from "jose";
import axios from "axios";

import type { OAuthConfig } from "../common/config.js";

const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const GOOGLE_TOKENINFO_URL = "https://oauth2.googleapis.com/tokeninfo";
const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"];

export interface AuthenticatedUser {
  /** Stable Google subject identifier. */
  subject: string;
  email?: string;
  /** Raw claims, for logging/debugging. */
  claims: Record<string, unknown>;
}

export class TokenVerificationError extends Error {}

// A single shared remote JWKS that caches/rotates keys internally.
const jwks = createRemoteJWKSet(new URL(GOOGLE_JWKS_URL));

function looksLikeJwt(token: string): boolean {
  return token.split(".").length === 3;
}

function isTruthyClaim(value: unknown): boolean {
  return value === true || value === "true";
}

function applyPolicy(
  config: OAuthConfig,
  email: string | undefined,
  emailVerified: unknown,
  hostedDomain: unknown
): void {
  if (email && !isTruthyClaim(emailVerified)) {
    throw new TokenVerificationError("Google account email is not verified.");
  }

  if (config.allowedDomain) {
    if (hostedDomain !== config.allowedDomain) {
      throw new TokenVerificationError(
        `Account is not in the allowed Google Workspace domain (${config.allowedDomain}).`
      );
    }
  }

  if (config.allowedEmails.length > 0) {
    const normalized = (email ?? "").toLowerCase();
    if (!normalized || !config.allowedEmails.includes(normalized)) {
      throw new TokenVerificationError("Account email is not on the allowlist.");
    }
  }
}

async function verifyIdToken(
  token: string,
  config: OAuthConfig
): Promise<AuthenticatedUser> {
  let payload;
  try {
    ({ payload } = await jwtVerify(token, jwks, {
      issuer: GOOGLE_ISSUERS,
      audience: config.googleClientId,
    }));
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    throw new TokenVerificationError(`Invalid Google ID token: ${message}`);
  }

  applyPolicy(
    config,
    typeof payload.email === "string" ? payload.email : undefined,
    payload.email_verified,
    payload.hd
  );

  if (!payload.sub) {
    throw new TokenVerificationError("Google ID token has no subject.");
  }

  return {
    subject: payload.sub,
    email: typeof payload.email === "string" ? payload.email : undefined,
    claims: payload as Record<string, unknown>,
  };
}

async function verifyAccessToken(
  token: string,
  config: OAuthConfig
): Promise<AuthenticatedUser> {
  let data: Record<string, unknown>;
  try {
    const response = await axios.get(GOOGLE_TOKENINFO_URL, {
      params: { access_token: token },
      timeout: 10000,
      validateStatus: (status) => status === 200,
    });
    data = response.data as Record<string, unknown>;
  } catch {
    throw new TokenVerificationError("Google rejected the access token.");
  }

  // tokeninfo returns `aud` (the client id the token was issued to) and `exp` (epoch seconds).
  if (data.aud !== config.googleClientId) {
    throw new TokenVerificationError("Access token audience does not match this server.");
  }

  const exp = Number(data.exp);
  if (Number.isFinite(exp) && exp * 1000 <= Date.now()) {
    throw new TokenVerificationError("Access token is expired.");
  }

  applyPolicy(
    config,
    typeof data.email === "string" ? data.email : undefined,
    data.email_verified,
    data.hd
  );

  const subject =
    (typeof data.sub === "string" && data.sub) ||
    (typeof data.user_id === "string" && data.user_id) ||
    (typeof data.email === "string" && data.email) ||
    "";
  if (!subject) {
    throw new TokenVerificationError("Access token has no usable subject.");
  }

  return {
    subject,
    email: typeof data.email === "string" ? data.email : undefined,
    claims: data,
  };
}

/** Verify a bearer token (ID token or access token) issued by Google. */
export async function verifyGoogleToken(
  token: string,
  config: OAuthConfig
): Promise<AuthenticatedUser> {
  return looksLikeJwt(token)
    ? verifyIdToken(token, config)
    : verifyAccessToken(token, config);
}
