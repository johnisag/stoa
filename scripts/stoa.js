#!/usr/bin/env node
/*
 * Stoa - Self-hosted AI coding session manager
 * https://github.com/johnisag/stoa
 *
 * Cross-platform Node CLI (CommonJS so it runs under plain `node` without
 * any transpiler). Mirrors the behavior of the POSIX bash CLI in
 * `scripts/stoa`, but works natively on Windows, macOS and Linux.
 *
 * Subcommands: install, start, stop, restart, status, run, logs, update,
 * doctor, help
 */

"use strict";

const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const http = require("http");
const net = require("net");
const os = require("os");
const path = require("path");
// NodeURL is the WHATWG URL constructor — aliased because this module shadows the
// global `URL` with a string constant (the local server URL) further down.
const { pathToFileURL, URL: NodeURL } = require("url");

// ---------------------------------------------------------------------------
// Configuration / derived paths
// ---------------------------------------------------------------------------

const IS_WINDOWS = process.platform === "win32";

// The repo this script lives in: scripts/stoa.js -> repo root is one up.
const REPO_DIR = path.resolve(__dirname, "..");

function parseEnvFile(content) {
  const out = {};
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

function loadEnvFile(dir) {
  if (process.env.STOA_SKIP_ENV_FILE === "1") return {};
  const envPath = path.join(dir, ".env");
  if (!fs.existsSync(envPath)) return {};
  try {
    const parsed = parseEnvFile(fs.readFileSync(envPath, "utf8"));
    for (const [k, v] of Object.entries(parsed)) {
      if (process.env[k] === undefined) process.env[k] = v;
    }
    return parsed;
  } catch {
    return {};
  }
}

loadEnvFile(REPO_DIR);

// Port the server listens on. STOA_PORT is the documented knob; a raw PORT is
// also honored. The resolved value is used for both display and server env.
const PORT = process.env.STOA_PORT || process.env.PORT || "3011";
const URL = `http://localhost:${PORT}`;

function serverEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.toUpperCase() !== "PORT") env[k] = v;
  }
  const resolvedPort = process.env.STOA_PORT || process.env.PORT || "3011";
  return { ...env, PORT: resolvedPort, ...extra };
}

// ~/.stoa is the Stoa home; operational files (pid, logs) live under it and honor
// STOA_HOME. AUTH files (token, shared-origins) are owned by the running server's
// lib/auth.ts, which resolves them from os.homedir()+.stoa and does NOT honor
// STOA_HOME — so `stoa share` must use the SAME base to interoperate (read the token
// the server uses, write origins where the server reads them).
const STOA_HOME = process.env.STOA_HOME || path.join(os.homedir(), ".stoa");
const STOA_AUTH_HOME = path.join(os.homedir(), ".stoa");
const PID_FILE = path.join(STOA_HOME, "stoa.pid");
const LOG_DIR = path.join(STOA_HOME, "logs");
const LOG_FILE = path.join(LOG_DIR, "stoa.log");

// Native modules whose compiled `.node` binary must be built for the running Node.
// Two ways a plain `npm install` leaves them broken, both of which 500 every DB route
// (`new Database()` throws because better_sqlite3.node is missing or ABI-mismatched):
//   1. A global `ignore-scripts=true` in ~/.npmrc (common under supply-chain hardening
//      policies) makes npm SKIP the install/build scripts entirely, so the binary is
//      never compiled or fetched — a fresh install has no `.node` at all.
//   2. `npm install` is version-aware but NOT ABI-aware: an already-locked package
//      isn't recompiled, so after a Node-version change (the >=24 baseline, fnm/nvm
//      moving Node) a stale binary lingers → NODE_MODULE_VERSION mismatch.
// Both install and update force-rebuild this set. KEEP IN SYNC with the native deps in
// package.json.
const NATIVE_MODULES = ["better-sqlite3", "node-pty"];

// argv to rebuild the native modules. `--ignore-scripts=false` is REQUIRED, not
// cosmetic: it overrides a global `ignore-scripts=true` so these two trusted, vendored
// packages actually run their compile/prebuild-fetch step — WITHOUT touching the user's
// global hardening setting (every other package still has scripts suppressed). Plain
// `npm rebuild` inherits the global `ignore-scripts=true` and silently does nothing,
// which is why the rebuild step alone wasn't enough.
function nativeRebuildArgs() {
  return ["rebuild", ...NATIVE_MODULES, "--ignore-scripts=false"];
}

// Per-OS remediation shown before a native rebuild: if no prebuilt binary matches
// the running Node, `npm rebuild` falls back to compiling, which needs a C++
// toolchain. Pure (unit-tested) so the hint stays actionable on every platform.
function toolchainHint() {
  if (process.platform === "darwin") return "macOS: xcode-select --install";
  if (process.platform === "win32")
    return "Windows: install the Visual Studio Build Tools (Desktop development with C++)";
  return "Linux: install build-essential (Debian/Ubuntu) or the Development Tools group";
}

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

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function waitUntilDead(pid, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!isAlive(pid)) return true;
    sleepSync(100);
  }
  return !isAlive(pid);
}

function isExecutableFile(file) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return false;
    return IS_WINDOWS || (stat.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

function envValue(name) {
  for (const [k, v] of Object.entries(process.env)) {
    if (k.toUpperCase() === name.toUpperCase()) return v;
  }
  return undefined;
}

function resolveCommand(cmd) {
  if (cmd.includes("/") || cmd.includes("\\") || path.isAbsolute(cmd)) {
    return isExecutableFile(cmd) ? cmd : null;
  }

  const dirs = (envValue("PATH") || "").split(path.delimiter).filter(Boolean);
  const exts = IS_WINDOWS
    ? (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD")
        .split(";")
        .map((e) => e.trim())
        .filter(Boolean)
    : [""];
  const names =
    IS_WINDOWS && path.extname(cmd) ? [cmd] : exts.map((e) => cmd + e);

  for (const dir of dirs) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (isExecutableFile(candidate)) return candidate;
    }
  }
  return null;
}

function commandSpec(cmd, args = []) {
  const resolved = resolveCommand(cmd) || cmd;
  if (IS_WINDOWS && /\.(cmd|bat)$/i.test(resolved)) {
    // npm/npx are .cmd shims on Windows; Node can't spawn them directly (since the
    // CVE-2024-27980 hardening it throws), so route through cmd.exe. Pass the path +
    // args as normal argv entries WITHOUT shell:true and WITHOUT `/s` — Node then
    // quotes each entry and plain `/c` preserves those quotes, so a spaced path
    // (npm/node under `C:\Program Files\...`) stays one token. (Adding `/s` makes cmd
    // strip Node's quotes → the path splits → `'C:\Program' is not recognized`, which
    // is what silently broke `stoa update`/`install`.) Mirrors the .cmd routing in
    // lib/session-backend/pty/registry.ts and lib/claude/process-manager.ts.
    return {
      file: process.env.ComSpec || "cmd.exe",
      args: ["/c", resolved, ...args],
    };
  }
  return { file: resolved, args };
}

/**
 * Run a command synchronously in the repo root with inherited stdio.
 * Returns the exit code; exits the CLI on failure unless allowFail is set.
 */
