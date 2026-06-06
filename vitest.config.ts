import { defineConfig } from "vitest/config";
import { resolve } from "path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // pty integration tests spawn real processes; allow a little room.
    testTimeout: 15000,
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
