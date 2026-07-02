"use client";

import { useCallback } from "react";

/**
 * #41 — Tap haptics for mobile.
 *
 * A feature-detected `navigator.vibrate` wrapper. Vibration is a mobile-only web
 * capability (desktop browsers don't implement it, or return false), so firing a
 * pattern is inherently a no-op on desktop and needs no separate `isMobile` gate —
 * the same reason the existing `useKeyRepeat` haptic fires unconditionally.
 *
 * SSR-safe: `navigator` is only touched behind a `typeof` guard, and every helper
 * silently no-ops when vibrate is unsupported (or the platform ignores it).
 *
 * The pattern DECISION is a pure function (`hapticPattern`) so tests need no
 * navigator: they assert the millisecond pattern per kind directly.
 */

/** The tactile events Stoa taps out. Subtle, short, and distinct per action. */
export type HapticKind = "send" | "approve" | "kill" | "copy";

/**
 * Pure: the vibration pattern (in ms) for a haptic kind, or `null` for an
 * unknown kind (which callers treat as "don't vibrate"). Patterns are short and
 * subtle (~10-20ms) and distinct enough to feel different:
 *   - send    → one crisp 12ms tick (the everyday, most-frequent action)
 *   - approve → a light double tap (a small "yes" flourish)
 *   - kill    → one firmer 20ms buzz (a heavier, more deliberate action)
 *   - copy    → the lightest 10ms tick (an incidental confirmation)
 *
 * A single number and a `[number]` are equivalent to `navigator.vibrate`; we use
 * arrays for the multi-pulse patterns and a bare number for single pulses.
 */
export function hapticPattern(kind: HapticKind): number | number[] | null {
  switch (kind) {
    case "send":
      return 12;
    case "approve":
      // pulse, gap, pulse — a gentle double tap
      return [10, 30, 10];
    case "kill":
      return 20;
    case "copy":
      return 10;
    default:
      // Exhaustiveness: an unknown kind never vibrates.
      return null;
  }
}

/**
 * Pure-ish feature detection (reads `navigator` behind a `typeof` guard so it's
 * SSR-safe). Returns false during SSR and on any platform without the Vibration
 * API (i.e. every desktop browser).
 */
export function hapticsSupported(): boolean {
  return (
    typeof navigator !== "undefined" && typeof navigator.vibrate === "function"
  );
}

/**
 * Fire the haptic for `kind`. Silent no-op when unsupported, when the kind has no
 * pattern, or if the platform rejects/throws (some browsers throw from vibrate
 * inside a cross-origin iframe or without a user gesture). Never throws.
 */
export function triggerHaptic(kind: HapticKind): void {
  if (!hapticsSupported()) return;
  const pattern = hapticPattern(kind);
  if (pattern === null) return;
  try {
    navigator.vibrate(pattern);
  } catch {
    // Some engines throw instead of returning false — swallow: haptics are
    // a nice-to-have, never a failure path for the action that triggered them.
  }
}

/**
 * Hook wrapper: returns a stable `haptic(kind)` callback so components can wire a
 * one-line tick at a tap handler without re-importing the module function. The
 * identity is stable (empty deps) so it doesn't defeat a memo'd child.
 */
export function useHaptics(): { haptic: (kind: HapticKind) => void } {
  const haptic = useCallback((kind: HapticKind) => triggerHaptic(kind), []);
  return { haptic };
}
