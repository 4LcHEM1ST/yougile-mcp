// OAuth Authorization Server for the MCP server, with Google as upstream identity.
//
// The MCP SDK requires the server to act as an Authorization Server towards the
// client (Claude): Dynamic Client Registration, /authorize, /token and metadata.
// Google does NOT support DCR, so we cannot simply proxy to Google. Instead this
// provider IS the AS for Claude and uses Google only to authenticate the real user.
//
// Flow: authorize() → redirect to Google → /auth/callback exchanges code, extracts
// email, checks allowlist → issues OUR authorization code → /token exchanges it for
// access + refresh tokens.
//
// In-memory storage: sufficient for a single-process deployment. After restart all
// tokens are lost; Claude re-discovers, re-registers, and the user signs in again
// automatically.

import { randomUUID } from "node:crypto";
import axios from "axios";
import type { Response } from "express";

import type { OAuthConfig } from "../common/config.js";

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_ISSUERS = new Set(["https://accounts.google.com", "accounts.google.com"]);

const PENDING_TTL = 10 * 60;
const CODE_TTL = 5 * 60;
const ACCESS_TTL = 60 * 60;
const REFRESH_TTL = 30 * 24 * 60 * 60;
const SWEEP_INTERVAL_MS = 60 * 1000;

const now = (): number => Math.floor(Date.now() / 1000);

// Decode a JWT payload WITHOUT verifying signature — safe here because the id_token
// arrives over the server↔Google back-channel (TLS), not from the client.
function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const part = jwt.split(".")[1];
  if (!part) throw new Error("malformed id_token");
  const json = Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
  return JSON.parse(json) as Record<string, unknown>;
}

interface ClientRecord {
  client_id: string;
  client_id_issued_at: number;
  [key: string]: unknown;
}

interface PendingFlow {
  client: ClientRecord;
  params: AuthorizationParams;
  expiresAt: number;
}

interface CodeRecord {
  client: ClientRecord;
  params: AuthorizationParams;
  email: string;
  expiresAt: number;
}

interface TokenRecord {
  clientId: string;
  scopes: string[];
  email: string;
  expiresAt: number;
}

interface AuthorizationParams {
  redirectUri: string;
  codeChallenge: string;
  scopes?: string[];
  state?: string;
  resource?: string;
}

class InMemoryClientsStore {
  private clients = new Map<string, ClientRecord>();

  getClient(clientId: string): ClientRecord | undefined {
    return this.clients.get(clientId);
  }

  registerClient(client: Record<string, unknown>): ClientRecord {
    const clientId = randomUUID();
    const full: ClientRecord = {
      ...client,
      client_id: clientId,
      client_id_issued_at: now(),
    };
    this.clients.set(clientId, full);
    return full;
  }
}

export class GoogleOAuthProvider {
  readonly clientsStore: InMemoryClientsStore;
  private readonly allowed: Set<string>;
  private readonly allowedDomain?: string;
  private readonly redirectUri: string;
  private readonly _pending = new Map<string, PendingFlow>();
  private readonly _codes = new Map<string, CodeRecord>();
  private readonly _tokens = new Map<string, TokenRecord>();
  private readonly _refresh = new Map<string, TokenRecord>();
  private readonly _sweepTimer: ReturnType<typeof setInterval>;

  constructor(private readonly cfg: OAuthConfig) {
    this.allowed = new Set(cfg.allowedEmails.map((e) => e.trim().toLowerCase()));
    this.allowedDomain = cfg.allowedDomain?.trim().toLowerCase() || undefined;
    this.redirectUri = `${cfg.publicUrl}/auth/callback`;
    this.clientsStore = new InMemoryClientsStore();

    this._sweepTimer = setInterval(() => this._sweep(), SWEEP_INTERVAL_MS);
    if (typeof this._sweepTimer.unref === "function") this._sweepTimer.unref();
  }

  private _sweep(): void {
    const t = now();
    for (const map of [this._pending, this._codes, this._tokens, this._refresh]) {
      for (const [key, val] of map) {
        if (val.expiresAt <= t) map.delete(key);
      }
    }
  }

  private _identityFromIdToken(idToken: string): { email: string; hd?: string } {
    const claims = decodeJwtPayload(idToken);
    if (!GOOGLE_ISSUERS.has(claims.iss as string)) throw new Error("id_token: unexpected issuer");
    if (claims.aud !== this.cfg.googleClientId) throw new Error("id_token: aud mismatch");
    if (typeof claims.exp !== "number" || claims.exp <= now()) throw new Error("id_token expired");
    if (claims.email_verified !== true && claims.email_verified !== "true") {
      throw new Error("id_token: email not verified");
    }
    const email = ((claims.email as string) || "").trim().toLowerCase();
    const hd = typeof claims.hd === "string" ? claims.hd.trim().toLowerCase() : undefined;
    return { email, hd };
  }

