import { describe, it, expect } from "vitest";
import {
  claudeProjectDirName,
  expandHome,
  baseName,
  isPortInUse,
  resolveBinary,
  defaultInteractiveShell,
} from "@/lib/platform";
import os from "os";
import path from "path";
import net from "net";

describe("claudeProjectDirName", () => {
  it("encodes a Windows path to Claude's project-dir convention", () => {
    // Verified on disk: C:\my-projects\stoa -> c--my-projects-stoa
    expect(claudeProjectDirName("C:\\my-projects\\stoa")).toBe(
      "c--my-projects-stoa"
    );
  });

  it("lowercases the drive letter and handles forward slashes too", () => {
    expect(claudeProjectDirName("D:/Work/proj")).toBe("d--Work-proj");
  });

  it("encodes a POSIX path (leading separator -> leading dash)", () => {
    expect(claudeProjectDirName("/Users/me/my-projects/stoa")).toBe(
      "-Users-me-my-projects-stoa"
    );
  });

  it("replaces dots in path segments (the regression case)", () => {
    expect(claudeProjectDirName("C:\\src\\my.app")).toBe("c--src-my-app");
    expect(claudeProjectDirName("/home/me/.config/x")).toBe(
      "-home-me--config-x"
    );
  });
});

describe("expandHome", () => {
  it("expands a leading ~ to the home directory", () => {
    expect(expandHome("~")).toBe(os.homedir());
    expect(expandHome(path.join("~", "x"))).toBe(path.join(os.homedir(), "x"));
  });
  it("leaves non-tilde paths unchanged", () => {
    expect(expandHome("C:\\abs\\path")).toBe("C:\\abs\\path");
    expect(expandHome("/abs/path")).toBe("/abs/path");
  });
});

describe("baseName (re-exported pure helper)", () => {
  it("is separator-agnostic", () => {
    expect(baseName("C:\\my-projects\\stoa")).toBe("stoa");
    expect(baseName("/a/b/c")).toBe("c");
  });
});

describe("isPortInUse", () => {
  it("is true while a port is bound and false once it's free", async () => {
    const srv = net.createServer();
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    const port = (srv.address() as net.AddressInfo).port;
    expect(await isPortInUse(port)).toBe(true);
    await new Promise<void>((r) => srv.close(() => r()));
    expect(await isPortInUse(port)).toBe(false);
  });
});

describe("resolveBinary / defaultInteractiveShell", () => {
  it("resolves node (on PATH in every environment)", () => {
    const resolved = resolveBinary("node");
    expect(resolved).toBeTruthy();
    expect(resolved!.toLowerCase()).toContain("node");
  });
  it("returns null for a binary that does not exist", () => {
    expect(resolveBinary("definitely-not-a-real-binary-xyz")).toBeNull();
  });
  it("picks a non-empty interactive shell for the platform", () => {
    expect(defaultInteractiveShell().length).toBeGreaterThan(0);
  });
});
