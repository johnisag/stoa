import { describe, it, expect } from "vitest";
import { validateScope, hashToken } from "../lib/tokens";

describe("validateScope", () => {
  it("accepts admin and observer", () => {
    expect(validateScope("admin")).toBe("admin");
    expect(validateScope("observer")).toBe("observer");
  });

  it("rejects other values", () => {
    expect(() => validateScope("superadmin")).toThrow();
    expect(() => validateScope("")).toThrow();
    expect(() => validateScope(null)).toThrow();
    expect(() => validateScope(undefined)).toThrow();
    expect(() => validateScope(123)).toThrow();
  });
});

describe("hashToken", () => {
  it("produces a deterministic SHA-256 hex hash", () => {
    const hash = hashToken("my-secret-token");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    // Same input → same hash.
    expect(hashToken("my-secret-token")).toBe(hash);
    // Different input → different hash.
    expect(hashToken("other-secret")).not.toBe(hash);
  });

  it("handles empty strings", () => {
    const hash = hashToken("");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});