function runSync(cmd, args, { cwd = REPO_DIR, allowFail = false, env } = {}) {
  const spec = commandSpec(cmd, args);
  const result = spawnSync(spec.file, spec.args, {
    cwd,
    stdio: "inherit",
    windowsHide: true,
    ...(env ? { env } : {}),
  });
  if (result.error) {
    error(`Failed to run "${cmd}": ${result.error.message}`);
    if (!allowFail) process.exit(1);
    return 1;
  }
  const status = result.status ?? 1;
  if (status !== 0 && !allowFail) {
    process.exit(status);
  }
  return status;
}

function spawnDetached(cmd, args, options) {
  const spec = commandSpec(cmd, args);
  return spawn(spec.file, spec.args, options);
}

function buildIsComplete(dir = REPO_DIR) {
  const next = path.join(dir, ".next");
  return (
    fs.existsSync(path.join(next, "prerender-manifest.json")) &&
    fs.existsSync(path.join(next, "BUILD_ID"))
  );
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/** install: install dependencies and build for production. */
function cmdInstall() {
  info("Installing dependencies...");
  runSync("npm", ["install", "--include=dev", "--legacy-peer-deps"]);

  // Re-running `stoa install` over an existing node_modules (a documented "missing
  // dependencies" remedy) hits the same version-aware-not-ABI-aware gap as update,
  // so rebuild the native modules here too. See NATIVE_MODULES.
  info("Rebuilding native modules for the current Node...");
  if (runSync("npm", nativeRebuildArgs(), { allowFail: true }) !== 0) {
    // Repeat the remediation IN the failure path: on a compile fallback npm prints a
    // wall of gyp output, so a hint printed only before the rebuild scrolls off.
    error(
      `Failed to rebuild native modules. If they must compile, ${toolchainHint()}`
    );
    process.exit(1);
  }

  info("Building for production...");
  runSync("npm", ["run", "build"]);

  if (!buildIsComplete()) {
    error("Build incomplete: .next is missing required production artifacts.");
    console.log("  Re-run the build: npm run build");
    process.exit(1);
  }

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

  if (!buildIsComplete()) {
    error("Production build is missing or incomplete.");
    console.log("  Run: stoa install");
    process.exit(1);
  }

  info("Starting Stoa...");
  ensureDir(STOA_HOME);
  ensureDir(LOG_DIR);

  // Open the log file for append; the detached child writes stdout+stderr here.
  const out = fs.openSync(LOG_FILE, "a");
  const err = fs.openSync(LOG_FILE, "a");

  let child;
  if (IS_WINDOWS) {
    const tsxDist = path.join(REPO_DIR, "node_modules", "tsx", "dist");
    child = spawn(
      process.execPath,
      [
        "--require",
        path.join(tsxDist, "preflight.cjs"),
        "--import",
        pathToFileURL(path.join(tsxDist, "loader.mjs")).href,
        "server.ts",
      ],
      {
        cwd: REPO_DIR,
        detached: true,
        stdio: ["ignore", out, err],
        windowsHide: true,
        env: serverEnv({ NODE_ENV: "production" }),
      }
    );
  } else {
    child = spawnDetached("npm", ["start"], {
      cwd: REPO_DIR,
      detached: true,
      stdio: ["ignore", out, err],
      env: serverEnv(),
    });
  }

  if (typeof child.pid !== "number") {
    error("Failed to start Stoa. Check logs: stoa logs");
    process.exit(1);
  }

  fs.writeFileSync(PID_FILE, String(child.pid));

  sleepSync(1200);
  if (!isAlive(child.pid)) {
    clearPidFile();
    error("Failed to start Stoa. Check logs: stoa logs");
    process.exit(1);
  }

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
      windowsHide: true,
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

  if (!waitUntilDead(pid)) {
    error(`Failed to stop Stoa: PID ${pid} is still alive.`);
    console.log("  Kill it manually, then retry:");
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
/**
 * A human label for what the install is pinned to (#56): a detached release-tag
 * checkout reads as the pinned tag + how to get back; otherwise the tracked
 * branch. Returns null for a non-git (npm-global) install. Best-effort — any git
 * failure yields null rather than throwing in a status readout.
 */
function currentRefLabel() {
  if (!isGitInstall()) return null;
  const tag = gitCapture(["describe", "--tags", "--exact-match"]);
  if (tag && parseReleaseTag(tag)) {
    return `${tag} (release channel — pinned; \`stoa update --channel main\` to track main)`;
  }
  const branch = gitCapture(["symbolic-ref", "--short", "-q", "HEAD"]);
  return branch ? `${branch} (tracking)` : null;
}

function cmdStatus() {
  const pid = getRunningPid();
  const ref = currentRefLabel();
  console.log("");
  if (pid) {
    console.log(`  Status:  Running (PID: ${pid})`);
    console.log(`  Port:    ${PORT}`);
    console.log(`  Local:   ${URL}`);
    console.log(`  Logs:    ${LOG_FILE}`);
    console.log(`  Install: ${REPO_DIR}`);
    if (ref) console.log(`  Version: ${ref}`);
  } else {
    console.log("  Status:  Stopped");
    console.log(`  Install: ${REPO_DIR}`);
    if (ref) console.log(`  Version: ${ref}`);
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

  const child = spawnDetached(cmd, args, { stdio: "ignore", detached: true });
  child.on("error", () => {
    warn(`Could not open a browser. Open manually: ${url}`);
  });
  child.unref();
}

/** run: start the server in the foreground and open the browser. */
function cmdRun() {
  if (!buildIsComplete()) {
    error("Production build is missing or incomplete.");
    console.log("  Run: stoa install");
    process.exit(1);
  }

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
        `Get-Content -LiteralPath '${LOG_FILE.replace(/'/g, "''")}' -Tail 50 -Wait`,
      ],
      { allowFail: true }
    );
  } else {
    runSync("tail", ["-n", "50", "-f", LOG_FILE], { allowFail: true });
  }
}

/** Capture a git command's trimmed stdout in REPO_DIR, or null on failure. */
function gitCapture(args) {
  const spec = commandSpec("git", args);
  const r = spawnSync(spec.file, spec.args, {
    cwd: REPO_DIR,
    encoding: "utf8",
    windowsHide: true,
  });
  return r.status === 0 ? (r.stdout || "").trim() : null;
}

/** Read one `npm config get <key>` value (trimmed), or null if npm can't be run. */
function npmConfigGet(key) {
  const spec = commandSpec("npm", ["config", "get", key]);
  const r = spawnSync(spec.file, spec.args, {
    cwd: REPO_DIR,
    encoding: "utf8",
    windowsHide: true,
  });
  return r.status === 0 ? (r.stdout || "").trim() : null;
}

/** True if `dir` is a git checkout (vs. e.g. an `npm i -g` install). */
function isGitInstall(dir = REPO_DIR) {
  return fs.existsSync(path.join(dir, ".git"));
}

// ---------------------------------------------------------------------------
// update channel (#56) — opt-in pin to a verified release tag
// ---------------------------------------------------------------------------
//
// TRUST BOUNDARY: `stoa update` on the DEFAULT `main` channel keeps today's
// behavior exactly (fetch + fast-forward the `main` branch to its HEAD). The
// `release` channel is a stricter, OPT-IN posture: instead of tracking whatever
// is on `main` this instant, it checks out the newest published *release tag* —
// an immutable, reviewed point-in-time (a maintainer cuts the tag deliberately).
// It is guarded (never the default) so a routine update can't silently jump a
// checkout onto an untested tip, and so the tag-verification path is explicit.

const UPDATE_CHANNELS = ["main", "release"];
const DEFAULT_UPDATE_CHANNEL = "main";

/**
 * Resolve the update channel from an explicit `--channel <x>` CLI flag and the
 * STOA_UPDATE_CHANNEL env var. Precedence: CLI flag > env > default ("main").
 * An unknown value is REJECTED (returns { error }) rather than silently falling
 * back — a typo like `--channel realese` must not quietly track `main` when the
 * user asked to pin. Pure → unit-tested.
 *
 * @param {string[]} argv  argv AFTER the subcommand (e.g. ["--channel","release"]).
 * @param {string|undefined} envChannel  process.env.STOA_UPDATE_CHANNEL.
 */
function resolveUpdateChannel(argv = [], envChannel = undefined) {
  let source = "default";
  let raw = DEFAULT_UPDATE_CHANNEL;

  const envVal = typeof envChannel === "string" ? envChannel.trim() : "";
  if (envVal) {
    raw = envVal;
    source = "env (STOA_UPDATE_CHANNEL)";
  }

  const list = Array.isArray(argv) ? argv : [];
  for (let i = 0; i < list.length; i++) {
    const tok = String(list[i]);
    if (tok === "--channel") {
      raw = String(list[i + 1] || "").trim();
      source = "--channel";
      i++;
    } else if (tok.startsWith("--channel=")) {
      raw = tok.slice("--channel=".length).trim();
      source = "--channel";
    }
  }

  const channel = raw.toLowerCase();
  if (!UPDATE_CHANNELS.includes(channel)) {
    return {
      error: `Unknown update channel "${raw || "(empty)"}" (from ${source}). Use one of: ${UPDATE_CHANNELS.join(", ")}.`,
    };
  }
  return { channel, source };
}

/**
 * Parse `git ls-remote --tags <url>` output into a de-duplicated list of tag
 * names. Each line is "<sha>\t<ref>"; we keep only refs/tags/* and strip the
 * `^{}` suffix git appends to the *dereferenced* (peeled) entry of an annotated
 * tag — that peeled line names the SAME tag, so keeping it would double-list it.
 * Pure → unit-tested.
 */
function parseRemoteTags(lsRemoteOutput) {
  const out = [];
  const seen = new Set();
  for (const rawLine of String(lsRemoteOutput || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const tab = line.indexOf("\t");
    if (tab === -1) continue;
    let ref = line.slice(tab + 1).trim();
    if (!ref.startsWith("refs/tags/")) continue;
    let name = ref.slice("refs/tags/".length);
    if (name.endsWith("^{}")) name = name.slice(0, -3); // peeled annotated tag
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

/**
 * Parse a release tag of the shape `vMAJOR.MINOR.PATCH` (optionally with a
 * `-prerelease` suffix) into sortable parts, or null if it doesn't match. The
 * leading `v` is optional. A prerelease (e.g. `v1.2.0-rc.1`) ranks BELOW the
 * same version's final release, per semver. Pure → unit-tested.
 */
function parseReleaseTag(tag) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(
    String(tag || "").trim()
  );
  if (!m) return null;
  const major = parseInt(m[1], 10);
  const minor = parseInt(m[2], 10);
  const patch = parseInt(m[3], 10);
  // Reject an absurd (>2^53) component: it would overflow to a float where two
  // distinct versions compare equal, making selectLatestReleaseTag's pick
  // order-dependent. Real release tags are tiny; this only drops nonsense refs.
  if (![major, minor, patch].every(Number.isSafeInteger)) return null;
  return {
    tag: String(tag).trim(),
    major,
    minor,
    patch,
    prerelease: m[4] || null,
  };
}

/** Compare two parsed release tags (semver-ish). Returns <0 if a<b, >0 if a>b.
 *  A prerelease sorts below its corresponding final release. Pure. */
function compareReleaseTags(a, b) {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  // Equal core version: a final release (no prerelease) outranks any prerelease.
  if (!a.prerelease && b.prerelease) return 1;
  if (a.prerelease && !b.prerelease) return -1;
  if (!a.prerelease && !b.prerelease) return 0;
  // Both prereleases: dotted identifier compare (numeric-aware), then length.
  const pa = a.prerelease.split(".");
  const pb = b.prerelease.split(".");
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const xa = pa[i];
    const xb = pb[i];
    if (xa === undefined) return -1; // shorter prerelease is lower
    if (xb === undefined) return 1;
    const na = /^\d+$/.test(xa);
    const nb = /^\d+$/.test(xb);
    if (na && nb) {
      const d = parseInt(xa, 10) - parseInt(xb, 10);
      if (d !== 0) return d;
    } else if (na !== nb) {
      return na ? -1 : 1; // numeric identifiers rank below alphanumeric
    } else if (xa !== xb) {
      return xa < xb ? -1 : 1;
    }
  }
  return 0;
}

/**
 * Select the latest VERIFIED release tag from a list of tag names (typically
 * parseRemoteTags(...) output). Ignores anything that isn't a clean
 * `vMAJOR.MINOR.PATCH[-pre]` tag, so a stray/hostile ref name can't be picked.
 * By default prereleases are excluded (a `release` channel wants stable tags);
 * pass { includePrerelease:true } to allow them. Returns the tag string, or
 * null if none qualify. Pure → unit-tested.
 */
function selectLatestReleaseTag(tags, { includePrerelease = false } = {}) {
  const parsed = (Array.isArray(tags) ? tags : [])
    .map(parseReleaseTag)
    .filter((p) => p !== null)
    .filter((p) => includePrerelease || !p.prerelease);
  if (!parsed.length) return null;
  let best = parsed[0];
  for (let i = 1; i < parsed.length; i++) {
    if (compareReleaseTags(parsed[i], best) > 0) best = parsed[i];
  }
  return best.tag;
}

/**
 * update: fast-forward the tracked `main` (default) OR check out the latest
 * verified release tag (opt-in `release` channel), then rebuild.
 *
 * Hardened for already-installed clones: it pins to `main` (so an old or
 * feature-branch checkout still updates), refuses to clobber local edits, and
 * tells npm-global installs to update via npm instead of git. The `release`
 * channel (STOA_UPDATE_CHANNEL=release or `stoa update --channel release`) is a
 * guarded, OPT-IN trust boundary that pins to an immutable published tag instead
 * of tracking main's HEAD; `--channel main` is the documented escape hatch back.
 */
function cmdUpdate(argv = []) {
  // Channel selection (#56). CLI `--channel <x>` > STOA_UPDATE_CHANNEL env >
  // default "main". `main` = today's behavior (track main's HEAD); `release` =
  // opt-in pin to the latest verified release tag. An unknown value hard-fails so
  // a typo never silently tracks the wrong channel.
  const channelResult = resolveUpdateChannel(
    argv,
    process.env.STOA_UPDATE_CHANNEL
  );
  if (channelResult.error) {
    error(channelResult.error);
    process.exit(1);
    return;
  }
  const channel = channelResult.channel;

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

  // Past this point the server is stopped. On failure, restart only if the
  // production build artifacts are still intact; never boot a partial build.
  const recover = (what) => {
    error(`Update failed (${what}).`);
    // Be LOUD: the update did not apply, so the code is still the old version. The
    // restart below boots that old build — without this line it reads like success.
    error("Your code was NOT updated — still on the previous build.");
    if (wasRunning) {
      if (buildIsComplete()) {
        info("Restarting the server on the PREVIOUS build...");
        cmdStart();
      } else {
        warn("Server was not restarted because the build is incomplete.");
      }
    }
    process.exit(1);
  };
  const step = (what, cmd, args) => {
    if (runSync(cmd, args, { allowFail: true }) !== 0) recover(what);
  };

  const originUrl = gitCapture(["remote", "get-url", "origin"]);
  const origin = originUrl || "origin";
  info(`Updating from ${origin} (channel: ${channel})`);
  const before = gitCapture(["rev-parse", "--short", "HEAD"]);

  // Fetch refs + tags once for either channel (execFile, no shell pipes). Kept
  // byte-identical to the pre-#56 fetch so the default `main` path is unchanged.
  step("git fetch", "git", ["fetch", "origin", "--tags"]);

  if (channel === "release") {
    // OPT-IN release channel: pin to the newest VERIFIED release tag instead of
    // tracking main's HEAD. Resolve the tag list from the remote over git's own
    // transport (git ls-remote --tags, execFile — no shell, no GitHub API token),
    // pick the highest semver, then check that immutable tag out in DETACHED HEAD.
    // `--channel main` / STOA_UPDATE_CHANNEL=main is the escape hatch back.
    info("Resolving the latest release tag…");
    const lsRemote = gitCapture(["ls-remote", "--tags", origin]);
    if (lsRemote == null) {
      recover(
        "git ls-remote --tags failed (couldn't reach the remote to list release tags)"
      );
    }
    const tag = selectLatestReleaseTag(parseRemoteTags(lsRemote));
    if (!tag) {
      // No published release tag yet. Fail LOUD rather than silently tracking main
      // — the user explicitly opted into the pinned channel.
      recover(
        "no verified release tag found on the remote. Use `--channel main` (or STOA_UPDATE_CHANNEL=main) to track the main branch instead"
      );
    }
    info(`Latest release tag: ${tag}`);
    // Downgrade guard: if HEAD is already pinned to a release tag NEWER than the
    // one we resolved (a higher tag was deleted / re-pointed upstream), say so
    // LOUD before the force checkout — silently downgrading a production install
    // is exactly what the guarded channel must never do quietly. (On a normal
    // main install HEAD isn't at a tag, so `describe --exact-match` returns null
    // and no warning fires.)
    const currentTag = gitCapture(["describe", "--tags", "--exact-match"]);
    const curParsed = currentTag ? parseReleaseTag(currentTag) : null;
    const nextParsed = parseReleaseTag(tag);
    if (
      curParsed &&
      nextParsed &&
      compareReleaseTags(nextParsed, curParsed) < 0
    ) {
      warn(
        `Latest release tag ${tag} is OLDER than your current ${currentTag} — this is a DOWNGRADE (a newer tag may have been removed upstream). Proceeding because you opted into the release channel.`
      );
    }
    // Check out the immutable tag (detached HEAD). The prior fetch --tags brought
    // the tag object local, so this needs no network.
    step(`git checkout ${tag}`, "git", ["checkout", "--force", `tags/${tag}`]);
  } else {
    // DEFAULT `main` channel — behavior-identical to before this change.
    // Pin to main: an install left on a (now-deleted) feature branch still updates.
    step("git checkout main", "git", ["checkout", "main"]);
    step(
      "git pull (local main may have diverged — try `git stash` or reclone)",
      "git",
      ["pull", "--ff-only", "origin", "main"]
    );
  }

  const after = gitCapture(["rev-parse", "--short", "HEAD"]);
  if (before && after && before === after) {
    info("Already up to date.");
  } else {
    info(`Updated ${before || "?"} -> ${after || "?"}`);
  }

  info("Installing dependencies...");
  step("npm install", "npm", [
    "install",
    "--include=dev",
    "--legacy-peer-deps",
  ]);

  // Force-rebuild native modules for the running Node (see NATIVE_MODULES). Always
  // unconditional: `npm rebuild` resolves a matching prebuilt binary in the common
  // case (a quick download, not a compile), and gating it on a stamp file would
  // reintroduce the exact "silently skip the rebuild" failure this fixes.
  info("Rebuilding native modules for the current Node...");
  // The hint rides in the step label so recover() echoes it adjacent to the failure
  // (a compile fallback buries an info-line hint under gyp output).
  step(
    `npm rebuild (if they must compile: ${toolchainHint()})`,
    "npm",
    nativeRebuildArgs()
  );

  info("Rebuilding...");
  step("npm run build", "npm", ["run", "build"]);

  if (!buildIsComplete()) {
    recover("build incomplete");
  }

  info("Update complete!");

  if (wasRunning) cmdStart();
}

// ---------------------------------------------------------------------------
// doctor: preflight diagnostics (DX #14)
// ---------------------------------------------------------------------------

// Minimum Node the project supports (kept in sync with package.json "engines").
const NODE_MIN_MAJOR = 24;
const DOCTOR_ICON = { ok: "✓", warn: "!", fail: "✗" };

/** Parse the major version from a Node version string ("v24.14.0" → 24). Pure. */
function parseNodeMajor(versionString) {
  const m = /^v?(\d+)\./.exec(String(versionString || "").trim());
  return m ? parseInt(m[1], 10) : null;
}

/** Check the running Node meets the minimum major. Pure → unit-tested. */
function checkNodeVersion(versionString, minMajor = NODE_MIN_MAJOR) {
  const major = parseNodeMajor(versionString);
  if (major === null) {
    return {
      name: "Node.js",
      status: "warn",
      detail: `unrecognized version "${versionString}"`,
      hint: `Stoa targets Node ${minMajor}+.`,
    };
  }
  if (major < minMajor) {
    return {
      name: "Node.js",
      status: "fail",
      detail: `${versionString} (need ${minMajor}+)`,
      hint: "Upgrade Node — https://nodejs.org or your version manager.",
    };
  }
  return { name: "Node.js", status: "ok", detail: versionString };
}

/** Try to load a native module; report whether its compiled binary actually loads.
 *  `load` is injectable for tests. A throw here is exactly the runtime failure that
 *  500s every DB route — missing binary (ignore-scripts skipped the build) OR an ABI
 *  mismatch — so this is the most direct preflight for it. Pure → unit-tested. */
function checkNativeModule(name, load = require) {
  try {
    load(name);
    return { name: `${name} (native)`, status: "ok", detail: "loads" };
  } catch (err) {
    const first = String((err && err.message) || err).split("\n")[0];
    return {
      name: `${name} (native)`,
      status: "fail",
      detail: `won't load — ${first}`,
      hint:
        "Run `stoa install` (or `npm rebuild " +
        NATIVE_MODULES.join(" ") +
        " --ignore-scripts=false`).",
    };
  }
}

/** True iff `npm config get ignore-scripts` reports it enabled. Pure → unit-tested. */
function isIgnoreScriptsEnabled(configValue) {
  return String(configValue == null ? "" : configValue).trim() === "true";
}

/** A global `ignore-scripts=true` makes a plain `npm install` skip native builds, so
 *  the .node binary is never produced. It's a user policy choice (warn, not fail) and
 *  `stoa install`/`stoa update` already work around it. Pure → unit-tested. */
function checkIgnoreScripts(configValue) {
  if (!isIgnoreScriptsEnabled(configValue)) {
    return {
      name: "npm ignore-scripts",
      status: "ok",
      detail: configValue ? String(configValue).trim() : "false",
    };
  }
  return {
    name: "npm ignore-scripts",
    status: "warn",
    detail: "true — a plain `npm install` skips native module builds",
    hint: "`stoa install`/`stoa update` rebuild with --ignore-scripts=false; add that flag to any manual `npm install`.",
  };
}

/** The CLI exit code for a set of check results: 1 if ANY failed, else 0 (a warn
 *  is advisory, not fatal). Pure → unit-tested. */
function doctorExitCode(results) {
  return results.some((r) => r.status === "fail") ? 1 : 0;
}

/** Format one check result as a console line (with an indented hint when not ok).
 *  Pure → unit-tested. */
function formatDoctorLine(r) {
  const icon = DOCTOR_ICON[r.status] || "?";
  const head = `  ${icon} ${r.name}: ${r.detail}`;
  return r.hint && r.status !== "ok" ? `${head}\n      → ${r.hint}` : head;
}

/** Parse + range-check a port string → a 1..65535 integer, or null if it isn't a
 *  clean numeric port ("3011"→3011; "0"/"99999"/"abc"/"3011x"→null). Pure. */
function parsePort(value) {
  const s = String(value == null ? "" : value).trim();
  if (!/^\d+$/.test(s)) return null;
  const n = parseInt(s, 10);
  return n >= 1 && n <= 65535 ? n : null;
}

/** Best-effort: is `port` free to bind on `host`? Resolves true (free) / false
 *  (in use). Never rejects. */
function checkPortFree(port, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => srv.close(() => resolve(true)));
    try {
      srv.listen(port, host);
    } catch {
      resolve(false);
    }
  });
}

