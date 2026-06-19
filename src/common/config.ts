// Centralized configuration for the HTTP/OAuth deployment of the MCP server.
// All values are read from environment variables (see .env.example).

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(
      `Environment variable ${name} is required for the HTTP/OAuth server but is not set.`
    );
  }
  return value.trim();
}

function optional(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim() !== "" ? value.trim() : undefined;
}

function list(name: string): string[] {
  const value = optional(name);
  if (!value) return [];
  return value
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export interface OAuthConfig {
  /** Public base URL of THIS MCP server, used as the OAuth resource identifier. */
  publicUrl: string;
  /** Google OAuth client ID — used as `aud` when verifying Google id_tokens. */
  googleClientId: string;
  /** Google OAuth client secret — required for the authorization code exchange with Google. */
  googleClientSecret: string;
  /** Optional Google Workspace hosted domain (`hd` claim) the user must belong to. */
  allowedDomain?: string;
  /** Allowlist of permitted user emails (lowercased). */
  allowedEmails: string[];
}

export interface ServerConfig {
  port: number;
  host: string;
  oauth: OAuthConfig;
}

/** Build and validate the HTTP-server configuration. Throws if anything required is missing. */
export function loadServerConfig(): ServerConfig {
  const port = Number(optional("MCP_PORT") ?? "3000");
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`MCP_PORT must be a valid TCP port, got: ${process.env.MCP_PORT}`);
  }

  const publicUrl = required("MCP_PUBLIC_URL").replace(/\/+$/, "");

  const allowedDomain = optional("GOOGLE_ALLOWED_DOMAIN")?.toLowerCase();
  const allowedEmails = list("GOOGLE_ALLOWED_EMAILS");

  // Access is deny-by-default: without at least one restriction, ANY verified Google
  // account on the internet could reach the shared YouGile workspace. Fail fast so the
  // misconfiguration surfaces at startup instead of as confusing 403s for everyone.
  if (allowedEmails.length === 0 && !allowedDomain) {
    throw new Error(
      "Access control is not configured: set GOOGLE_ALLOWED_EMAILS and/or GOOGLE_ALLOWED_DOMAIN " +
        "to restrict who may sign in."
    );
  }

  return {
    port,
    host: optional("MCP_HOST") ?? "0.0.0.0",
    oauth: {
      publicUrl,
      googleClientId: required("GOOGLE_CLIENT_ID"),
      googleClientSecret: required("GOOGLE_CLIENT_SECRET"),
      allowedDomain,
      allowedEmails,
    },
  };
}
