import { describe, it, expect } from "vitest";
import { claudeProjectDirName, expandHome, baseName } from "@/lib/platform";
import os from "os";
import path from "path";

describe("claudeProjectDirName", () => {
  it("encodes a Windows path to Claude's project-dir convention", () => {
    // Verified on disk: C:\my-projects\agent-os -> c--my-projects-agent-os
    expect(claudeProjectDirName("C:\\my-projects\\agent-os")).toBe(
      "c--my-projects-agent-os"
    );
  });

  it("lowercases the drive letter and handles forward slashes too", () => {
    expect(claudeProjectDirName("D:/Work/proj")).toBe("d--Work-proj");
  });

  it("encodes a POSIX path (leading separator -> leading dash)", () => {
    expect(claudeProjectDirName("/Users/me/my-projects/agent-os")).toBe(
      "-Users-me-my-projects-agent-os"
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
    expect(baseName("C:\\my-projects\\agent-os")).toBe("agent-os");
    expect(baseName("/a/b/c")).toBe("c");
  });
});
