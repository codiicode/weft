import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "export",
  images: { unoptimized: true },
  reactStrictMode: true,
  transpilePackages: ["@weft/strategy"],
};

export default nextConfig;
