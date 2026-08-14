import type { NextConfig } from "next";
import withBundleAnalyzer from "@next/bundle-analyzer";

const nextConfig: NextConfig = {
  output: "standalone",
  /* config options here */
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
};

// Bundle analyzer is activated via ANALYZE=true env var.
// Normal builds (bun run build) are unaffected.
const wrapped = withBundleAnalyzer({
  enabled: process.env.ANALYZE === "true",
})(nextConfig);

export default wrapped;
