import withBundleAnalyzer from "@next/bundle-analyzer";

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
};

const wrapped = withBundleAnalyzer({
  enabled: process.env.ANALYZE === "true",
})(nextConfig);

export default wrapped;
