import type { NextConfig } from "next";

// nothing custom needed here — Cloudflare-specific build/runtime wiring lives in open-next.config.ts
const nextConfig: NextConfig = {
  // packages/ui ships raw .tsx source (no build step), so Next must transpile it itself rather than expect pre-compiled JS.
  transpilePackages: ["@ysync/ui"],
};

export default nextConfig;
