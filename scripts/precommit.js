#!/usr/bin/env node
// Cross-platform pre-commit hook: formats staged files with prettier and runs typecheck.
// Implemented in Node so it works identically on Windows (native), macOS, and Linux.
//
// We invoke the resolved JS entrypoints with `node` directly rather than the
// npx/prettier/tsc .cmd shims — on Windows spawnSync cannot launch a .cmd
// without a shell, and shell mode mangles file args containing spaces.

const { execFileSync, spawnSync } = require("node:child_process");

/** Run a Node script (absolute .js/.cjs path) with inherited stdio. */
function runNode(jsPath, args) {
  return spawnSync(process.execPath, [jsPath, ...args], { stdio: "inherit" });
}

function fail(step, result) {
  if (result.error) {
    console.error(`pre-commit: ${step} failed to start:`, result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

console.log("🔍 Running pre-commit checks...");

console.log("💅 Formatting staged files...");
const out = execFileSync(
  "git",
  ["diff", "--cached", "--name-only", "--diff-filter=ACMR"],
  { encoding: "utf8" }
);
const staged = out
  .split(/\r?\n/)
  .map((f) => f.trim())
  .filter((f) => /\.(js|jsx|ts|tsx|json|css|md)$/.test(f));

if (staged.length > 0) {
  const prettierBin = require.resolve("prettier/bin/prettier.cjs");
  fail("prettier", runNode(prettierBin, ["--write", ...staged]));
  fail(
    "git add",
    spawnSync("git", ["add", "--", ...staged], { stdio: "inherit" })
  );
}

console.log("📝 Type checking...");
const tscBin = require.resolve("typescript/bin/tsc");
fail("typecheck", runNode(tscBin, ["--noEmit"]));

console.log("✅ Pre-commit checks passed!");
