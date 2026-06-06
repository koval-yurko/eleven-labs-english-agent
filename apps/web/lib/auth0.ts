import { Auth0Client } from "@auth0/nextjs-auth0/server";

/**
 * Auth0 client (SDK v4). Configured from AUTH0_* env. Used by middleware for route
 * gating and by server code to read the authenticated session (FR-017).
 */
export const auth0 = new Auth0Client();
