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
  /** Public base URL of THIS MCP server, used as the OAuth "resource" identifier. */
  publicUrl: string;
  /** Google OAuth client ID — the expected `aud` of incoming tokens. */
  googleClientId: string;
  /** Optional Google Workspace hosted domain (`hd` claim) the user must belong to. */
  allowedDomain?: string;
  /** Optional explicit allowlist of user emails (lowercased). Empty = any verified Google account. */
  allowedEmails: string[];
}

export interface ServerConfig {
  port: number;
  oauth: OAuthConfig;
}

/** Build and validate the HTTP-server configuration. Throws if anything required is missing. */
export function loadServerConfig(): ServerConfig {
  const port = Number(optional("MCP_PORT") ?? "3000");
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`MCP_PORT must be a valid TCP port, got: ${process.env.MCP_PORT}`);
  }

  const publicUrl = required("MCP_PUBLIC_URL").replace(/\/+$/, "");

  return {
    port,
    oauth: {
      publicUrl,
      googleClientId: required("GOOGLE_CLIENT_ID"),
      allowedDomain: optional("GOOGLE_ALLOWED_DOMAIN"),
      allowedEmails: list("GOOGLE_ALLOWED_EMAILS"),
    },
  };
}

/** URL of this server's RFC 9728 Protected Resource Metadata document. */
export function protectedResourceMetadataUrl(publicUrl: string): string {
  return `${publicUrl}/.well-known/oauth-protected-resource`;
}