/** doctor: verify the environment can run Stoa, with actionable hints. Exits 1 if
 *  any hard requirement fails (so it's usable as an install/CI preflight gate). */
async function cmdDoctor() {
  const results = [];

  results.push(checkNodeVersion(process.version));

  results.push(
    resolveCommand("git")
      ? { name: "git", status: "ok", detail: "found" }
      : {
          name: "git",
          status: "fail",
          detail: "not found on PATH",
          hint: "Install Git — https://git-scm.com",
        }
  );

  // NB: no ripgrep-on-PATH check — code search uses the ripgrep binary BUNDLED via
  // @vscode/ripgrep (lib/code-search.ts), not a system `rg`, so a PATH check would
  // false-warn on a perfectly healthy install. `npm install` (below) restores it.

  const depsPresent = fs.existsSync(path.join(REPO_DIR, "node_modules"));
  results.push(
    depsPresent
      ? { name: "Dependencies", status: "ok", detail: "node_modules present" }
      : {
          name: "Dependencies",
          status: "fail",
          detail: "node_modules missing",
          hint: "Run `npm install --include=dev --legacy-peer-deps`.",
        }
  );

  // Only probe the native binaries once node_modules exists — otherwise every module
  // would redundantly fail "Cannot find module" on top of the Dependencies fail above.
  if (depsPresent) {
    for (const mod of NATIVE_MODULES) results.push(checkNativeModule(mod));
  }

  // Surface a global ignore-scripts policy ONLY when it's enabled — it's the root cause
  // of native builds being silently skipped (every DB route 500s) and warns even when the
  // binary currently loads but a future manual `npm install` would re-break it. In the
  // common (disabled / unqueryable) case it's pure noise, so don't print an ok line.
  const ignoreScripts = checkIgnoreScripts(npmConfigGet("ignore-scripts"));
  if (ignoreScripts.status !== "ok") results.push(ignoreScripts);

  results.push(
    buildIsComplete()
      ? { name: "Production build", status: "ok", detail: ".next present" }
      : {
          name: "Production build",
          status: "warn",
          detail: "not built",
          hint: "Run `npm run build` (or `stoa install`) before `stoa start`.",
        }
  );

  const agents = ["claude", "codex", "hermes", "kilo", "kimi"];
  const foundAgents = agents.filter((a) => resolveCommand(a));
  results.push(
    foundAgents.length
      ? { name: "Agent CLIs", status: "ok", detail: foundAgents.join(", ") }
      : {
          name: "Agent CLIs",
          status: "warn",
          detail: "none found",
          hint: "Install at least one: Claude Code, Codex, Hermes, Kilo, or Kimi.",
        }
  );

  // Advertise the opt-in rate-limit statusline hook (M2b) ONLY when Claude is present —
  // it's how the Agent Monitor's quota gauge gets its 5h/7d window data. Best-effort
  // read; an absent/unreadable settings.json reads as "not installed".
  if (foundAgents.includes("claude")) {
    let claudeSettingsRaw = null;
    try {
      claudeSettingsRaw = fs.readFileSync(
        path.join(os.homedir(), ".claude", "settings.json"),
        "utf8"
      );
    } catch {
      /* absent/unreadable -> treated as not installed */
    }
    results.push(checkStatuslineHook(claudeSettingsRaw));
  }

  // Port: if Stoa owns the pid file it's expected to hold the port; otherwise the
  // port must be free to start. A foreign process on the port is a hard fail.
  const pid = getRunningPid();
  if (pid) {
    results.push({
      name: `Port ${PORT}`,
      status: "ok",
      detail: `Stoa is running (pid ${pid})`,
    });
  } else {
    // Probe the actual bind target: the server binds STOA_HOST (default loopback),
    // so a port held only on another interface still blocks the real start. A bad
    // STOA_PORT (0, out of range, non-numeric) is reported as invalid — not probed,
    // so listen() can't pick a random ephemeral port and falsely report "free".
    const portNum = parsePort(PORT);
    const host = process.env.STOA_HOST || "127.0.0.1";
    if (portNum === null) {
      results.push({
        name: `Port ${PORT}`,
        status: "fail",
        detail: `invalid port "${PORT}"`,
        hint: "Set STOA_PORT to a port in 1–65535 (default 3011).",
      });
    } else {
      const free = await checkPortFree(portNum, host);
      results.push(
        free
          ? { name: `Port ${PORT}`, status: "ok", detail: `free on ${host}` }
          : {
              name: `Port ${PORT}`,
              status: "fail",
              detail: `in use on ${host}`,
              hint: `Free port ${PORT}, or set STOA_PORT to an open port.`,
            }
      );
    }
  }

  console.log("");
  console.log("Stoa doctor — preflight checks");
  console.log("");
  for (const r of results) console.log(formatDoctorLine(r));
  const code = doctorExitCode(results);
  console.log("");
  console.log(
    code === 0 ? "All clear." : "Some checks failed — see the hints above."
  );
  console.log("");
  process.exit(code);
}

