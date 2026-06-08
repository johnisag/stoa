import { defineConfig } from "vitest/config";
import { resolve } from "path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // pty integration tests spawn real processes; allow a little room.
    testTimeout: 15000,
    // Windows-only flake guard: node-pty's ConPTY backend intermittently fails a
    // live spawn on the headless windows-latest CI runner (e.g. "File not found:"
    // from WindowsPtyAgent, alongside non-fatal "AttachConsole failed" agent
    // noise) — a CI-timing issue, not a code defect (the same tests pass in
    // isolation). Retrying a FAILED test in-run lets a transient flake self-heal
    // so a green run no longer needs a manual job re-run. A real bug fails all
    // attempts, so this masks nothing. macOS/Linux stay strict (retry: 0).
    retry: process.platform === "win32" ? 2 : 0,
    // Pin NODE_ENV=test for the workers. A shell that inherits NODE_ENV=production
    // (e.g. a prod-started dev server) otherwise makes React load its production
    // build, which has no act() support — silently failing every React component
    // test (terminal-relaunch, terminal-connection-rebuild). CI doesn't set it, so
    // this just makes local match CI instead of going red on an env quirk.
    env: { NODE_ENV: "test" },
  },
  resolve: {
    alias: {
      "@": resolve(__dirname, "."),
    },
  },
});
