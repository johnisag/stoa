#!/usr/bin/env node
/*
 * Cross-platform Stoa setup (mirrors scripts/setup.sh).
 *
 * Checks prerequisites, copies .env.example if needed, and installs npm deps.
 * Runs natively on Windows, macOS, and Linux without requiring bash.
 */

"use strict";

const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const REPO_DIR = path.resolve(__dirname, "..");

function resolveCmd(cmd) {
  // npm is a .cmd shim on Windows; a bare "npm" ENOENTs under execFile.
  if (cmd === "npm" && process.platform === "win32") return "npm.cmd";
  return cmd;
}

function run(cmd, args = []) {
  return execFileSync(resolveCmd(cmd), args, {
    cwd: REPO_DIR,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  }).trim();
}

function hasCommand(cmd) {
  try {
    run(process.platform === "win32" ? "where" : "which", [cmd]);
    return true;
  } catch {
    return false;
  }
}

function warn(message) {
  console.warn(`Warning: ${message}`);
}

function fail(message) {
  console.error(`Error: ${message}`);
  process.exit(1);
}

function main() {
  console.log("Stoa Setup");
  console.log("==============");
  console.log();

  // Node.js
  let nodeVersion;
  try {
    nodeVersion = run("node", ["-v"]);
  } catch {
    fail(
      "Node.js is not installed. Install Node.js 24+ from https://nodejs.org"
    );
  }
  const major = parseInt(nodeVersion.replace(/^v/, "").split(".")[0], 10);
  if (Number.isNaN(major) || major < 24) {
    fail(`Node.js 24+ required (found ${nodeVersion})`);
  }
  console.log(`Node.js: ${nodeVersion}`);

  // Git
  if (!hasCommand("git")) {
    fail("Git is required but was not found");
  }
  console.log(`Git: ${run("git", ["--version"])}`);

  // tmux is only required on the tmux backend (default on macOS/Linux). The pty
  // backend (default on Windows, or via STOA_BACKEND=pty) does not need it.
  const backend = process.env.STOA_BACKEND || "";
  if (backend !== "pty") {
    if (!hasCommand("tmux")) {
      warn(
        "tmux is not installed. It is required unless you set STOA_BACKEND=pty"
      );
    } else {
      console.log(`tmux: ${run("tmux", ["-V"])}`);
    }
  }

  // At least one supported AI CLI should be available, but we no longer hard-
  // require Claude — users may prefer Codex, Hermes, Kilo Code, or Kimi Code.
  const agents = ["claude", "codex", "hermes", "kilo", "kimi"];
  const found = agents.filter(hasCommand);
  if (found.length === 0) {
    warn(
      "No supported AI agent CLI found (claude, codex, hermes, kilo, kimi). " +
        "Install at least one before creating an agent session."
    );
  } else {
    console.log(`AI agents found: ${found.join(", ")}`);
  }

  // jq is optional
  if (!hasCommand("jq")) {
    warn("jq is not installed (optional, for session ID parsing)");
  }

  // Copy .env if needed
  const envPath = path.join(REPO_DIR, ".env");
  const envExamplePath = path.join(REPO_DIR, ".env.example");
  if (!fs.existsSync(envPath) && fs.existsSync(envExamplePath)) {
    fs.copyFileSync(envExamplePath, envPath);
    console.log();
    console.log("Created .env from .env.example");
  }

  // Install dependencies
  console.log();
  console.log("Installing dependencies...");
  execFileSync(resolveCmd("npm"), ["install"], {
    cwd: REPO_DIR,
    stdio: "inherit",
    windowsHide: true,
  });

  console.log();
  console.log("Setup complete!");
  console.log("Run 'npm run dev' to start the development server");
}

if (require.main === module) {
  main();
}