// ---------------------------------------------------------------------------
// statusline (M2b) - install the opt-in Claude rate-limit statusline hook
// ---------------------------------------------------------------------------

/** Absolute path to the bundled statusline hook script, forward-slashed so the
 *  command string stays one shell-safe token on Windows too (Node accepts "/"
 *  paths there, and "/" needs no escaping inside the double quotes). */
function statuslineHookPath(repoDir = REPO_DIR) {
  return path
    .join(repoDir, "scripts", "claude-statusline-hook.js")
    .replace(/\\/g, "/");
}

/** The statusLine command Claude runs. Quoted so a spaced install path stays one
 *  token. Pure -> unit-tested. */
function buildStatusLineCommand(hookPath) {
  return `node "${hookPath}"`;
}

/** True iff a statusLine config is Stoa's own (vs a user's custom one) - so re-running
 *  is idempotent and we never clobber someone else's statusline. Pure -> unit-tested. */
function isStoaStatusLine(statusLine) {
  return !!(
    statusLine &&
    typeof statusLine === "object" &&
    typeof statusLine.command === "string" &&
    statusLine.command.includes("claude-statusline-hook")
  );
}

/**
 * Merge our statusLine into a parsed ~/.claude/settings.json WITHOUT clobbering any
 * other config. Returns { settings, action }:
 *   - "conflict": a DIFFERENT (user-owned) statusLine is already set - leave everything
 *     as-is; the caller must NOT write.
 *   - "added" / "updated": ours was absent / refreshed - the caller writes `settings`,
 *     which carries every pre-existing key untouched plus our statusLine.
 * Pure -> unit-tested.
 */
