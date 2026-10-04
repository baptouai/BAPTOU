import type { NextConfig } from "next";

// Every page runs in the browser (data comes from Firebase), so the app is exported as static files
// and served by Firebase Hosting.
const nextConfig: NextConfig = {
  output: "export",
  images: { unoptimized: true },
};

export default nextConfig;
