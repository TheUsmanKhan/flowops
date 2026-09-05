import withBundleAnalyzer from "@next/bundle-analyzer";

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
  allowedDevOrigins: ["*.space-z.ai", "*.z.ai", "localhost:3000"],
  // CRITICAL: Prisma client must NOT be bundled into the standalone output.
  // Without this, production builds fail with "Failed to load external module
  // @prisma/client-*/runtime/library: Error: open EEXIST" because the
  // Prisma binary engine can't be bundled by Turbopack.
  // This tells Next.js to load @prisma/client from node_modules at runtime
  // instead of bundling it into the standalone server.
  serverExternalPackages: ["@prisma/client"],
};

const wrapped = withBundleAnalyzer({
  enabled: process.env.ANALYZE === "true",
})(nextConfig);

export default wrapped;
