import { defineConfig, configDefaults } from "vitest/config";
import { resolve } from "path";

// node-pty/ConPTY segfaults the worker fork when MULTIPLE real-pty test files run
// in PARALLEL forks — a native crash with no JS stack ("worker exited
// unexpectedly"), which fails whatever unrelated file happened to share that run.
// Corral every real-pty integration test into ONE sequential fork so there is
// never concurrent ConPTY activity; everything else stays fully parallel.
// (Empirically: parallel ≈ 2 crashes / 8 runs, sequential = 0 / 8+.)
const PTY_TESTS = [
  "test/pty-backend.test.ts",
  "test/pty-session.test.ts",
  "test/pty-host.test.ts",
  "test/pty-host-spawn.test.ts",
  "test/observer-attach.test.ts",
  "test/status-render.test.ts",
  "test/hermes-session-id.test.ts",
  "test/kimi-session-id.test.ts",
];

export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["test/setup.ts"],
    // pty integration tests spawn real processes; allow a little room.
    testTimeout: 15000,
    // Pin NODE_ENV=test for the workers. A shell that inherits NODE_ENV=production
    // (e.g. a prod-started dev server) otherwise makes React load its production
    // build, which has no act() support — silently failing every React component
    // test (terminal-relaunch, terminal-connection-rebuild). CI doesn't set it, so
    // this just makes local match CI instead of going red on an env quirk.
    env: { NODE_ENV: "test" },
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ["test/**/*.test.{ts,tsx}"],
          exclude: [...configDefaults.exclude, ...PTY_TESTS],
        },
      },
      {
        extends: true,
        test: {
          name: "pty",
          include: PTY_TESTS,
          // Files run sequentially (never two pty files at once) → no concurrent
          // ConPTY → no native segfault. This project runs alongside the parallel
          // "unit" project, whose forks never touch node-pty, so there is no
          // contention. (poolOptions is root-only in Vitest 4; fileParallelism on
          // the project is what serializes these files.)
          fileParallelism: false,
        },
      },
    ],
  },
  resolve: {
    alias: {
      "@": resolve(__dirname, "."),
    },
  },
});
