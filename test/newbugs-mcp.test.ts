import { describe, it, expect } from "vitest";
import {
  SPAWNABLE_AGENTS,
  requireString,
  clampLines,
} from "@/mcp/orchestration-tools";

describe("SPAWNABLE_AGENTS (spawn_worker enum source)", () => {
  it("includes kilo and kimi (so they're reachable via MCP)", () => {
    expect(SPAWNABLE_AGENTS).toContain("kilo");
    expect(SPAWNABLE_AGENTS).toContain("kimi");
    expect(SPAWNABLE_AGENTS).toContain("claude");
  });
});

describe("requireString", () => {
  it("returns a present non-empty string", () => {
    expect(requireString({ workerId: "abc" }, "workerId")).toBe("abc");
  });

  it("throws a clear error when missing/empty (no /workers/undefined)", () => {
    expect(() => requireString(undefined, "workerId")).toThrow(/workerId/);
    expect(() => requireString({}, "workerId")).toThrow(/workerId/);
    expect(() => requireString({ workerId: "  " }, "workerId")).toThrow(
      /workerId/
    );
    expect(() => requireString({ workerId: 5 }, "workerId")).toThrow(
      /workerId/
    );
  });
});

describe("clampLines", () => {
  it("defaults to 50 for missing/garbage and clamps the range", () => {
    expect(clampLines(undefined)).toBe(50);
    expect(clampLines("nope")).toBe(50);
    expect(clampLines(0)).toBe(50);
    expect(clampLines(-3)).toBe(50);
    expect(clampLines("120")).toBe(120);
    expect(clampLines(999999)).toBe(10000);
  });
});
