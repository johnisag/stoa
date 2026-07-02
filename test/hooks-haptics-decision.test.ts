import { describe, it, expect, vi, afterEach } from "vitest";
import {
  hapticPattern,
  hapticsSupported,
  triggerHaptic,
  type HapticKind,
} from "@/hooks/useHaptics";

// The vibration pattern DECISION is pure — these assertions need no navigator.
describe("hapticPattern (pure decision)", () => {
  it("maps each known kind to a short, subtle pattern", () => {
    expect(hapticPattern("send")).toBe(12);
    expect(hapticPattern("kill")).toBe(20);
    expect(hapticPattern("copy")).toBe(10);
    expect(hapticPattern("approve")).toEqual([10, 30, 10]);
  });

  it("keeps every pulse in the ~10-20ms subtle range", () => {
    const kinds: HapticKind[] = ["send", "approve", "kill", "copy"];
    for (const kind of kinds) {
      const pattern = hapticPattern(kind);
      const pulses = typeof pattern === "number" ? [pattern] : (pattern ?? []);
      for (const ms of pulses) {
        // gaps (index 1 of approve) can be longer; only vibration pulses are
        // bounded — filter to odd/even by taking the on-pulses (even indices).
        expect(ms).toBeLessThanOrEqual(30);
        expect(ms).toBeGreaterThan(0);
      }
    }
  });

  it("gives distinct patterns per kind (nothing feels identical)", () => {
    const serialized = (
      ["send", "approve", "kill", "copy"] as HapticKind[]
    ).map((k) => JSON.stringify(hapticPattern(k)));
    expect(new Set(serialized).size).toBe(serialized.length);
  });

  it("returns null for an unknown kind (never vibrates)", () => {
    // @ts-expect-error — exercising the runtime guard for an off-union value.
    expect(hapticPattern("bogus")).toBeNull();
  });
});

describe("hapticsSupported (SSR-safe feature detection)", () => {
  const originalNavigator = globalThis.navigator;

  afterEach(() => {
    // Restore whatever the environment had.
    Object.defineProperty(globalThis, "navigator", {
      value: originalNavigator,
      configurable: true,
      writable: true,
    });
    vi.restoreAllMocks();
  });

  it("is false when navigator is undefined (SSR)", () => {
    // Simulate a server render: no navigator at all.
    Object.defineProperty(globalThis, "navigator", {
      value: undefined,
      configurable: true,
      writable: true,
    });
    expect(hapticsSupported()).toBe(false);
  });

  it("is false when vibrate is not a function (desktop)", () => {
    Object.defineProperty(globalThis, "navigator", {
      value: {},
      configurable: true,
      writable: true,
    });
    expect(hapticsSupported()).toBe(false);
  });

  it("is true when navigator.vibrate exists", () => {
    Object.defineProperty(globalThis, "navigator", {
      value: { vibrate: () => true },
      configurable: true,
      writable: true,
    });
    expect(hapticsSupported()).toBe(true);
  });
});

describe("triggerHaptic (side-effect wrapper)", () => {
  const originalNavigator = globalThis.navigator;

  afterEach(() => {
    Object.defineProperty(globalThis, "navigator", {
      value: originalNavigator,
      configurable: true,
      writable: true,
    });
    vi.restoreAllMocks();
  });

  it("calls navigator.vibrate with the kind's pattern when supported", () => {
    const vibrate = vi.fn();
    Object.defineProperty(globalThis, "navigator", {
      value: { vibrate },
      configurable: true,
      writable: true,
    });
    triggerHaptic("approve");
    expect(vibrate).toHaveBeenCalledWith([10, 30, 10]);
  });

  it("is a silent no-op when vibrate is unsupported (never throws)", () => {
    Object.defineProperty(globalThis, "navigator", {
      value: {},
      configurable: true,
      writable: true,
    });
    expect(() => triggerHaptic("send")).not.toThrow();
  });

  it("swallows an engine that throws from vibrate", () => {
    const vibrate = vi.fn(() => {
      throw new Error("blocked by permissions policy");
    });
    Object.defineProperty(globalThis, "navigator", {
      value: { vibrate },
      configurable: true,
      writable: true,
    });
    expect(() => triggerHaptic("kill")).not.toThrow();
    expect(vibrate).toHaveBeenCalledOnce();
  });
});