  // Access policy: allowed if the email is on the explicit allowlist, OR it belongs
  // to the configured Workspace domain. For the domain path the `hd` claim must also
  // match when available (proves the account is managed by that domain, not just a
  // vanity address). Re-evaluated on every refresh and access-token check, so removing
  // a user/domain revokes access immediately.
  private _isAllowed(email: string, hd?: string): boolean {
    if (!email) return false;
    if (this.allowed.has(email)) return true;
    if (this.allowedDomain) {
      const domain = email.slice(email.lastIndexOf("@") + 1);
      const domainOk = domain === this.allowedDomain;
      const hdOk = hd === undefined || hd === this.allowedDomain;
      return domainOk && hdOk;
    }
    return false;
  }

  private _issueTokens(clientId: string, scopes: string[], email: string) {
    const accessToken = randomUUID();
    const refreshToken = randomUUID();
    this._tokens.set(accessToken, { clientId, scopes, email, expiresAt: now() + ACCESS_TTL });
    this._refresh.set(refreshToken, { clientId, scopes, email, expiresAt: now() + REFRESH_TTL });
    return {
      access_token: accessToken,
      token_type: "bearer" as const,
      expires_in: ACCESS_TTL,
      refresh_token: refreshToken,
      scope: scopes.join(" "),
    };
  }

  async authorize(client: ClientRecord, params: AuthorizationParams, res: Response): Promise<void> {
    const googleState = randomUUID();
    this._pending.set(googleState, { client, params, expiresAt: now() + PENDING_TTL });

    const url = new URL(GOOGLE_AUTH_URL);
    url.searchParams.set("client_id", this.cfg.googleClientId);
    url.searchParams.set("redirect_uri", this.redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", "openid email");
    url.searchParams.set("state", googleState);
    url.searchParams.set("access_type", "online");
    url.searchParams.set("prompt", "select_account");
    res.redirect(url.toString());
  }

  async handleGoogleCallback(
    query: Record<string, string>
  ): Promise<{ redirectUrl: string } | { error: "forbidden"; email: string }> {
    const { code, state, error: googleError } = query;
    if (googleError) throw new Error(`Google returned an error: ${googleError}`);
    if (!code || !state) throw new Error("missing code/state params in callback");

    const pending = this._pending.get(state);
    if (!pending || pending.expiresAt <= now()) throw new Error("unknown or expired state");
    this._pending.delete(state);

    const body = new URLSearchParams({
      code,
      client_id: this.cfg.googleClientId,
      client_secret: this.cfg.googleClientSecret,
      redirect_uri: this.redirectUri,
      grant_type: "authorization_code",
    });

    const resp = await axios.post<{ id_token?: string }>(GOOGLE_TOKEN_URL, body.toString(), {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      timeout: 15000,
    });

    const idToken = resp.data?.id_token;
    if (!idToken) throw new Error("Google did not return an id_token");

    const { email, hd } = this._identityFromIdToken(idToken);

    if (!this._isAllowed(email, hd)) {
      return { error: "forbidden", email };
    }

    const { client, params } = pending;
    const ourCode = randomUUID();
    this._codes.set(ourCode, { client, params, email, expiresAt: now() + CODE_TTL });

    const redirectUrl = new URL(params.redirectUri);
    redirectUrl.searchParams.set("code", ourCode);
    if (params.state !== undefined) redirectUrl.searchParams.set("state", params.state);
    return { redirectUrl: redirectUrl.toString() };
  }

  async challengeForAuthorizationCode(client: ClientRecord, authorizationCode: string): Promise<string> {
    const data = this._codes.get(authorizationCode);
    if (!data || data.expiresAt <= now() || data.client.client_id !== client.client_id) {
      throw new Error("invalid authorization code");
    }
    return data.params.codeChallenge;
  }

  async exchangeAuthorizationCode(client: ClientRecord, authorizationCode: string) {
    const data = this._codes.get(authorizationCode);
    if (!data || data.expiresAt <= now() || data.client.client_id !== client.client_id) {
      throw new Error("invalid authorization code");
    }
    this._codes.delete(authorizationCode);
    return this._issueTokens(client.client_id, data.params.scopes ?? [], data.email);
  }

  async exchangeRefreshToken(client: ClientRecord, refreshToken: string) {
    const data = this._refresh.get(refreshToken);
    if (!data || data.expiresAt <= now() || data.clientId !== client.client_id) {
      throw new Error("invalid refresh token");
    }
    if (!this._isAllowed(data.email)) {
      this._refresh.delete(refreshToken);
      throw new Error("account no longer authorized");
    }
    this._refresh.delete(refreshToken);
    return this._issueTokens(client.client_id, data.scopes, data.email);
  }

  async verifyAccessToken(token: string) {
    const data = this._tokens.get(token);
    if (!data) throw new Error("invalid token");
    if (data.expiresAt <= now()) {
      this._tokens.delete(token);
      throw new Error("token expired");
    }
    if (!this._isAllowed(data.email)) {
      this._tokens.delete(token);
      throw new Error("account no longer authorized");
    }
    return {
      token,
      clientId: data.clientId,
      scopes: data.scopes,
      expiresAt: data.expiresAt,
      extra: { email: data.email },
    };
  }
}
