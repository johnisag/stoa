"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * #41 — Pull-to-refresh for the mobile session list.
 *
 * The THRESHOLD / drag decision is a PURE state machine (`pullReducer`) so it is
 * unit-testable with no DOM: given the current state and a touch event, it returns
 * the next state and whether a refresh should fire. The hook below is a thin shell
 * that binds real touch events to it and calls the caller's existing refetch.
 */

/** How far (px, after resistance) the user must drag before releasing refreshes. */
export const PULL_THRESHOLD_PX = 64;

/**
 * Elastic resistance divisor: raw finger travel is divided by this so the
 * indicator drags with a rubber-band feel and can't be flung arbitrarily far.
 */
export const PULL_RESISTANCE = 2;

/** Hard cap on the visible pull distance so the indicator never runs away. */
export const PULL_MAX_PX = 96;

/**
 * Upper bound (ms) on how long the indicator stays in "refreshing" before it
 * collapses regardless of the refetch. The list's refetch is a React Query
 * invalidate, and this repo's QueryClient uses the default `networkMode:
 * "online"` — so an OFFLINE pull leaves the refetch PAUSED and its promise
 * pending until connectivity returns. Without this bound the indicator would
 * spin forever; with it, it always settles.
 */
export const PULL_SETTLE_TIMEOUT_MS = 8000;

export type PullPhase =
  /** Not pulling. */
  | "idle"
  /** Dragging down but not yet past the threshold — release snaps back. */
  | "pulling"
  /** Dragged past the threshold — release triggers a refresh. */
  | "armed"
  /** Refresh in flight; ignore further drags until it resolves. */
  | "refreshing";

export interface PullState {
  phase: PullPhase;
  /** Current visible pull distance in px (post-resistance, clamped). */
  distance: number;
}

export const INITIAL_PULL_STATE: PullState = { phase: "idle", distance: 0 };

export type PullEvent =
  /** Touch went down. `atTop` = the scroll container is scrolled to the very top. */
  | { type: "start"; atTop: boolean }
  /** Finger moved. `rawDelta` = current Y minus start Y (px); positive = downward. */
  | { type: "move"; rawDelta: number }
  /** Finger lifted / touch cancelled. */
  | { type: "end" }
  /** The refresh the caller kicked off has resolved (success or failure). */
  | { type: "settle" };

export interface PullResult {
  state: PullState;
  /** True exactly once, on the transition into "refreshing" — the caller fires
   *  its refetch on this edge. */
  shouldRefresh: boolean;
}

/** Clamp a post-resistance distance into [0, PULL_MAX_PX]. */
function clampDistance(px: number): number {
  if (px < 0) return 0;
  if (px > PULL_MAX_PX) return PULL_MAX_PX;
  return px;
}

/**
 * Pure state machine. Never mutates its input; returns the next state plus a
 * one-shot `shouldRefresh` flag on the edge into "refreshing".
 *
 * Rules:
 *   - A pull is only recognized if it STARTS at the top of the scroll container.
 *     A `start` when `atTop` is false leaves us idle, so a mid-list drag never
 *     hijacks the normal scroll.
 *   - Only DOWNWARD travel counts; an upward drag keeps distance at 0 (so a scroll
 *     up at the very top doesn't render a phantom pull).
 *   - Crossing the threshold arms; dropping back under it disarms (both directions),
 *     so the user can preview and back out.
 *   - Releasing while armed → refreshing (fires the refetch); releasing while merely
 *     pulling → snap back to idle.
 *   - While refreshing, drags are ignored until `settle`.
 */
export function pullReducer(state: PullState, event: PullEvent): PullResult {
  switch (event.type) {
    case "start": {
      // A fresh gesture. Only enter the pull machine when the list is at the top;
      // otherwise stay idle so normal scrolling is untouched. Never interrupt an
      // in-flight refresh.
      if (state.phase === "refreshing") {
        return { state, shouldRefresh: false };
      }
      return {
        state: event.atTop
          ? { phase: "pulling", distance: 0 }
          : INITIAL_PULL_STATE,
        shouldRefresh: false,
      };
    }

    case "move": {
      // Only act while actively pulling (start already gated on atTop). Ignore
      // moves when idle (drag didn't start at top) or refreshing.
      if (state.phase !== "pulling" && state.phase !== "armed") {
        return { state, shouldRefresh: false };
      }
      const distance = clampDistance(event.rawDelta / PULL_RESISTANCE);
      const phase: PullPhase =
        distance >= PULL_THRESHOLD_PX ? "armed" : "pulling";
      return { state: { phase, distance }, shouldRefresh: false };
    }

    case "end": {
      if (state.phase === "armed") {
        // Commit: enter refreshing and tell the caller to refetch. Hold the
        // indicator at the threshold height while the refresh runs.
        return {
          state: { phase: "refreshing", distance: PULL_THRESHOLD_PX },
          shouldRefresh: true,
        };
      }
      if (state.phase === "pulling") {
        // Under threshold — snap back, no refresh.
        return { state: INITIAL_PULL_STATE, shouldRefresh: false };
      }
      // idle / refreshing — nothing to release.
      return { state, shouldRefresh: false };
    }

    case "settle": {
      // Refresh resolved — collapse the indicator back to rest. A `settle` in any
      // other phase is a harmless no-op (defensive against out-of-order calls).
      if (state.phase === "refreshing") {
        return { state: INITIAL_PULL_STATE, shouldRefresh: false };
      }
      return { state, shouldRefresh: false };
    }

    default:
      return { state, shouldRefresh: false };
  }
}

