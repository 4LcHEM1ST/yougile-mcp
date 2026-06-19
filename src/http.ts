#!/usr/bin/env node
// Remote HTTP entry point: serves the YouGile MCP server over Streamable HTTP,
// protected by a full Google OAuth 2.0 Authorization Code flow.
//
// Run with:  node build/http.js   (after `npm run build`)
// Requires:  YOUGILE_API_KEY, MCP_PUBLIC_URL, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET
// See .env.example for all variables.
//
// When adding this server to Claude.ai, use the public URL root as the connector URL.

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import express, { type Request, type Response } from "express";
import cors from "cors";
import dotenv from "dotenv";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

import { createServer } from "./server.js";
import { loadServerConfig } from "./common/config.js";
import { GoogleOAuthProvider } from "./auth/oauth-provider.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: join(__dirname, "..", ".env"), quiet: true });

/** Escape text for safe interpolation into HTML, preventing reflected XSS. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

if (!process.env.YOUGILE_API_KEY) {
  console.error("Error: YOUGILE_API_KEY environment variable is not set.");
  console.error("Please add YOUGILE_API_KEY to your .env file or environment.");
  process.exit(1);
}

let config;
try {
  config = loadServerConfig();
} catch (error) {
  console.error("Configuration error:", error instanceof Error ? error.message : error);
  process.exit(1);
}

const provider = new GoogleOAuthProvider(config.oauth);
const baseUrl = new URL(config.oauth.publicUrl);
const resourceMetadataUrl = new URL("/.well-known/oauth-protected-resource", baseUrl).href;

const app = express();
app.set("trust proxy", true);
app.use(
  cors({
    origin: true,
    exposedHeaders: ["Mcp-Session-Id", "WWW-Authenticate"],
    allowedHeaders: ["Content-Type", "Authorization", "Mcp-Session-Id", "Mcp-Protocol-Version"],
  })
);
app.use(express.json({ limit: "4mb" }));

// --- Public endpoints -------------------------------------------------------

app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok" });
});

// --- OAuth Authorization Server endpoints ----------------------------------
// Mounts: /.well-known/oauth-authorization-server, /.well-known/oauth-protected-resource,
//         /authorize, /token, /register
app.use(
  mcpAuthRouter({
    provider,
    issuerUrl: baseUrl,
    baseUrl,
    resourceServerUrl: baseUrl,
    scopesSupported: ["openid", "email"],
    resourceName: "YouGile MCP",
  })
);

// --- Google callback (browser returns here after Google consent) ------------
app.get("/auth/callback", async (req: Request, res: Response) => {
  try {
    const result = await provider.handleGoogleCallback(
      req.query as Record<string, string>
    );
    if ("error" in result && result.error === "forbidden") {
      const who = result.email ? ` (${escapeHtml(result.email)})` : "";
      return res
        .status(403)
        .type("html")
        .send(
          `<!doctype html><html lang="ru"><meta charset="utf-8">
<title>Доступ запрещён</title>
<body style="font-family:system-ui;max-width:32rem;margin:4rem auto;line-height:1.5">
<h1>Доступ запрещён</h1>
<p>Ваш Google-аккаунт${who} не включён в список разрешённых адресов этого MCP-сервера.</p>
<p>Попросите администратора добавить ваш email в <code>GOOGLE_ALLOWED_EMAILS</code>.</p>
</body></html>`
        );
    }
    return res.redirect((result as { redirectUrl: string }).redirectUrl);
  } catch (err) {
    // Log details server-side; never reflect raw error text (may contain attacker-
    // controlled query params) into the HTML response.
    console.error("OAuth callback error:", err);
    return res
      .status(400)
      .type("html")
      .send(
        `<!doctype html><html lang="ru"><meta charset="utf-8">
<title>Ошибка аутентификации</title>
<body style="font-family:system-ui;max-width:32rem;margin:4rem auto;line-height:1.5">
<h1>Ошибка аутентификации</h1>
<p>Не удалось завершить вход через Google. Попробуйте ещё раз.</p>
</body></html>`
      );
  }
});

// --- Protected MCP endpoint (root) -----------------------------------------

const bearer = requireBearerAuth({ verifier: provider, resourceMetadataUrl });

// Stateless: fresh McpServer + transport per request, no cross-user state.
app.post("/", bearer, async (req: Request, res: Response) => {
  try {
    const { server } = createServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error("Error handling MCP request:", error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

function methodNotAllowed(_req: Request, res: Response): void {
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed (stateless server)." },
    id: null,
  });
}
app.get("/", bearer, methodNotAllowed);
app.delete("/", bearer, methodNotAllowed);

app.listen(config.port, config.host, () => {
  console.error(`YouGile MCP server (HTTP) listening on ${config.host}:${config.port}`);
  console.error(`Public URL (use as Claude.ai connector URL): ${config.oauth.publicUrl}`);
});
