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

// ---------------------------------------------------------------------------
// .env loader (dependency-free)
//
// Stoa ships no dotenv dependency and the server reads process.env at module
// load, so a bare `.env` in the repo root would otherwise be ignored. The CLI
// hydrates process.env from `.env` BEFORE resolving PORT (below) so that
// `STOA_PORT=3022` in `.env` actually reaches the spawned server. Precedence
// follows dotenv convention: a value already in the real environment WINS — the
// file only fills in unset keys, so `STOA_PORT=... stoa start` still overrides.
// ---------------------------------------------------------------------------

/**
 * Parse the text of a .env file into a plain key→value object. Pure (no I/O).
 * Supports `KEY=VALUE`, `export KEY=VALUE`, surrounding single/double quotes,
 * spaces around `=`, blank lines and `#` comments. No variable expansion and
 * no inline-comment stripping (kept predictable). Invalid keys are skipped.
 */
function parseEnvFile(content) {
  const out = {};
  // Strip a leading UTF-8 BOM: Windows editors (Notepad, some PowerShell
  // redirects) write .env files BOM-first, which would otherwise corrupt the
  // first key (e.g. "\uFEFFSTOA_PORT") and silently drop it.
  const text = String(content).replace(/^\uFEFF/, "");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const body = line.startsWith("export ") ? line.slice(7).trim() : line;
    const eq = body.indexOf("=");
    if (eq === -1) continue;
    const key = body.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = body.slice(eq + 1).trim();
    // Strip one layer of matching surrounding quotes.
    if (
      value.length >= 2 &&
      ((value[0] === '"' && value[value.length - 1] === '"') ||
        (value[0] === "'" && value[value.length - 1] === "'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/**
 * Read `<dir>/.env` (if present) and set any keys NOT already in process.env.
 * Missing file is a silent no-op. Returns the parsed object (for tests).
 * Set STOA_SKIP_ENV_FILE=1 to disable entirely (used by tests so a developer's
 * local repo-root .env can't make env-dependent assertions non-deterministic).
 */
function loadEnvFile(dir) {
  if (process.env.STOA_SKIP_ENV_FILE === "1") return {};
  const envPath = path.join(dir, ".env");
  if (!fs.existsSync(envPath)) return {};
  let parsed = {};
  try {
    parsed = parseEnvFile(fs.readFileSync(envPath, "utf8"));
  } catch {
    return {};
  }
  for (const [k, v] of Object.entries(parsed)) {
    if (process.env[k] === undefined) process.env[k] = v;
  }
  return parsed;
}

// Hydrate from the repo-root .env before any env-derived constant is resolved.
loadEnvFile(path.resolve(__dirname, ".."));

// Port the server listens on. STOA_PORT is the documented knob; a raw PORT is
// also honored; failing both we fall back to the port the server was LAST started
// on (persisted in ~/.stoa/stoa.port by `stoa start`/`stoa run`). That last step
// is what makes `stoa update` restart on the right port even when the port was set
// via a shell env var (not .env) at start time — the update runs in a fresh shell
// that no longer has STOA_PORT, and without this it would silently drop to 3011.
// This single resolved value is used for BOTH the displayed URL and the spawned
// server's env, so the two can never diverge.
const PORT =
  process.env.STOA_PORT || process.env.PORT || readPortFile() || "3011";
const URL = `http://localhost:${PORT}`;

// Environment for the spawned server. The CLI may have STOA_PORT set without
// PORT (the var server.ts actually reads), so map the resolved PORT through
// explicitly — otherwise the server would silently fall back to its 3011
// default while the CLI reports the configured port.
//
// On Windows env vars are case-insensitive, but a spread of process.env yields
// a plain, case-SENSITIVE object: a pre-existing differently-cased key (e.g.
// "Port") would survive alongside our "PORT", leaving the child's lookup
// ambiguous. Strip any case-variant of PORT first, then set the canonical one.
function serverEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.toUpperCase() !== "PORT") env[k] = v;
  }
  env.PORT = PORT;
  return env;
}

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

// ── persisted port (~/.stoa/stoa.port) ──
// Records the port the server was last started on so a later `stoa update` /
// restart re-applies it even if it was set via a shell env var (not .env). These
// derive the home from process.env directly (not the STOA_HOME const) so they're
// hoist-safe to call during the PORT resolution above.

function stoaHomeDir() {
  return process.env.STOA_HOME || path.join(os.homedir(), ".stoa");
}
function portFilePath() {
  return path.join(stoaHomeDir(), "stoa.port");
}
/** The last-started port as a numeric string, or null if none/garbage. */
function readPortFile() {
  try {
    const raw = fs.readFileSync(portFilePath(), "utf8").trim();
    return /^[0-9]+$/.test(raw) ? raw : null;
  } catch {
    return null;
  }
}
/** Persist the port the server is starting on. Best-effort (never throws). */
function writePortFile(port) {
  try {
    fs.mkdirSync(stoaHomeDir(), { recursive: true });
    fs.writeFileSync(portFilePath(), String(port));
  } catch {
    /* ignore — port persistence is a convenience, not load-bearing */
  }
}

/**
 * Lines from `git status --porcelain` that should BLOCK an update — i.e. tracked
 * changes (staged/modified/deleted/renamed/conflicted), NOT untracked files
 * (`??`). A `git pull --ff-only` keeps untracked files (and if an incoming file
 * collides, the checkout fails cleanly and we recover), so blocking on every
 * untracked artifact left in the install tree was over-strict — the documented
 * cause of `stoa update` aborting when it shouldn't. Pure (exported for tests).
 */
function blockingDirty(porcelain) {
  if (!porcelain) return [];
  return porcelain
    .split(/\r?\n/)
    .filter((l) => l.trim() && !l.startsWith("??"));
}

/**
 * Run a command synchronously in the repo root with inherited stdio.
 * Returns the exit code; exits the CLI on failure unless allowFail is set.
 */
function runSync(cmd, args, { cwd = REPO_DIR, allowFail = false, env } = {}) {
  const result = spawnSync(cmd, args, {
    cwd,
    stdio: "inherit",
    shell: SPAWN_SHELL,
    ...(env ? { env } : {}),
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
/**
 * A `next build` that's interrupted (Ctrl-C, OOM, sleep, closed terminal) can
 * leave a partial .next missing prerender-manifest.json — and the production
 * server then crash-loops forever under a keep-alive supervisor (observed in the
 * field). Assert the key production artifacts exist so a half-build fails loudly
 * here instead of silently shipping a crash-loop. `dir` is injectable for tests.
 */
function buildIsComplete(dir = REPO_DIR) {
  const next = path.join(dir, ".next");
  return (
    fs.existsSync(path.join(next, "prerender-manifest.json")) &&
    fs.existsSync(path.join(next, "BUILD_ID"))
  );
}

function cmdInstall() {
  info("Installing dependencies...");
  // --include=dev: the build needs devDeps (next/tailwind/typescript). A shell
  // with NODE_ENV=production would otherwise omit them and break `npm run build`.
  runSync("npm", ["install", "--include=dev", "--legacy-peer-deps"]);

  info("Building for production...");
  runSync("npm", ["run", "build"]);

  if (!buildIsComplete()) {
    error("Build incomplete — .next is missing required files.");
    console.log("  Re-run the build:  npm run build");
    process.exit(1);
  }

  console.log("");
  info("Stoa installed successfully!");
  console.log("");
  console.log("Next steps:");
  console.log("  stoa start     Start the server");
  console.log("  stoa status    Show status and URL");
}

/** Rotate the log to .old once it grows past 10 MB (mirrors the bash CLI, so
 * the single appended ~/.stoa/logs/stoa.log can't grow without bound). */
function rotateLogIfLarge() {
  try {
    const MAX_BYTES = 10 * 1024 * 1024;
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > MAX_BYTES) {
      fs.renameSync(LOG_FILE, LOG_FILE + ".old");
    }
  } catch {
    /* best-effort: a rotation failure must not block startup */
  }
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
  rotateLogIfLarge();

  // Open the log file for append; the detached child writes stdout+stderr here.
  const out = fs.openSync(LOG_FILE, "a");
  const err = fs.openSync(LOG_FILE, "a");

  // `npm start` runs: cross-env NODE_ENV=production tsx server.ts
  const child = spawn("npm", ["start"], {
    cwd: REPO_DIR,
    detached: true,
    stdio: ["ignore", out, err],
    shell: SPAWN_SHELL,
    env: serverEnv(),
  });

  if (typeof child.pid !== "number") {
    error("Failed to start Stoa. Check logs: stoa logs");
    process.exit(1);
  }

  fs.writeFileSync(PID_FILE, String(child.pid));
  writePortFile(PORT); // so a later `stoa update` restarts on this same port

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

  // Confirm it actually died before clearing the pid file. If the kill failed
  // (e.g. taskkill lacked privilege), KEEP the pid file and fail loudly — so a
  // following cmdRestart/cmdUpdate aborts instead of stacking a second server
  // on the same port (which then crash-loops on EADDRINUSE).
  if (isAlive(pid)) {
    error(`Failed to stop Stoa — PID ${pid} is still alive.`);
    console.log("  Kill it manually (then retry), e.g.:");
    console.log(
      IS_WINDOWS ? `    taskkill /PID ${pid} /T /F` : `    kill -9 ${pid}`
    );
    process.exit(1);
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
  writePortFile(PORT); // persist the port for a later `stoa update` restart
  info(`Opening ${URL}...`);
  // Open the browser shortly after launch so the server has a moment to boot.
  setTimeout(() => openBrowser(URL), 1500);

  // Run in the foreground with inherited stdio (Ctrl+C stops it).
  runSync("npm", ["start"], { env: serverEnv() });
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
/**
 * Untracked files in the install tree that collide with paths incoming on the
 * target ref. `git checkout`/`git pull` aborts on these, and `git stash` does
 * NOT move untracked files — so name them instead of suggesting a stash.
 * `porcelain` = `git status --porcelain`; `incoming` = `git diff --name-only`.
 * Pure (no I/O); exported for tests.
 */
function collidingUntracked(porcelain, incoming) {
  const untracked = String(porcelain || "")
    .split(/\r?\n/)
    .filter((l) => l.startsWith("?? "))
    .map((l) => l.slice(3).trim());
  const incomingSet = new Set(
    String(incoming || "")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
  );
  return untracked.filter((f) => incomingSet.has(f));
}

/**
 * True if something is already listening on the given localhost TCP port.
 * Synchronous (spawns a short-lived node probe) so cmdUpdate can detect a
 * supervisor-run server that has no pid file before rebuilding .next under it.
 */
function isPortListening(port) {
  const probe = `const net=require("net");const s=net.connect(${Number(port)},"127.0.0.1");s.on("connect",()=>{s.destroy();process.exit(0)});s.on("error",()=>process.exit(1));setTimeout(()=>process.exit(1),700);`;
  try {
    return (
      spawnSync(process.execPath, ["-e", probe], { timeout: 3000 }).status === 0
    );
  } catch {
    // Fail-open: if the probe itself can't run (e.g. sandboxed), assume the port
    // is free rather than block all updates.
    return false;
  }
}

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

  // Don't blow away genuine uncommitted local changes with a checkout/pull — but
  // only TRACKED edits block. Untracked artifacts left in the install tree (a
  // stray log, a scratch file) are safe across a ff-only pull, so they must not
  // abort a routine update (the documented `stoa update` dirty-tree failure).
  const blocking = blockingDirty(gitCapture(["status", "--porcelain"]));
  if (blocking.length) {
    error("You have uncommitted local changes in the install directory.");
    console.log(`  (${REPO_DIR})`);
    for (const line of blocking.slice(0, 10)) console.log(`    ${line}`);
    console.log(
      "  Those look like real edits, so the update won't touch them."
    );
    console.log("  Commit them (or `git stash`), then re-run `stoa update`.");
    process.exit(1);
  }

  const wasRunning = !!getRunningPid();

  // Supervisor guard: no pid-tracked server, but the port is being served -> an
  // external keep-alive supervisor (or `stoa run`) is live. Rebuilding .next
  // under it would make it serve a half-built app, so refuse. The documented
  // deploy is: stop the supervisor -> stoa update -> start it again.
  if (!wasRunning && isPortListening(PORT)) {
    error(`Port ${PORT} is already in use (not by a 'stoa start' server).`);
    console.log(
      "  Likely a keep-alive supervisor or 'stoa run' serving this install (or"
    );
    console.log(
      "  another app). Updating now would rebuild .next under a live server."
    );
    console.log(
      "  Stop it first, then re-run 'stoa update' (and restart the supervisor)."
    );
    process.exit(1);
  }

  if (wasRunning) cmdStop();

  const origin = gitCapture(["remote", "get-url", "origin"]) || "origin";
  info(`Updating from ${origin}`);
  const before = gitCapture(["rev-parse", "--short", "HEAD"]); // for display/compare
  const beforeFull = gitCapture(["rev-parse", "HEAD"]); // unambiguous reset target
  // The branch we started on (usually "main", but an install could be parked on
  // a feature branch, or "HEAD" if detached). recover() returns here before any
  // reset so it never force-moves `main` to a non-main commit.
  const origBranch = gitCapture(["rev-parse", "--abbrev-ref", "HEAD"]);

  // On ANY failure: if the pull already moved HEAD, restore the previous source
  // (never leave a half-updated tree — new source over an old/partial build),
  // then restart the existing version if it was managed. Then exit non-zero.
  const recover = (what) => {
    error(`Update failed (${what}).`);
    const nowHead = gitCapture(["rev-parse", "--short", "HEAD"]);
    if (before && nowHead && nowHead !== before) {
      info(`Restoring the previous version (${before})...`);
      // We may be on `main` after a `git checkout main`; a plain reset here would
      // move `main` to the captured (possibly feature-branch) commit and brick
      // every future ff-only pull. So return to the ORIGINAL ref first.
      if (origBranch && origBranch !== "HEAD") {
        // Only reset if the branch checkout succeeded — a deleted/renamed branch
        // must not leave us resetting whatever branch we're currently on (main).
        if (
          runSync("git", ["checkout", origBranch], { allowFail: true }) === 0
        ) {
          runSync("git", ["reset", "--hard", beforeFull || before], {
            allowFail: true,
          });
        } else {
          console.log(
            `  Could not restore branch ${origBranch}; left HEAD as-is (avoided moving main).`
          );
        }
      } else {
        // Detached HEAD: move HEAD itself to the prior commit, never a branch.
        runSync("git", ["checkout", "--detach", beforeFull || before], {
          allowFail: true,
        });
      }
    }
    if (wasRunning) {
      info("Restarting the server with the existing version...");
      cmdStart();
    }
    // node_modules isn't reset; if a partial `npm install` left it inconsistent
    // and the server won't start, a reinstall reconciles it.
    console.log(
      `  If it won't start: cd "${REPO_DIR}" && npm install --include=dev --legacy-peer-deps, then 'stoa start'.`
    );
    process.exit(1);
  };
  const step = (what, cmd, args) => {
    if (runSync(cmd, args, { allowFail: true }) !== 0) recover(what);
  };

  step("git fetch", "git", ["fetch", "origin", "--tags"]);
  // Pin to main: an install left on a (now-deleted) feature branch still updates.
  step("git checkout main", "git", ["checkout", "main"]);

  // git pull: on failure, surface untracked files that collide with incoming
  // changes (a `git stash` won't move those) before recovering.
  if (
    runSync("git", ["pull", "--ff-only", "origin", "main"], {
      allowFail: true,
    }) !== 0
  ) {
    const collisions = collidingUntracked(
      gitCapture(["status", "--porcelain"]),
      gitCapture(["diff", "--name-only", "HEAD", "origin/main"])
    );
    if (collisions.length) {
      error(
        "Untracked files collide with incoming changes (a 'git stash' won't move these):"
      );
      for (const f of collisions.slice(0, 10)) console.log(`    ${f}`);
      console.log("  Remove or move them, then re-run 'stoa update'.");
    }
    recover("git pull (local main may have diverged — or reclone)");
  }

  const after = gitCapture(["rev-parse", "--short", "HEAD"]);

  // True no-op: nothing pulled -> skip install/build entirely. Bring the managed
  // server back (we stopped it above) and return.
  if (before && after && before === after) {
    info("Already up to date — nothing to rebuild.");
    if (wasRunning) cmdStart();
    return;
  }
  info(`Updated ${before || "?"} -> ${after || "?"}`);

  info("Installing dependencies...");
  step("npm install", "npm", [
    "install",
    "--include=dev",
    "--legacy-peer-deps",
  ]);

  info("Rebuilding...");
  step("npm run build", "npm", ["run", "build"]);

  // The build can exit 0 yet leave an incomplete .next (interrupted/OOM). Do NOT
  // restart into that — a partial build crash-loops. A stopped server beats a
  // crash-loop, so refuse loudly instead of calling recover() (which restarts).
  if (!buildIsComplete()) {
    error("Build incomplete — .next is missing required files after rebuild.");
    console.log(
      "  The server was NOT restarted (a partial build would crash-loop)."
    );
    console.log(
      `  Fix:  cd "${REPO_DIR}" && npm run build, then 'stoa start'.`
    );
    process.exit(1);
  }

  info("Update complete!");

  if (wasRunning) {
    cmdStart();
  } else {
    // No pid-tracked server to restart. If one is still running the OLD code
    // (started via `stoa run` in the foreground, or externally), it won't pick up
    // this build until it's restarted — say so instead of silently doing nothing.
    info("No managed server was running, so none was restarted.");
    console.log(
      "  If a Stoa server is still serving the old version, restart it"
    );
    console.log(
      `  (stop it, then 'stoa start') to load this update on port ${PORT}.`
    );
  }
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

module.exports = {
  isGitInstall,
  serverEnv,
  PORT,
  parseEnvFile,
  loadEnvFile,
  blockingDirty,
  readPortFile,
  writePortFile,
  buildIsComplete,
  collidingUntracked,
};
