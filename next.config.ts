import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // pg uses Node APIs; bundling it often causes "Can't resolve 'pg'"
  serverExternalPackages: ["pg"],
};

export default nextConfig;