export interface UsePullToRefreshOptions {
  /** Whether pull-to-refresh is active at all (gate on mobile). */
  enabled: boolean;
  /** The existing refresh the list uses (e.g. a React Query invalidate/refetch). */
  onRefresh: () => Promise<unknown> | void;
  /**
   * The element whose `scrollTop` decides "at top". Required so the touch
   * handlers can live on a wrapper while the scroll position is read off the real
   * scroll container (e.g. a Radix ScrollArea viewport). When null/undefined we
   * fall back to the touch target's own `scrollTop`.
   */
  scrollRef?: React.RefObject<HTMLElement | null>;
}

export interface UsePullToRefreshReturn {
  /** Attach to the SCROLLABLE element (the one whose scrollTop is read). */
  bind: {
    onTouchStart: (e: React.TouchEvent) => void;
    onTouchMove: (e: React.TouchEvent) => void;
    onTouchEnd: () => void;
  };
  /** Live pull distance (px) for the indicator. */
  distance: number;
  phase: PullPhase;
  /** Convenience: threshold reached (armed or refreshing). */
  isArmed: boolean;
  isRefreshing: boolean;
  threshold: number;
}

/**
 * Wire the pure machine to real touch events on a scroll container.
 *
 * Deliberately touch-only and cooperative: it reads `scrollTop` at touch-start and
 * only arms the machine when already at the very top, so it never fights an
 * in-progress scroll (matching the Terminal touch-scroll's direction-lock
 * philosophy). It does not `preventDefault` — the browser's own overscroll is left
 * intact; we only render a small indicator on top.
 */
export function usePullToRefresh({
  enabled,
  onRefresh,
  scrollRef,
}: UsePullToRefreshOptions): UsePullToRefreshReturn {
  const [state, setState] = useState<PullState>(INITIAL_PULL_STATE);

  // Track the start Y and whether this gesture began at the top, via refs so the
  // move/end handlers don't need to re-bind on every render.
  const startYRef = useRef(0);
  const activeRef = useRef(false);
  const onRefreshRef = useRef(onRefresh);
  onRefreshRef.current = onRefresh;
  // Guards the refetch to exactly once per entry into "refreshing" (survives a
  // StrictMode double-invoke of the effect below, which re-runs setup after an
  // empty cleanup).
  const refreshInFlightRef = useRef(false);

  const dispatch = useCallback((event: PullEvent) => {
    // The updater stays PURE — the refetch side effect is fired from the effect
    // below, off the render path, never from inside setState.
    setState((prev) => pullReducer(prev, event).state);
  }, []);

  // Fire the caller's refetch when the machine ENTERS "refreshing", then settle
  // regardless of outcome. Deliberately robust: a `.then(() => fn())` turns a
  // SYNCHRONOUS throw from a sync callback into a rejection, `.catch` swallows a
  // failed refresh (a network error must still collapse the indicator), and a
  // timeout collapses it even if the refetch never settles (paused offline).
  useEffect(() => {
    if (state.phase !== "refreshing" || refreshInFlightRef.current) return;
    refreshInFlightRef.current = true;

    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      refreshInFlightRef.current = false;
      dispatch({ type: "settle" });
    };
    const timer = setTimeout(settle, PULL_SETTLE_TIMEOUT_MS);
    Promise.resolve()
      .then(() => onRefreshRef.current())
      .catch(() => {})
      .finally(() => {
        clearTimeout(timer);
        settle();
      });
  }, [state.phase, dispatch]);

  const onTouchStart = useCallback(
    (e: React.TouchEvent) => {
      if (!enabled || e.touches.length === 0) return;
      // A caller that PASSES scrollRef reads scrollTop off it — and if it isn't
      // attached yet we must NOT fall back to e.currentTarget (the ScrollArea
      // Root never scrolls, so its scrollTop is always 0 and would falsely arm
      // every gesture). Only a caller that omits scrollRef entirely (handlers
      // directly on the scroller) uses e.currentTarget.
      const scrollEl = scrollRef
        ? scrollRef.current
        : (e.currentTarget as HTMLElement);
      const atTop = scrollEl ? scrollEl.scrollTop <= 0 : false;
      startYRef.current = e.touches[0].clientY;
      activeRef.current = atTop;
      dispatch({ type: "start", atTop });
    },
    [enabled, dispatch, scrollRef]
  );

  const onTouchMove = useCallback(
    (e: React.TouchEvent) => {
      if (!enabled || !activeRef.current || e.touches.length === 0) return;
      const rawDelta = e.touches[0].clientY - startYRef.current;
      dispatch({ type: "move", rawDelta });
    },
    [enabled, dispatch]
  );

  const onTouchEnd = useCallback(() => {
    if (!enabled) return;
    activeRef.current = false;
    dispatch({ type: "end" });
  }, [enabled, dispatch]);

  // If the hook is disabled mid-gesture (e.g. rotate to desktop width), reset so a
  // stale indicator can't stick around.
  useEffect(() => {
    if (!enabled && state.phase !== "idle") {
      setState(INITIAL_PULL_STATE);
      activeRef.current = false;
    }
  }, [enabled, state.phase]);

  return {
    bind: { onTouchStart, onTouchMove, onTouchEnd },
    distance: state.distance,
    phase: state.phase,
    isArmed: state.phase === "armed" || state.phase === "refreshing",
    isRefreshing: state.phase === "refreshing",
    threshold: PULL_THRESHOLD_PX,
  };
}
