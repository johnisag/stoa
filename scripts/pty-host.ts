// Entry point for the pty-host daemon (Tier 2). Auto-spawned detached through
// tsx's loader so Windows does not flash an extra visible node console.
// Keeps agent sessions alive across web-server restarts.
import {
  startHost,
  installProcessGuards,
} from "../lib/session-backend/pty/host";

import { hostAddress } from "../lib/session-backend/pty/protocol";

// This process owns EVERY live agent session, so a single unhandled throw must
// not crash it and take them all down. Install the keep-alive guards before we
// start serving. (Guards live only here, not when the host runs in-process
// under the web server / test runner, where they'd mask real crashes.)
installProcessGuards();

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
