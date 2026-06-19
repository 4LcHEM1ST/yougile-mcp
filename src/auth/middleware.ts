// Express middleware that enforces a valid Google bearer token on protected routes.
//
// On failure it responds per RFC 9728 / the MCP authorization spec with a
// `WWW-Authenticate: Bearer ... resource_metadata="..."` header so MCP clients can
// discover how to authenticate.

import type { NextFunction, Request, Response } from "express";

import type { OAuthConfig } from "../common/config.js";
import { protectedResourceMetadataUrl } from "../common/config.js";
import {
  TokenVerificationError,
  verifyGoogleToken,
  type AuthenticatedUser,
} from "./google.js";

declare module "express-serve-static-core" {
  interface Request {
    user?: AuthenticatedUser;
  }
}

function challenge(config: OAuthConfig, error?: string, description?: string): string {
  const parts = [
    `Bearer realm="yougile-mcp"`,
    `resource_metadata="${protectedResourceMetadataUrl(config.publicUrl)}"`,
  ];
  if (error) parts.push(`error="${error}"`);
  if (description) parts.push(`error_description="${description.replace(/"/g, "'")}"`);
  return parts.join(", ");
}

export function requireGoogleAuth(config: OAuthConfig) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const header = req.headers.authorization;
    if (!header || !header.startsWith("Bearer ")) {
      res
        .status(401)
        .set("WWW-Authenticate", challenge(config))
        .json({ error: "unauthorized", error_description: "Missing bearer token." });
      return;
    }

    const token = header.slice("Bearer ".length).trim();
    try {
      req.user = await verifyGoogleToken(token, config);
      next();
    } catch (err) {
      const description =
        err instanceof TokenVerificationError ? err.message : "Token verification failed.";
      res
        .status(401)
        .set("WWW-Authenticate", challenge(config, "invalid_token", description))
        .json({ error: "invalid_token", error_description: description });
    }
  };
}
