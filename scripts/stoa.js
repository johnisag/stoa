#!/usr/bin/env node
/*
 * Stoa - Self-hosted AI coding session manager
 * https://github.com/johnisag/stoa
 *
 * Cross-platform Node CLI (CommonJS so it runs under plain `node` without
 * any transpiler). Mirrors the behavior of the POSIX bash CLI in
 * `scripts/stoa`, but works natively on Windows, macOS and Linux.
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
const PORT = process.env.STOA_PORT || "3011";
const URL = `http://localhost:${PORT}`;

// ~/.stoa is the Stoa home; everything (pid, logs) lives under it.
const STOA_HOME = process.env.STOA_HOME || path.join(os.homedir(), ".stoa");
const PID_FILE = path.join(STOA_HOME, "stoa.pid");
const LOG_DIR = path.join(STOA_HOME, "logs");
const LOG_FILE = path.join(LOG_DIR, "stoa.log");

// The repo this script lives in: scripts/stoa.js -> repo root is one up.
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
  info("Stoa installed successfully!");
  console.log("");
  console.log("Next steps:");
  console.log("  stoa start     Start the server");
  console.log("  stoa status    Show status and URL");
}

/** start: spawn the production server detached in the background. */
function cmdStart() {
  const running = getRunningPid();
  if (running) {
    warn(`Stoa is already running (PID: ${running})`);
    return;
  }

  info("Starting Stoa...");
  ensureDir(STOA_HOME);
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
    error("Failed to start Stoa. Check logs: stoa logs");
    process.exit(1);
  }

  fs.writeFileSync(PID_FILE, String(child.pid));

  // Let the child outlive this CLI process.
  child.unref();

  info(`Stoa started (PID: ${child.pid})`);
  console.log("");
  console.log(`  Local:  ${URL}`);
  console.log("");
  console.log("Run 'stoa logs' to view logs");
}

/** stop: kill the running server cross-platform and clean up the pid file. */
function cmdStop() {
  const pid = getRunningPid();
  if (!pid) {
    warn("Stoa is not running");
    clearPidFile();
    return;
  }

  info(`Stopping Stoa (PID: ${pid})...`);

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
  info("Stoa stopped");
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
    console.log("  Run 'stoa start' to start the server");
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

/** Capture a git command's trimmed stdout in REPO_DIR, or null on failure. */
function gitCapture(args) {
  const r = spawnSync("git", args, {
    cwd: REPO_DIR,
    shell: SPAWN_SHELL,
    encoding: "utf8",
  });
  return r.status === 0 ? (r.stdout || "").trim() : null;
}

/** True if `dir` is a git checkout (vs. e.g. an `npm i -g` install). */
function isGitInstall(dir = REPO_DIR) {
  return fs.existsSync(path.join(dir, ".git"));
}

/**
 * update: pull the latest `main` and rebuild.
 *
 * Hardened for already-installed clones: it pins to `main` (so an old or
 * feature-branch checkout still updates), refuses to clobber local edits, and
 * tells npm-global installs to update via npm instead of git.
 */
function cmdUpdate() {
  // npm-global installs aren't git checkouts — they can't self-update via git.
  if (!isGitInstall()) {
    error("This install isn't a git checkout, so it can't update via git.");
    console.log("  Update the npm package instead:");
    console.log("    npm install -g @johnisag/stoa@latest");
    process.exit(1);
  }

  // Next.js rewrites next-env.d.ts on every build, so the install tree is
  // perpetually "dirty" there even when untouched. Quietly discard such
  // autogenerated files (the rebuild below regenerates them) so a routine
  // `stoa update` never demands a stash. Genuine local edits are still
  // protected by the check that follows.
  const AUTOGEN_PATHS = ["next-env.d.ts"];
  for (const f of AUTOGEN_PATHS) {
    // No-ops silently when f is untracked or unchanged; discards the churn when
    // it's a tracked modification. gitCapture swallows the error either way.
    gitCapture(["checkout", "--", f]);
  }

  // Don't blow away genuine uncommitted local changes with a checkout/pull.
  const dirty = gitCapture(["status", "--porcelain"]);
  if (dirty) {
    error("You have uncommitted local changes in the install directory.");
    console.log(`  (${REPO_DIR})`);
    console.log(
      "  Those look like real edits, so the update won't touch them."
    );
    console.log("  Commit them (or `git stash`), then re-run `stoa update`.");
    process.exit(1);
  }

  const wasRunning = !!getRunningPid();
  if (wasRunning) cmdStop();

  // Past this point the server is stopped. On ANY failure (network, diverged
  // main, npm), restart the existing version so a failed update never leaves the
  // user's server down — then exit non-zero.
  const recover = (what) => {
    error(`Update failed (${what}).`);
    if (wasRunning) {
      info("Restarting the server with the existing version...");
      cmdStart();
    }
    process.exit(1);
  };
  const step = (what, cmd, args) => {
    if (runSync(cmd, args, { allowFail: true }) !== 0) recover(what);
  };

  const origin = gitCapture(["remote", "get-url", "origin"]) || "origin";
  info(`Updating from ${origin}`);
  const before = gitCapture(["rev-parse", "--short", "HEAD"]);

  step("git fetch", "git", ["fetch", "origin", "--tags"]);
  // Pin to main: an install left on a (now-deleted) feature branch still updates.
  step("git checkout main", "git", ["checkout", "main"]);
  step(
    "git pull (local main may have diverged — try `git stash` or reclone)",
    "git",
    ["pull", "--ff-only", "origin", "main"]
  );

  const after = gitCapture(["rev-parse", "--short", "HEAD"]);
  if (before && after && before === after) {
    info("Already up to date.");
  } else {
    info(`Updated ${before || "?"} -> ${after || "?"}`);
  }

  info("Installing dependencies...");
  step("npm install", "npm", ["install", "--legacy-peer-deps"]);

  info("Rebuilding...");
  step("npm run build", "npm", ["run", "build"]);

  info("Update complete!");

  if (wasRunning) cmdStart();
}

/** help: usage text. */
function cmdHelp() {
  console.log("");
  console.log("Stoa - Self-hosted AI coding session manager");
  console.log("");
  console.log("Usage: stoa <command>");
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
  console.log("  STOA_HOME   Home directory (default: ~/.stoa)");
  console.log("  STOA_PORT   Server port (default: 3011)");
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

// Run as a CLI when invoked directly; stay importable (side-effect-free) for tests.
if (require.main === module) {
  main();
}

module.exports = { isGitInstall };
