#!/usr/bin/env node
/*
 * AgentOS - Self-hosted AI coding session manager
 * https://github.com/johnisag/agent-os
 *
 * Cross-platform Node CLI (CommonJS so it runs under plain `node` without
 * any transpiler). Mirrors the behavior of the POSIX bash CLI in
 * `scripts/agent-os`, but works natively on Windows, macOS and Linux.
 *
 * Subcommands: install, start, stop, restart, status, run, logs, update, help
 */

"use strict";

const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

// ---------------------------------------------------------------------------
// Configuration / derived paths
// ---------------------------------------------------------------------------

const IS_WINDOWS = process.platform === "win32";

// Port the server listens on (matches server.ts default and the bash CLI).
const PORT = process.env.AGENT_OS_PORT || "3011";
const URL = `http://localhost:${PORT}`;

// ~/.agent-os is the AgentOS home; everything (pid, logs) lives under it.
const AGENT_OS_HOME =
  process.env.AGENT_OS_HOME || path.join(os.homedir(), ".agent-os");
const PID_FILE = path.join(AGENT_OS_HOME, "agent-os.pid");
const LOG_DIR = path.join(AGENT_OS_HOME, "logs");
const LOG_FILE = path.join(LOG_DIR, "agent-os.log");

// The repo this script lives in: scripts/agent-os.js -> repo root is one up.
const REPO_DIR = path.resolve(__dirname, "..");

// On Windows, npm/git are .cmd shims, so they must be invoked via the shell.
// Using `shell: true` lets spawn resolve `npm`/`git` from PATH on all OSes.
const SPAWN_SHELL = true;

// ---------------------------------------------------------------------------
// Small logging helpers
// ---------------------------------------------------------------------------

function info(msg) {
  console.log(`==> ${msg}`);
}
function warn(msg) {
  console.warn(`==> ${msg}`);
}
function error(msg) {
  console.error(`==> ${msg}`);
}

// ---------------------------------------------------------------------------
// Process / PID helpers
// ---------------------------------------------------------------------------

/** Ensure a directory exists (recursive, no-op if already there). */
function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

