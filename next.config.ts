import type { NextConfig } from "next";
import { resolve } from "path";
import { withSerwist } from "@serwist/turbopack";

const nextConfig: NextConfig = {
  devIndicators: false,
  // Keep packages that ship native binaries out of the bundle so Turbopack
  // doesn't try to trace/bundle their executables (e.g. ripgrep's rg.exe).
  serverExternalPackages: ["@vscode/ripgrep", "node-pty"],
  turbopack: {
    root: resolve(import.meta.dirname),
  },
};

export default withSerwist(nextConfig);