function mergeStatusLine(settings, command) {
  const base =
    settings && typeof settings === "object" && !Array.isArray(settings)
      ? settings
      : {};
  const existing = base.statusLine;
  // Any truthy statusLine that isn't ours belongs to the user - never clobber it. This
  // also preserves an already-invalid bare-string value rather than silently discarding
  // it (an attacker can't reach here, but a careless overwrite of user config is wrong).
  if (existing && !isStoaStatusLine(existing)) {
    return { settings: base, action: "conflict" };
  }
  return {
    settings: { ...base, statusLine: { type: "command", command } },
    action: isStoaStatusLine(existing) ? "updated" : "added",
  };
}

/** doctor check (discoverability): advertise the opt-in rate-limit statusline hook so
 *  a user who hasn't installed it learns how to light up the Agent Monitor quota gauge.
 *  Takes the raw ~/.claude/settings.json contents (or null when absent/unreadable);
 *  "ok" when our hook is present, advisory "warn" + hint otherwise. Pure -> unit-tested. */
function checkStatuslineHook(rawSettings) {
  let installed = false;
  if (rawSettings) {
    try {
      const parsed = JSON.parse(rawSettings);
      installed = isStoaStatusLine(
        parsed && typeof parsed === "object" ? parsed.statusLine : null
      );
    } catch {
      installed = false;
    }
  }
  return installed
    ? { name: "Rate-limit statusline", status: "ok", detail: "installed" }
    : {
        name: "Rate-limit statusline",
        status: "warn",
        detail: "not installed",
        hint: "Run `stoa statusline` to feed the Agent Monitor quota gauge.",
      };
}

