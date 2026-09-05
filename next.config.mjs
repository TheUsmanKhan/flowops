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

// Bundle analyzer is a DEV-ONLY dependency.
// We load it LAZILY via dynamic import() so that production builds (e.g. on
// Hostinger where devDependencies may be skipped with --omit=dev) don't fail
// with "Cannot find package '@next/bundle-analyzer'".
// The analyzer only runs when ANALYZE=true AND the package is installed.
let config = nextConfig;

if (process.env.ANALYZE === "true") {
  try {
    const { default: withBundleAnalyzer } = await import("@next/bundle-analyzer");
    config = withBundleAnalyzer({ enabled: true })(nextConfig);
  } catch {
    console.warn(
      "[next.config] @next/bundle-analyzer is not installed — skipping bundle analysis. " +
        "Install it as a devDependency to use ANALYZE=true."
    );
  }
}

export default config;
