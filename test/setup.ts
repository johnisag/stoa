import childProcess from "node:child_process";

// Some browser-targeted dependencies (e.g. @xterm/addon-canvas) reference the
// global `self` at module load. Provide it in the Node test environment.
(globalThis as any).self = globalThis;

const originalFork = childProcess.fork as (...args: unknown[]) => unknown;

childProcess.fork = ((...args: unknown[]) => {
  const modulePath = String(args[0]).replace(/\\/g, "/");

  if (
    process.platform === "win32" &&
    modulePath.endsWith("/node-pty/lib/conpty_console_list_agent")
  ) {
    const optionsIndex = Array.isArray(args[1]) ? 2 : 1;
    const current = args[optionsIndex];
    const options =
      current && typeof current === "object" && !Array.isArray(current)
        ? current
        : {};

    args[optionsIndex] = { ...options, silent: true };
  }

  return originalFork.apply(childProcess, args);
}) as typeof childProcess.fork;
