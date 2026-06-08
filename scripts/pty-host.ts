// Entry point for the pty-host daemon (Tier 2). Run via the tsx CLI:
//   node node_modules/tsx/dist/cli.mjs scripts/pty-host.ts
// Auto-spawned (detached) by the host client when STOA_PTY_HOST=1 and no
// daemon is running yet. Keeps agent sessions alive across web-server restarts.
import {
  startHost,
  installProcessGuards,
  shutdownHost,
} from "../lib/session-backend/pty/host";

import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { dirname } from "path";
import { hostAddress, hostPidFile } from "../lib/session-backend/pty/protocol";

// This process owns EVERY live agent session, so a single unhandled throw must
// not crash it and take them all down. Install the keep-alive guards before we
// start serving. (Guards live only here, not when the host runs in-process
// under the web server / test runner, where they'd mask real crashes.)
installProcessGuards();

function pidFilePath(): string {
  return process.env.STOA_PTY_HOST_PID_FILE || hostPidFile();
}

function writePidFile(): void {
  const file = pidFilePath();
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, String(process.pid));
  } catch {
    // A missing pid file must not block the daemon; CLI stop also has IPC.
  }
}

function removePidFile(): void {
  const file = pidFilePath();
  try {
    if (readFileSync(file, "utf8").trim() === String(process.pid)) {
      unlinkSync(file);
    }
  } catch {
    // already gone or owned by a newer daemon
  }
}

let shuttingDown = false;
function shutdownFromSignal(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  void shutdownHost().finally(() => {
    removePidFile();
    process.exit(0);
  });
}

process.on("exit", removePidFile);
process.on("SIGINT", shutdownFromSignal);
process.on("SIGTERM", shutdownFromSignal);
if (process.platform === "win32") process.on("SIGBREAK", shutdownFromSignal);

startHost()
  .then((started) => {
    if (!started) {
      // Another host already owns the socket; nothing to do.
      console.log("[pty-host] another daemon already running; exiting");
      process.exit(0);
    }
    writePidFile();
    console.log(`[pty-host] listening on ${hostAddress()}`);
    // The listening server keeps the event loop alive.
  })
  .catch((err) => {
    console.error("[pty-host] failed to start:", err);
    process.exit(1);
  });
