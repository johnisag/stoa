import type { NextConfig } from "next";
import { resolve } from "path";
import { withSerwist } from "@serwist/turbopack";

const nextConfig: NextConfig = {
  devIndicators: false,
  // Keep packages that ship native binaries out of the bundle so Turbopack
  // doesn't try to trace/bundle their executables (e.g. ripgrep's rg.exe).
  // better-sqlite3 ships prebuilds on Mac/Linux (prebuilds/darwin-*/, linux-*/);
  // Turbopack's hashed copy in .next/node_modules only includes build/Release
  // which doesn't exist there → native addon fails to load → DB 500 on fresh
  // Mac/Linux installs. Externalizing makes it resolve from node_modules instead.
  serverExternalPackages: ["@vscode/ripgrep", "node-pty", "better-sqlite3"],
  turbopack: {
    root: resolve(import.meta.dirname),
  },
};

export default withSerwist(nextConfig);