/** Read the PID from the pid file, or null if none / unreadable. */
function readPid() {
  try {
    const raw = fs.readFileSync(PID_FILE, "utf8").trim();
    const pid = parseInt(raw, 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/** Return true if the given PID refers to a live process. */
function isAlive(pid) {
  if (!pid) return false;
  try {
    // Signal 0 performs an existence/permission check without killing.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but we can't signal it -> still alive.
    return err.code === "EPERM";
  }
}

/** Return the running PID (from pid file) if the process is alive, else null. */
function getRunningPid() {
  const pid = readPid();
  return isAlive(pid) ? pid : null;
}

/** Remove the pid file, ignoring errors. */
function clearPidFile() {
  try {
    fs.unlinkSync(PID_FILE);
  } catch {
    /* ignore */
  }
}

/**
 * Run a command synchronously in the repo root with inherited stdio.
 * Returns the exit code; exits the CLI on failure unless allowFail is set.
 */
function runSync(cmd, args, { cwd = REPO_DIR, allowFail = false } = {}) {
  const result = spawnSync(cmd, args, {
    cwd,
    stdio: "inherit",
    shell: SPAWN_SHELL,
  });
  if (result.error) {
    error(`Failed to run "${cmd}": ${result.error.message}`);
    if (!allowFail) process.exit(1);
    return 1;
  }
  if (result.status !== 0 && !allowFail) {
    process.exit(result.status || 1);
  }
  return result.status || 0;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/** install: install dependencies and build for production. */
function cmdInstall() {
  info("Installing dependencies...");
  runSync("npm", ["install", "--legacy-peer-deps"]);

  info("Building for production...");
  runSync("npm", ["run", "build"]);

  console.log("");
  info("AgentOS installed successfully!");
  console.log("");
  console.log("Next steps:");
  console.log("  agent-os start     Start the server");
  console.log("  agent-os status    Show status and URL");
}

/** start: spawn the production server detached in the background. */
function cmdStart() {
  const running = getRunningPid();
  if (running) {
    warn(`AgentOS is already running (PID: ${running})`);
    return;
  }

  info("Starting AgentOS...");
  ensureDir(AGENT_OS_HOME);
  ensureDir(LOG_DIR);

  // Open the log file for append; the detached child writes stdout+stderr here.
  const out = fs.openSync(LOG_FILE, "a");
  const err = fs.openSync(LOG_FILE, "a");

  // `npm start` runs: cross-env NODE_ENV=production tsx server.ts
  const child = spawn("npm", ["start"], {
    cwd: REPO_DIR,
    detached: true,
    stdio: ["ignore", out, err],
    shell: SPAWN_SHELL,
    env: process.env,
  });

  if (typeof child.pid !== "number") {
    error("Failed to start AgentOS. Check logs: agent-os logs");
    process.exit(1);
  }

  fs.writeFileSync(PID_FILE, String(child.pid));

  // Let the child outlive this CLI process.
  child.unref();

  info(`AgentOS started (PID: ${child.pid})`);
  console.log("");
  console.log(`  Local:  ${URL}`);
  console.log("");
  console.log("Run 'agent-os logs' to view logs");
}

/** stop: kill the running server cross-platform and clean up the pid file. */
function cmdStop() {
  const pid = getRunningPid();
  if (!pid) {
    warn("AgentOS is not running");
    clearPidFile();
    return;
  }

  info(`Stopping AgentOS (PID: ${pid})...`);

  if (IS_WINDOWS) {
    // /T kills the process tree (npm -> tsx -> node); /F forces termination.
    const res = spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
    });
    if (res.status !== 0) {
      warn("taskkill reported a non-zero exit; process may already be gone");
    }
  } else {
    // Try a graceful SIGTERM first, then SIGKILL if still alive.
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* already gone */
    }
    if (isAlive(pid)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
  }

  clearPidFile();
  info("AgentOS stopped");
}

/** restart: stop then start. */
function cmdRestart() {
  cmdStop();
  cmdStart();
}

/** status: report running state and URL. */
function cmdStatus() {
  const pid = getRunningPid();
  console.log("");
  if (pid) {
    console.log(`  Status:  Running (PID: ${pid})`);
    console.log(`  Port:    ${PORT}`);
    console.log(`  Local:   ${URL}`);
    console.log(`  Logs:    ${LOG_FILE}`);
    console.log(`  Install: ${REPO_DIR}`);
  } else {
    console.log("  Status:  Stopped");
    console.log(`  Install: ${REPO_DIR}`);
    console.log("");
    console.log("  Run 'agent-os start' to start the server");
  }
  console.log("");
}

/** Open a URL in the default browser, spawned safely (no shell injection). */
function openBrowser(url) {
  let cmd;
  let args;
  if (IS_WINDOWS) {
    // `cmd /c start "" <url>` - the empty "" is the window title argument
    // so a URL with special characters isn't mistaken for the title.
    cmd = "cmd";
    args = ["/c", "start", "", url];
  } else if (process.platform === "darwin") {
    cmd = "open";
    args = [url];
  } else {
    cmd = "xdg-open";
    args = [url];
  }

  const child = spawn(cmd, args, { stdio: "ignore", detached: true });
  child.on("error", () => {
    warn(`Could not open a browser. Open manually: ${url}`);
  });
  child.unref();
}

/** run: start the server in the foreground and open the browser. */
function cmdRun() {
  info(`Opening ${URL}...`);
  // Open the browser shortly after launch so the server has a moment to boot.
  setTimeout(() => openBrowser(URL), 1500);

  // Run in the foreground with inherited stdio (Ctrl+C stops it).
  runSync("npm", ["start"]);
}

/** logs: tail the log file if present. */
function cmdLogs() {
  if (!fs.existsSync(LOG_FILE)) {
    warn("No log file found");
    process.exit(1);
  }

  if (IS_WINDOWS) {
    // PowerShell's Get-Content -Wait is the native equivalent of `tail -f`.
    runSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        `Get-Content -Path '${LOG_FILE.replace(/'/g, "''")}' -Tail 50 -Wait`,
      ],
      { allowFail: true }
    );
  } else {
    runSync("tail", ["-n", "50", "-f", LOG_FILE], { allowFail: true });
  }
}

/** update: git pull, reinstall deps, rebuild. */
function cmdUpdate() {
  const wasRunning = !!getRunningPid();
  if (wasRunning) cmdStop();

  info("Updating AgentOS...");
  runSync("git", ["pull", "--ff-only"]);

  info("Installing dependencies...");
  runSync("npm", ["install", "--legacy-peer-deps"]);

  info("Rebuilding...");
  runSync("npm", ["run", "build"]);

  info("Update complete!");

  if (wasRunning) cmdStart();
}

/** help: usage text. */
function cmdHelp() {
  console.log("");
  console.log("AgentOS - Self-hosted AI coding session manager");
  console.log("");
  console.log("Usage: agent-os <command>");
  console.log("");
  console.log("Commands:");
  console.log("  install     Install dependencies and build");
  console.log("  run         Start server (foreground) and open in browser");
  console.log("  start       Start the server in the background");
  console.log("  stop        Stop the server");
  console.log("  restart     Restart the server");
  console.log("  status      Show server status and URL");
  console.log("  logs        Tail server logs");
  console.log("  update      Update to the latest version");
  console.log("");
  console.log("Environment variables:");
  console.log("  AGENT_OS_HOME   Home directory (default: ~/.agent-os)");
  console.log("  AGENT_OS_PORT   Server port (default: 3011)");
  console.log("");
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

function main() {
  const command = process.argv[2];

  switch (command) {
    case "install":
      cmdInstall();
      break;
    case "start":
      cmdStart();
      break;
    case "stop":
      cmdStop();
      break;
    case "restart":
      cmdRestart();
      break;
    case "run":
      cmdRun();
      break;
    case "status":
      cmdStatus();
      break;
    case "logs":
      cmdLogs();
      break;
    case "update":
      cmdUpdate();
      break;
    case "help":
    case "--help":
    case "-h":
    case undefined:
      cmdHelp();
      break;
    default:
      error(`Unknown command: ${command}`);
      cmdHelp();
      process.exit(1);
  }
}

main();
