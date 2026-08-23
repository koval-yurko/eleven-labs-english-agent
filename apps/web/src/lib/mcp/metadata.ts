/**
 * RFC 9728 Protected Resource Metadata for `/api/mcp` — the document that makes the server
 * discoverable, and the field an MCP client is strictest about.
 *
 * `resource` MUST be the canonical URI of the MCP server itself. Clients do not treat this as
 * advisory: RFC 9728 has them DISCARD a metadata document whose `resource` does not match the URL
 * they dialled, and Claude Code fails before it even opens a browser
 * (`Protected resource X does not match expected Y`). That is why the value is derived from the
 * request rather than configured — `http://localhost:3000/api/mcp` in dev and the deployed origin
 * in production, both correct with no environment variable to get wrong.
 *
 * Under Option B this value deliberately DIFFERS from the audience the token carries
 * (docs/2026-08-23-mcp-server-add-words.md §11.2). That is the legal half of the split: `resource`
 * and `aud` may differ, `resource` and the server URL may not.
 */
import { generateProtectedResourceMetadata, getPublicUrl } from "mcp-handler";

import { WORDS_WRITE_SCOPE } from "./auth";

/** The MCP endpoint's path — the resource identifier's path component, and the source of the one below. */
export const MCP_PATH = "/api/mcp";

/**
 * Path-suffixed, per RFC 9728 §3.1: a resource with a path gets its metadata at
 * `/.well-known/oauth-protected-resource` + that path, so one origin can host several. Also what
 * the 401's `WWW-Authenticate: resource_metadata=…` points at, which is why both sides import this
 * constant instead of writing the string twice.
 */
export const MCP_RESOURCE_METADATA_PATH = `/.well-known/oauth-protected-resource${MCP_PATH}`;

/** The canonical resource URI, from the PUBLIC origin — `getPublicUrl` reads the proxy headers a deployment sets. */
export function mcpResourceUrl(req: Request): string {
  const url = getPublicUrl(req);
  url.pathname = MCP_PATH;
  url.search = "";
  url.hash = "";
  return url.toString();
}

export function mcpProtectedResourceMetadata(req: Request) {
  const domain = process.env.AUTH0_DOMAIN?.trim();
  // Fail closed, loudly: a document listing no authorization server is invalid per the MCP spec
  // ("MUST include at least one"), and serving an invalid one is worse than serving none.
  if (!domain) throw new Error("AUTH0_DOMAIN is not set; /api/mcp cannot advertise an issuer.");

  return generateProtectedResourceMetadata({
    // The trailing slash is Auth0's `iss` verbatim. RFC 9728 §7.6 has the client match this against
    // the issuer it discovers, so it has to be the same string the tokens carry.
    authServerUrls: [`https://${domain}/`],
    resourceUrl: mcpResourceUrl(req),
    additionalMetadata: {
      // How a client learns to ask for the scope. Advertised in S1, enforced in S2 (see auth.ts).
      scopes_supported: [WORDS_WRITE_SCOPE],
      bearer_methods_supported: ["header"],
    },
  });
}
