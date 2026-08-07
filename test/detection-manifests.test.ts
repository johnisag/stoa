import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  validateManifest,
  type AgentManifest,
} from "@/lib/detection/manifests";

// We test validateManifest (pure function) directly — no filesystem needed.
// The load/compile path is tested separately via integration.

describe("validateManifest", () => {
  const valid = {
    id: "claude",
    version: 1,
    waiting: ["\\[Y/n\\]", "Allow\\?"],
    running: ["esc to interrupt", "⠋|⠙|⠹"],
    error: ["Error code: \\d{3}"],
    idle: ["\\$\\s*$"],
  };

  it("accepts a well-formed manifest", () => {
    const result = validateManifest(valid, "claude");
    expect(result).not.toBeNull();
    expect(result!.id).toBe("claude");
    expect(result!.version).toBe(1);
    expect(result!.waiting).toEqual(["\\[Y/n\\]", "Allow\\?"]);
    expect(result!.running).toEqual(["esc to interrupt", "⠋|⠙|⠹"]);
  });

  it("rejects a mismatched id", () => {
    const result = validateManifest(valid, "codex");
    expect(result).toBeNull();
  });

  it("rejects a non-object input", () => {
    expect(validateManifest(null, "claude")).toBeNull();
    expect(validateManifest("string", "claude")).toBeNull();
    expect(validateManifest(42, "claude")).toBeNull();
    expect(validateManifest(undefined, "claude")).toBeNull();
  });

  it("rejects a missing version", () => {
    const noVersion = { ...valid, version: undefined } as unknown;
    expect(validateManifest(noVersion, "claude")).toBeNull();
  });

  it("rejects a non-integer version", () => {
    expect(validateManifest({ ...valid, version: 1.5 }, "claude")).toBeNull();
  });

  it("rejects non-array pattern fields", () => {
    expect(
      validateManifest({ ...valid, waiting: "[Y/n]" }, "claude")
    ).toBeNull();
    expect(validateManifest({ ...valid, running: "esc" }, "claude")).toBeNull();
  });

  it("rejects a non-string element in a pattern array", () => {
    expect(
      validateManifest({ ...valid, waiting: ["ok", 42] }, "claude")
    ).toBeNull();
  });

  it("rejects invalid regex in patterns", () => {
    // Unterminated character class — invalid regex
    expect(
      validateManifest({ ...valid, waiting: ["[unclosed"] }, "claude")
    ).toBeNull();
  });

  it("accepts empty pattern arrays", () => {
    const emptyPatterns = {
      ...valid,
      waiting: [],
      running: [],
      error: [],
      idle: [],
    };
    const result = validateManifest(emptyPatterns, "claude");
    expect(result).not.toBeNull();
    expect(result!.waiting).toEqual([]);
  });

  it("accepts complex regex patterns", () => {
    const complex: AgentManifest = {
      id: "codex",
      version: 2,
      waiting: [
        "Enter to confirm.*Esc to cancel",
        ">\\s*1\\.\\s*Yes",
        "\\bError code: \\d{3}\\b[^\\n]*\\binvalid_request_error\\b",
      ],
      running: ["⠋|⠙|⠹|⠸|⠼|⠴|⠦|⠧|⠇|⠏"],
      error: ["\\bquota (exceeded|exhausted)\\b"],
      idle: ["\\$\\s*$", ">\\s*$", "%\\s*$"],
    };
    const result = validateManifest(complex, "codex");
    expect(result).not.toBeNull();
    expect(result!.waiting).toHaveLength(3);
  });
});
