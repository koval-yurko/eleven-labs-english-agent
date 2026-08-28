/**
 * The one fact both MCP mappers need: whether a hostname is reachable from a THIRD PARTY's network.
 *
 * `openai-mcp.ts` and `elevenlabs-mcp.ts` translate the same grant into two vendors' vocabularies,
 * and they share exactly one piece of reasoning — that the connection runs *vendor → us*, so a URL
 * that resolves on this machine cannot work no matter which vendor holds it. Everything else about
 * the two is different (one is a per-session object, the other a provisioned workspace resource),
 * which is why this module is a predicate and not a shared "validate an MCP config" function: the
 * two failure messages are written for different readers and deliberately do not share words.
 *
 * It lives here rather than in one of them because a second verbatim copy is how two guards drift,
 * and this one fails SILENTLY when it is wrong — the request never arrives, so there is nothing in
 * our logs to notice.
 */

/**
 * Hosts that resolve somewhere on this machine or this network and nowhere on a vendor's.
 *
 * The loopback names are the ones a dev environment produces by default; the RFC 1918 ranges and
 * `.local` are the same mistake made from a LAN address, which looks more like a real URL and is
 * therefore likelier to be believed.
 */
export function unreachableHost(hostname: string): boolean {
  if (["localhost", "127.0.0.1", "[::1]", "0.0.0.0"].includes(hostname)) return true;
  if (hostname.endsWith(".local") || hostname.endsWith(".localhost")) return true;
  return /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(hostname);
}
