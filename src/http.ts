#!/usr/bin/env node
// Remote HTTP entry point: serves the YouGile MCP server over Streamable HTTP,
// protected by Google OAuth (this process acts as an MCP Resource Server).
//
// Run with:  node build/http.js   (after `npm run build`)
// Requires:  YOUGILE_API_KEY, MCP_PUBLIC_URL, GOOGLE_CLIENT_ID  (see .env.example)

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { type Request, type Response } from "express";
import dotenv from "dotenv";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

import { createServer } from "./server.js";
import {
  loadServerConfig,
  protectedResourceMetadataUrl,
  type ServerConfig,
} from "./common/config.js";
import { requireGoogleAuth } from "./auth/middleware.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: join(__dirname, "..", ".env"), quiet: true });

if (!process.env.YOUGILE_API_KEY) {
  console.error("Error: YOUGILE_API_KEY environment variable is not set.");
  console.error("Please add YOUGILE_API_KEY to your .env file or environment.");
  process.exit(1);
}

let config: ServerConfig;
try {
  config = loadServerConfig();
} catch (error) {
  console.error("Configuration error:", error instanceof Error ? error.message : error);
  process.exit(1);
}

const app = express();
// We sit behind a reverse proxy on the remote host; trust it for correct protocol/host.
app.set("trust proxy", true);
app.use(express.json({ limit: "4mb" }));

// --- Public discovery endpoints (no auth) ---------------------------------

// RFC 9728 Protected Resource Metadata: tells MCP clients which Authorization
// Server (Google) issues tokens for this resource.
app.get("/.well-known/oauth-protected-resource", (_req: Request, res: Response) => {
  res.json({
    resource: config.oauth.publicUrl,
    authorization_servers: ["https://accounts.google.com"],
    scopes_supported: ["openid", "email", "profile"],
    bearer_methods_supported: ["header"],
  });
});

// Convenience: point clients at Google's OpenID configuration.
app.get("/.well-known/oauth-authorization-server", (_req: Request, res: Response) => {
  res.redirect(302, "https://accounts.google.com/.well-known/openid-configuration");
});

app.get("/healthz", (_req: Request, res: Response) => {
  res.json({ status: "ok" });
});

// --- Protected MCP endpoint -----------------------------------------------

const auth = requireGoogleAuth(config.oauth);

// Stateless: each request gets its own server + transport, so there is no
// cross-user session state to leak on a multi-user remote deployment.
app.post("/mcp", auth, async (req: Request, res: Response) => {
  try {
    const { server } = createServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

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

// Streamable HTTP GET (SSE) / DELETE (session teardown) are not used in
// stateless mode.
function methodNotAllowed(_req: Request, res: Response): void {
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed (stateless server)." },
    id: null,
  });
}
app.get("/mcp", auth, methodNotAllowed);
app.delete("/mcp", auth, methodNotAllowed);

app.listen(config.port, () => {
  console.error(`YouGile MCP server (HTTP) listening on port ${config.port}`);
  console.error(`Resource: ${config.oauth.publicUrl}`);
  console.error(`Metadata: ${protectedResourceMetadataUrl(config.oauth.publicUrl)}`);
});
