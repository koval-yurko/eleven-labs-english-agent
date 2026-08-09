import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // @tutor/shared ships raw TypeScript with no build step (Metro consumes it the same way), so
  // Next has to transpile it like first-party source. A dist build would only add a stale-output
  // failure mode. See docs/2026-08-09-expo-repo-structure-migration.md §4 step 3.
  transpilePackages: ["@tutor/shared"],
};

export default nextConfig;