/** statusline: install the opt-in Claude rate-limit statusline hook. It feeds the
 *  Agent Monitor quota gauge (the 5h/7d window %) by writing ~/.stoa/rate-limits.json,
 *  and shows model/context/quota in Claude's own status bar. Never clobbers an existing
 *  statusLine or the rest of ~/.claude/settings.json. */
function cmdStatusline() {
  const settingsPath = path.join(os.homedir(), ".claude", "settings.json");

  let settings = {};
  if (fs.existsSync(settingsPath)) {
    let raw;
    try {
      raw = fs.readFileSync(settingsPath, "utf8");
    } catch (err) {
      error(`Can't read ${settingsPath}: ${err.message}`);
      process.exit(1);
    }
    try {
      settings = raw.trim() ? JSON.parse(raw) : {};
    } catch {
      error(`${settingsPath} is not valid JSON - refusing to overwrite it.`);
      error("Fix or remove the file, then re-run `stoa statusline`.");
      process.exit(1);
    }
    if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
      error(`${settingsPath} isn't a JSON object - refusing to overwrite it.`);
      process.exit(1);
    }
  }

  const command = buildStatusLineCommand(statuslineHookPath());
  const { settings: next, action } = mergeStatusLine(settings, command);

  if (action === "conflict") {
    warn(
      "A custom statusLine is already set in ~/.claude/settings.json - leaving it untouched."
    );
    info(
      "To capture rate limits, remove your statusLine and re-run `stoa statusline`."
    );
    return;
  }

  try {
    ensureDir(path.dirname(settingsPath));
    fs.writeFileSync(
      settingsPath,
      JSON.stringify(next, null, 2) + "\n",
      "utf8"
    );
  } catch (err) {
    error(`Failed to write ${settingsPath}: ${err.message}`);
    process.exit(1);
  }

  info(
    action === "updated"
      ? "Refreshed the Stoa rate-limit statusline hook in ~/.claude/settings.json."
      : "Installed the Stoa rate-limit statusline hook in ~/.claude/settings.json."
  );
  info(
    "Claude's status bar now shows model / context / 5h+7d quota, and the Agent"
  );
  info("Monitor quota gauge reads the live window utilization.");
  info(
    "(Rate-limit windows appear for Claude Pro/Max after the first response.)"
  );
}

// ---------------------------------------------------------------------------
// share (#11) — secure remote access over a tunnel (Tailscale funnel / cloudflared)
// ---------------------------------------------------------------------------

// stoa share registers the live tunnel origin here; the server reads it per WS
// upgrade (lib/auth.ts readSharedOrigins). MUST match SHARED_ORIGINS_PATH exactly —
// hence STOA_AUTH_HOME (os.homedir-based, not STOA_HOME), see the note by that const.
const SHARED_ORIGINS_FILE = path.join(STOA_AUTH_HOME, "shared-origins");
const TOKEN_FILE = path.join(STOA_AUTH_HOME, "token");
// PID of the tunnel child, so a later `stoa share` can reap an orphan left by a hard
// kill (SIGKILL/crash) that skipped the in-process teardown handlers.
const SHARE_PID_FILE = path.join(STOA_AUTH_HOME, "share.pid");
// Cap the registered-origins list so repeated shares (esp. cloudflared's new random
// subdomain each run) can't grow it — and the per-WS-upgrade scan — without bound.
const MAX_SHARED_ORIGINS = 20;

/** Prefer Tailscale funnel; fall back to cloudflared. null if neither is present. */
function selectTunnelProvider(tailscaleBin, cloudflaredBin) {
  if (tailscaleBin) return "tailscale";
  if (cloudflaredBin) return "cloudflared";
  return null;
}

/** The tunnel spawn command (bare name + argv) for a provider + local port. */
function tunnelCommand(provider, port) {
  const p = String(port);
  if (provider === "tailscale")
    return { cmd: "tailscale", args: ["funnel", p] };
  if (provider === "cloudflared")
    return {
      cmd: "cloudflared",
      args: ["tunnel", "--url", `http://localhost:${p}`],
    };
  return null;
}

/** Extract the public https URL from a line of a provider's output, or null. */
function parseTunnelUrl(provider, line) {
  const text = String(line);
  if (provider === "tailscale") {
    const m = /https:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)*\.ts\.net\b/i.exec(text);
    return m ? m[0] : null;
  }
  if (provider === "cloudflared") {
    const m = /https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/i.exec(text);
    return m ? m[0] : null;
  }
  return null;
}

/** The scheme://host origin of a URL, or null if unparseable. */
function originFromUrl(url) {
  try {
    return new NodeURL(url).origin;
  } catch {
    return null;
  }
}

/** The full share URL with the token appended (the server strips it after bootstrap). */
function formatShareUrl(publicUrl, token) {
  try {
    const u = new NodeURL(publicUrl);
    if (!u.pathname || u.pathname === "") u.pathname = "/";
    u.searchParams.set("token", token);
    return u.toString();
  } catch {
    return null;
  }
}

