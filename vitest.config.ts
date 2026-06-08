import { defineConfig } from "vitest/config";
import { resolve } from "path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    setupFiles: ["test/setup.ts"],
    // pty integration tests spawn real processes; allow a little room.
    testTimeout: 15000,
  },
  resolve: {
    alias: {
      "@": resolve(__dirname, "."),
    },
  },
});
