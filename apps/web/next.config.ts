import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "export",
  images: { unoptimized: true },
  reactStrictMode: true,
  devIndicators: false,
  transpilePackages: ["@weft/strategy"],
};

export default nextConfig;
