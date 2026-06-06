import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // The generator/contracts workspace packages ship TypeScript source.
  transpilePackages: ["@idiomatic/contracts", "@idiomatic/generator"],
};

export default nextConfig;
