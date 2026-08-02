"use strict";

const { spawn } = require("node:child_process");

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
});
process.stdin.on("end", () => {
  if (input.startsWith("TREE_REAP:")) {
    const marker = input.slice("TREE_REAP:".length);
    spawn(
      process.execPath,
      [
        "-e",
        "setTimeout(() => require('node:fs').writeFileSync(process.argv[1], 'orphan'), 1200)",
        marker,
      ],
      { stdio: "ignore", windowsHide: true }
    );
    process.stdout.write("x".repeat(128 * 1024));
    setInterval(() => undefined, 60 * 60 * 1000);
    return;
  }
  process.stdout.write(
    JSON.stringify({
      argv: process.argv.slice(2),
      input,
      inheritedStoaToken: process.env.STOA_TOKEN ?? null,
      inheritedGithubToken: process.env.GITHUB_TOKEN ?? null,
      anthropicKey: process.env.ANTHROPIC_API_KEY ?? null,
    })
  );
});
