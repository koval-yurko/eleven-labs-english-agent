/**
 * RFC 9728 Protected Resource Metadata for `/api/mcp` — the document that makes the server
 * discoverable, and the field an MCP client is strictest about.
 *
 * `resource` MUST be the canonical URI of the MCP server itself. Clients do not treat this as
 * advisory: RFC 9728 has them DISCARD a metadata document whose `resource` does not match the URL
 * they dialled, and Claude Code fails before it even opens a browser
 * (`Protected resource X does not match expected Y`).
 *
 * Under Option A the same string is ALSO the Auth0 API identifier, and therefore the `aud` of every
 * token this server accepts (docs/2026-08-23-mcp-server-add-words.md §11.6). It is read from
 * `MCP_RESOURCE_URL` rather than derived from the request precisely because of that second role: an
 * audience must be a fixed value the server was configured with, never one reconstructed from
 * `Host` or `X-Forwarded-Host`, which are attacker-supplied.
 */
import { generateProtectedResourceMetadata } from "mcp-handler";

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

/**
 * The canonical resource URI: `MCP_RESOURCE_URL`, checked rather than trusted.
 *
 * The path assertion is not pedantry. A value whose path is not `/api/mcp` produces a document
 * every client silently discards, and the symptom — "the connector just won't authorize" — points
 * nowhere near the environment variable. One `throw` at the point of use turns that into a message.
 */
export function mcpResourceUrl(): string {
  const configured = process.env.MCP_RESOURCE_URL?.trim();
  if (!configured) throw new Error("MCP_RESOURCE_URL is not set; /api/mcp has no identity.");

  const url = new URL(configured);
  if (url.pathname !== MCP_PATH || url.search || url.hash) {
    throw new Error(`MCP_RESOURCE_URL must be an origin plus exactly ${MCP_PATH}; got ${configured}`);
  }
  return url.toString();
}

export function mcpProtectedResourceMetadata() {
  const domain = process.env.AUTH0_DOMAIN?.trim();
  // Fail closed, loudly: a document listing no authorization server is invalid per the MCP spec
  // ("MUST include at least one"), and serving an invalid one is worse than serving none.
  if (!domain) throw new Error("AUTH0_DOMAIN is not set; /api/mcp cannot advertise an issuer.");

  return generateProtectedResourceMetadata({
    // The trailing slash is Auth0's `iss` verbatim. RFC 9728 §7.6 has the client match this against
    // the issuer it discovers, so it has to be the same string the tokens carry.
    authServerUrls: [`https://${domain}/`],
    resourceUrl: mcpResourceUrl(),
    additionalMetadata: {
      // How a client learns to ask for the scope. Advertised in S1, enforced in S2 (see auth.ts).
      scopes_supported: [WORDS_WRITE_SCOPE],
      bearer_methods_supported: ["header"],
    },
  });
}
