import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // @tutor/shared ships raw TypeScript with no build step (Metro consumes it the same way), so
  // Next has to transpile it like first-party source. See
  // docs/2026-08-09-expo-repo-structure-migration.md §4 step 3.
  //
  // @tutor/server is deliberately NOT here and NOT a dependency: tutor-web holds no server secrets
  // and reads every byte of data through services/api over HTTP (D6,
  // docs/2026-10-10-services-split-hono-api.md §5).
  transpilePackages: ["@tutor/shared"],
};

export default nextConfig;
