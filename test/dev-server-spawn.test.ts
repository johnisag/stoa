import { describe, it, expect } from "vitest";
import { resolveDevServerSpawn } from "@/lib/dev-servers";

// Regression: a Windows .cmd/.bat shim (npm/npx/yarn/pnpm/next) spawned directly
// with shell:false throws EINVAL (CVE-2024-27980 hardening, Node ≥18.20). It must
// be routed through cmd.exe /c. Pure helper, asserted on every OS via `onWindows`.
describe("resolveDevServerSpawn", () => {
  it("routes a Windows .cmd shim through cmd.exe /c", () => {
    const r = resolveDevServerSpawn(
      "C:\\nodejs\\npm.cmd",
      ["run", "dev"],
      true
    );
    expect(r.file.toLowerCase()).toMatch(/cmd\.exe$/);
    expect(r.args).toEqual(["/c", "C:\\nodejs\\npm.cmd", "run", "dev"]);
  });

  it("routes a Windows .bat shim through cmd.exe /c", () => {
    const r = resolveDevServerSpawn("C:\\tools\\foo.bat", ["serve"], true);
    expect(r.args).toEqual(["/c", "C:\\tools\\foo.bat", "serve"]);
  });

  it("spawns a real Windows .exe directly (no wrapping)", () => {
    const r = resolveDevServerSpawn(
      "C:\\nodejs\\node.exe",
      ["server.js"],
      true
    );
    expect(r).toEqual({ file: "C:\\nodejs\\node.exe", args: ["server.js"] });
  });

  it("spawns directly on POSIX (.cmd routing is Windows-only)", () => {
    const r = resolveDevServerSpawn("/usr/bin/npm", ["run", "dev"], false);
    expect(r).toEqual({ file: "/usr/bin/npm", args: ["run", "dev"] });
  });
});
