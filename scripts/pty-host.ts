// Entry point for the pty-host daemon (Tier 2). Auto-spawned detached through
// tsx's loader so Windows does not flash an extra visible node console.
// Keeps agent sessions alive across web-server restarts.
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
