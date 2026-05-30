#!/usr/bin/env node
/**
 * Cross-platform postinstall.
 *
 * On POSIX, node-pty ships a `spawn-helper` binary that must be executable.
 * On Windows there is no spawn-helper (ConPTY is used), so this is a no-op.
 *
 * Replaces the old `chmod +x ... 2>/dev/null || true` shell one-liner, which
 * failed under cmd/PowerShell on native Windows.
 */
const { chmodSync, readdirSync, statSync } = require("fs");
const { join } = require("path");

if (process.platform === "win32") {
  process.exit(0);
}

try {
  const prebuilds = join(
    __dirname,
    "..",
    "node_modules",
    "node-pty",
    "prebuilds"
  );
  for (const dir of readdirSync(prebuilds)) {
    const helper = join(prebuilds, dir, "spawn-helper");
    try {
      statSync(helper);
      chmodSync(helper, 0o755);
    } catch {
      // spawn-helper not present for this prebuild; skip
    }
  }
} catch {
  // node-pty prebuilds dir not present; nothing to do
}
