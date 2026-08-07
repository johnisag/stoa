import { describe, it, expect } from "vitest";
import type { WaitTargetStatus } from "@/lib/agent-coordination";

// The agent-coordination module's core logic (read/wait/prompt) hits the DB
// and session backend, so we test the pure parts here: the WaitTargetStatus
// type contract and the validation logic used by the API routes.

const VALID_TARGETS: WaitTargetStatus[] = [
  "running",
  "waiting",
  "idle",
  "error",
  "dead",
];

describe("WaitTargetStatus type contract", () => {
  it("includes the five SessionStatus values", () => {
    expect(VALID_TARGETS).toContain("running");
    expect(VALID_TARGETS).toContain("waiting");
    expect(VALID_TARGETS).toContain("idle");
    expect(VALID_TARGETS).toContain("error");
    expect(VALID_TARGETS).toContain("dead");
  });
});

describe("wait API validation logic", () => {
  // Mirror the validation in app/api/sessions/[id]/wait/route.ts
  const VALID_SET = new Set<WaitTargetStatus>(VALID_TARGETS);

  it("accepts all valid target statuses", () => {
    for (const target of VALID_TARGETS) {
      expect(VALID_SET.has(target)).toBe(true);
    }
  });

  it("rejects invalid target statuses", () => {
    const invalid = [
      "blocked", // Herdr uses "blocked", Stoa uses "waiting"
      "done", // Herdr uses "done", Stoa uses "idle"
      "unknown",
      "",
      "RUNNING", // case-sensitive
    ];
    for (const target of invalid) {
      expect(VALID_SET.has(target as WaitTargetStatus)).toBe(false);
    }
  });
});

describe("timeout capping logic", () => {
  // Mirror the cap in app/api/sessions/[id]/wait/route.ts
  const MAX_WAIT_MS = 300_000;
  function capTimeout(requested: number | undefined): number {
    return Math.min(requested ?? 120_000, MAX_WAIT_MS);
  }

  it("defaults to 120 seconds when unspecified", () => {
    expect(capTimeout(undefined)).toBe(120_000);
  });

  it("caps at 5 minutes", () => {
    expect(capTimeout(600_000)).toBe(MAX_WAIT_MS);
    expect(capTimeout(300_000)).toBe(300_000);
  });

  it("passes through values under the cap", () => {
    expect(capTimeout(5_000)).toBe(5_000);
    expect(capTimeout(60_000)).toBe(60_000);
  });
});

describe("poll interval capping logic", () => {
  // Mirror the floor in app/api/sessions/[id]/wait/route.ts
  const MIN_POLL_MS = 250;
  function floorPoll(requested: number | undefined): number {
    return Math.max(requested ?? 1000, MIN_POLL_MS);
  }

  it("defaults to 1000ms when unspecified", () => {
    expect(floorPoll(undefined)).toBe(1000);
  });

  it("floors at 250ms to prevent tight-loop exhaustion", () => {
    expect(floorPoll(1)).toBe(MIN_POLL_MS);
    expect(floorPoll(100)).toBe(MIN_POLL_MS);
    expect(floorPoll(249)).toBe(MIN_POLL_MS);
  });

  it("passes through values at or above the floor", () => {
    expect(floorPoll(250)).toBe(250);
    expect(floorPoll(1000)).toBe(1000);
    expect(floorPoll(5000)).toBe(5000);
  });
});