/** Dedup-add an origin to the registered-origins list, capped to the newest `max`
 *  (pure). The cap bounds the file (and the server's per-upgrade scan) across runs. */
function addOriginToList(list, origin, max = MAX_SHARED_ORIGINS) {
  const cleaned = list.map((s) => String(s).trim()).filter(Boolean);
  const next = cleaned.includes(origin) ? cleaned : [...cleaned, origin];
  return max > 0 && next.length > max ? next.slice(-max) : next;
}

/** Remove an origin from the registered-origins list (pure). */
function removeOriginFromList(list, origin) {
  return list
    .map((s) => String(s).trim())
    .filter(Boolean)
    .filter((o) => o !== origin);
}

/**
 * Fail-closed decision for `stoa share`. PURE over a probed state so it's
 * unit-testable. Shares ONLY when: auth is on; the server is running AND enforces
 * the token for local requests (a 401 to an unauthenticated `HEAD /` — otherwise a
 * tunnel, which reaches the server FROM localhost, would expose it with no token);
 * the token is known; and a tunnel tool exists. probeStatus is an HTTP status
 * number, or "refused" (nothing listening) / "error" (probe failed).
 */
function decideShare(state) {
  const { authOff, probeStatus, token, provider } = state;
  if (authOff)
    return {
      ok: false,
      code: "auth-off",
      message:
        "Auth is disabled (STOA_AUTH=off). Refusing to expose an unauthenticated server to the internet.",
    };
  if (probeStatus === "refused")
    return {
      ok: false,
      code: "not-running",
      message:
        "No Stoa server is answering on this port. Start it first with `stoa start`.",
    };
  if (probeStatus === "error")
    return {
      ok: false,
      code: "probe-failed",
      message:
        "Couldn't verify the server's auth posture (probe failed). Not sharing.",
    };
  if (probeStatus !== 401)
    return {
      ok: false,
      code: "loopback-trusted",
      message:
        "This server allows unauthenticated local access, so a public tunnel would expose it WITHOUT the token. Restart it with STOA_REQUIRE_AUTH=1 (e.g. add it to .env), then run `stoa share`.",
    };
  if (!token)
    return {
      ok: false,
      code: "no-token",
      message:
        "Couldn't find the server token. Set STOA_TOKEN, or start the server so it writes ~/.stoa/token.",
    };
  if (!provider)
    return {
      ok: false,
      code: "no-tunnel",
      message:
        "No tunnel tool found on PATH. Install Tailscale (https://tailscale.com/download) or cloudflared.",
    };
  return { ok: true, provider };
}

/** The server token as a running server resolved it: STOA_TOKEN env, else the
 *  persisted ~/.stoa/token. null if neither (we never generate one here). */
function readServerToken() {
  const fromEnv = (process.env.STOA_TOKEN || "").trim();
  if (fromEnv) return fromEnv;
  try {
    const t = fs.readFileSync(TOKEN_FILE, "utf8").trim();
    return t || null;
  } catch {
    return null;
  }
}

function readOriginsFile() {
  try {
    return fs.readFileSync(SHARED_ORIGINS_FILE, "utf8").split(/\r?\n/);
  } catch {
    return [];
  }
}

