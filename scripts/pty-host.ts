// Entry point for the pty-host daemon (Tier 2). Run via the tsx CLI:
//   node node_modules/tsx/dist/cli.mjs scripts/pty-host.ts
// Auto-spawned (detached) by the host client when AGENT_OS_PTY_HOST=1 and no
// daemon is running yet. Keeps agent sessions alive across web-server restarts.
import { startHost } from "../lib/session-backend/pty/host";

import { hostAddress } from "../lib/session-backend/pty/protocol";

startHost()
  .then((started) => {
    if (!started) {
      // Another host already owns the socket; nothing to do.
      console.log("[pty-host] another daemon already running; exiting");
      process.exit(0);
    }
    console.log(`[pty-host] listening on ${hostAddress()}`);
    // The listening server keeps the event loop alive.
  })
  .catch((err) => {
    console.error("[pty-host] failed to start:", err);
    process.exit(1);
  });