function writeOriginsFile(list) {
  ensureDir(STOA_AUTH_HOME);
  const body = list.length ? list.join("\n") + "\n" : "";
  // Atomic write (tmp + same-dir rename) so the server's per-upgrade read never sees
  // a torn/truncated file and momentarily drops the live origin (transient false-deny).
  const tmp = `${SHARED_ORIGINS_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, body, { mode: 0o600 });
  fs.renameSync(tmp, SHARED_ORIGINS_FILE);
}

function registerOrigin(origin) {
  writeOriginsFile(addOriginToList(readOriginsFile(), origin));
}

function unregisterOrigin(origin) {
  writeOriginsFile(removeOriginFromList(readOriginsFile(), origin));
}

/** HEAD / on localhost with no auth. Resolves to the status number, or
 *  "refused" (connection refused) / "error" (timeout / other). */
function probeAuth(port) {
  return new Promise((resolve) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: Number(port),
        path: "/",
        method: "HEAD",
        timeout: 4000,
      },
      (res) => {
        res.resume();
        resolve(res.statusCode || 0);
      }
    );
    req.on("timeout", () => {
      req.destroy();
      resolve("error");
    });
    req.on("error", (err) => {
      resolve(err && err.code === "ECONNREFUSED" ? "refused" : "error");
    });
    req.end();
  });
}

function printShareBanner(shareUrl, publicUrl) {
  console.log("");
  info("Stoa is now reachable from the internet (token-gated):");
  console.log("");
  console.log(`  ${shareUrl}`);
  console.log("");
  // Optional QR — lazy-required so the rest of the CLI stays dependency-free; if
  // it's missing, the URL text above is the fallback.
  try {
    const qrcode = require("qrcode-terminal");
    qrcode.generate(shareUrl, { small: true }, (qr) => console.log(qr));
  } catch {
    console.log("  (install qrcode-terminal for a scannable QR code)");
  }
  console.log(`  Public host: ${publicUrl}`);
  console.log(`  Local:       ${URL}`);
  console.log("");
  info(
    "Keep this running to keep the link live. Press Ctrl+C to stop sharing."
  );
}

/** Kill a tunnel child by PID — tree-first on Windows (mirrors `stoa stop`). The
 *  tunnel is a public exposure, so teardown must be thorough: a bare child.kill()
 *  leaves a cmd.exe-shim grandchild (or any forked helper) orphaned and still serving. */
function stopTunnel(pid) {
  if (!pid) return;
  try {
    if (IS_WINDOWS) {
      spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
    } else {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        return; // already gone (ESRCH)
      }
      // Escalate to SIGKILL if it ignores SIGTERM — a public tunnel must not survive
      // teardown (mirrors `stoa stop`). The sync wait is safe in an 'exit' handler.
      if (!waitUntilDead(pid, 800)) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* gone */
        }
      }
    }
  } catch {
    /* best-effort */
  }
}

function writeSharePid(pid) {
  try {
    ensureDir(STOA_AUTH_HOME);
    fs.writeFileSync(SHARE_PID_FILE, String(pid), { mode: 0o600 });
  } catch {
    /* non-fatal */
  }
}

function clearSharePid() {
  try {
    fs.unlinkSync(SHARE_PID_FILE);
  } catch {
    /* ignore */
  }
}

/** Reap a tunnel orphaned by a previous `stoa share` that was HARD-killed (SIGKILL /
 *  crash) before its teardown ran: kill the still-live child and clear stale origins,
 *  so a public tunnel can never outlive the command that started it (SIGKILL is the
 *  one path in-process handlers can't catch — this backstops it on the next run). */
function reapStaleShare() {
  let pid = null;
  try {
    pid = parseInt(fs.readFileSync(SHARE_PID_FILE, "utf8").trim(), 10);
  } catch {
    return;
  }
  if (Number.isFinite(pid) && pid > 0 && isAlive(pid)) {
    warn(`Reaping an orphaned tunnel from a previous share (PID ${pid}).`);
    stopTunnel(pid);
  }
  clearSharePid();
  // A crashed run may have left its origin registered — clear the lot (a fresh share
  // re-registers its own). Safe: origins are public, non-secret.
  try {
    writeOriginsFile([]);
  } catch {
    /* best-effort */
  }
}

/** share: open a secure, token-gated tunnel to the local server + print a QR. */
async function cmdShare() {
  const authOff = (process.env.STOA_AUTH || "").toLowerCase() === "off";
  const probeStatus = await probeAuth(PORT);
  const token = readServerToken();
  const provider = selectTunnelProvider(
    resolveCommand("tailscale"),
    resolveCommand("cloudflared")
  );

  const decision = decideShare({ authOff, probeStatus, token, provider });
  if (!decision.ok) {
    error(decision.message);
    process.exit(1);
    return;
  }

  // Self-heal: kill any tunnel orphaned by a prior hard-killed share before starting.
  reapStaleShare();

  const spec = tunnelCommand(provider, PORT);
  const { file, args } = commandSpec(spec.cmd, spec.args);
  info(`Starting a ${provider} tunnel to ${URL} …`);

  // Don't hand Stoa's secrets to the tunnel binary — it needs none of them, and they
  // shouldn't sit in that process's environment (loadEnvFile hydrated them from .env).
  const childEnv = { ...process.env };
  for (const k of [
    "STOA_TOKEN",
    "STOA_VAPID_PRIVATE_KEY",
    "STOA_WEBHOOK_SECRET",
  ]) {
    delete childEnv[k];
  }

  const child = spawn(file, args, {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    env: childEnv,
  });
  if (child.pid) writeSharePid(child.pid);

  let registeredOrigin = null;
  let announced = false;
  let settled = false;
  let torn = false;

  // Synchronous teardown — safe to run from a process 'exit' handler (no async work).
  const cleanupSync = () => {
    if (torn) return;
    torn = true;
    if (registeredOrigin) {
      try {
        unregisterOrigin(registeredOrigin);
      } catch {
        /* best-effort */
      }
      registeredOrigin = null;
    }
    stopTunnel(child.pid);
    clearSharePid();
  };
  const onSignal = () => {
    cleanupSync();
    process.exit(0);
  };
  // Cover every CATCHABLE exit path so the public tunnel never outlives the command:
  // Ctrl+C (SIGINT), kill (SIGTERM), terminal close (SIGHUP), normal/`process.exit`
  // (exit), and a crash (uncaughtException). SIGKILL is uncatchable — reapStaleShare
  // handles that orphan on the next run.
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  process.on("SIGHUP", onSignal);
  process.on("exit", cleanupSync);
  process.on("uncaughtException", (err) => {
    error(`share crashed: ${err && err.message ? err.message : err}`);
    cleanupSync();
    process.exit(1);
  });

  const onLine = (line) => {
    if (announced) return;
    const url = parseTunnelUrl(provider, line);
    if (!url) return;
    announced = true;
    settled = true;
    const origin = originFromUrl(url);
    if (origin) {
      registeredOrigin = origin;
      try {
        registerOrigin(origin);
      } catch (e) {
        warn(`Couldn't register the tunnel origin: ${e.message}`);
      }
    }
    printShareBanner(formatShareUrl(url, token), url);
  };

  const wire = (stream) => {
    let buf = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        onLine(buf.slice(0, idx));
        buf = buf.slice(idx + 1);
      }
    });
  };
  wire(child.stdout);
  wire(child.stderr);

  child.on("error", (err) => {
    error(`Failed to start ${provider}: ${err.message}`);
    cleanupSync();
    process.exit(1);
  });
  child.on("exit", (code) => {
    cleanupSync();
    if (!settled) {
      error(
        `${provider} exited before a public URL was available (code ${code}). Is it installed and set up (e.g. \`tailscale up\` / cloudflared login)?`
      );
      process.exit(1);
      return;
    }
    info("Tunnel closed.");
    process.exit(code || 0);
  });

  setTimeout(() => {
    if (!announced) {
      warn(
        `No public URL from ${provider} yet — if it needs first-time setup, complete that and retry.`
      );
    }
  }, 15000);
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
  console.log(
    "  update      Update to the latest version (see --channel below)"
  );
  console.log("  doctor      Run preflight environment checks");
  console.log(
    "  statusline  Install the Claude rate-limit statusline hook (Agent Monitor quota)"
  );
  console.log(
    "  share       Share securely over a tunnel (Tailscale/cloudflared) with a QR"
  );
  console.log("");
  console.log("Update options:");
  console.log(
    "  update --channel <main|release>   Choose the update source (default: main)."
  );
  console.log(
    "    main     Track the main branch's latest commit (the default; today's behavior)."
  );
  console.log(
    "    release  OPT-IN: pin to the latest verified, immutable release tag instead of"
  );
  console.log(
    "             tracking main. Safer for production; `--channel main` reverts."
  );
  console.log("");
  console.log("Environment variables:");
  console.log("  STOA_HOME             Home directory (default: ~/.stoa)");
  console.log("  STOA_PORT             Server port (default: 3011)");
  console.log(
    "  STOA_UPDATE_CHANNEL   Default update channel: main (default) or release."
  );
  console.log("                        A `--channel` flag overrides it.");
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
      // Pass the args AFTER the subcommand so `update --channel release` (and
      // `--channel=release`) reach the channel resolver.
      cmdUpdate(process.argv.slice(3));
      break;
    case "doctor":
      // Fire-and-forget async: surface any unexpected throw as a clean failure
      // rather than an unhandled-rejection crash.
      cmdDoctor().catch((err) => {
        error(`doctor failed: ${err && err.message ? err.message : err}`);
        process.exit(1);
      });
      break;
    case "statusline":
      cmdStatusline();
      break;
    case "share":
      cmdShare().catch((err) => {
        error(`share failed: ${err && err.message ? err.message : err}`);
        process.exit(1);
      });
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
  parseEnvFile,
  loadEnvFile,
  serverEnv,
  commandSpec,
  buildIsComplete,
  waitUntilDead,
  // update channel (#56) — pure helpers, unit-tested
  UPDATE_CHANNELS,
  DEFAULT_UPDATE_CHANNEL,
  resolveUpdateChannel,
  parseRemoteTags,
  parseReleaseTag,
  compareReleaseTags,
  selectLatestReleaseTag,
  // doctor (DX #14) — pure helpers, unit-tested
  parseNodeMajor,
  checkNodeVersion,
  doctorExitCode,
  formatDoctorLine,
  parsePort,
  checkPortFree,
  checkNativeModule,
  isIgnoreScriptsEnabled,
  checkIgnoreScripts,
  NODE_MIN_MAJOR,
  NATIVE_MODULES,
  nativeRebuildArgs,
  toolchainHint,
  // statusline (M2b) - pure helpers, unit-tested
  statuslineHookPath,
  buildStatusLineCommand,
  isStoaStatusLine,
  mergeStatusLine,
  checkStatuslineHook,
  // share (#11) - pure helpers, unit-tested
  selectTunnelProvider,
  tunnelCommand,
  parseTunnelUrl,
  originFromUrl,
  formatShareUrl,
  addOriginToList,
  removeOriginFromList,
  decideShare,
};

// PORT is read from the current env on every access so tests that reload the
// module with different env values see the updated port without depending on
// require.cache invalidation.
Object.defineProperty(module.exports, "PORT", {
  get: () => process.env.STOA_PORT || process.env.PORT || "3011",
  enumerable: true,
});
