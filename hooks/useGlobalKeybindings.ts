"use client";

import { useEffect, useRef } from "react";
import {
  resolveShortcut,
  isMacPlatform,
  type Keybinding,
} from "@/lib/keybindings";

/**
 * Wire a set of global keyboard shortcuts to a single window keydown listener.
 * The matched binding's action id is passed to `onAction`; matching honors the
 * text-field guard (see lib/keybindings) so we never hijack typing or the
 * terminal. `onAction` is held in a ref so the listener isn't re-bound on every
 * render (callers don't need to memoize it).
 */
export interface UseGlobalKeybindingsOptions {
  /** Use the capture phase so this listener runs before bubble-phase listeners. */
  capture?: boolean;
  /** Stop other listeners from seeing a matched shortcut (useful for scoped overlays). */
  stopPropagation?: boolean;
}

export function useGlobalKeybindings(
  bindings: Keybinding[],
  onAction: (action: string, e: KeyboardEvent) => void,
  options: UseGlobalKeybindingsOptions = {}
): void {
  const { capture = false, stopPropagation = false } = options;
  const onActionRef = useRef(onAction);
  // Hold `bindings` in a ref too, so a caller passing an inline array (the
  // docstring says they needn't memoize) doesn't re-bind the window listener on
  // every render — the effect below depends only on the stable options.
  const bindingsRef = useRef(bindings);
  useEffect(() => {
    onActionRef.current = onAction;
    bindingsRef.current = bindings;
  });

  useEffect(() => {
    const isMac = isMacPlatform();
    const handler = (e: KeyboardEvent) => {
      const hit = resolveShortcut(
        {
          key: e.key,
          metaKey: e.metaKey,
          ctrlKey: e.ctrlKey,
          shiftKey: e.shiftKey,
          altKey: e.altKey,
          repeat: e.repeat,
          target: e.target as unknown as {
            tagName?: string;
            isContentEditable?: boolean;
            closest?: (s: string) => unknown;
          } | null,
        },
        bindingsRef.current,
        isMac
      );
      if (!hit) return;
      e.preventDefault();
      if (stopPropagation) e.stopImmediatePropagation();
      onActionRef.current(hit.action, e);
    };
    window.addEventListener("keydown", handler, capture);
    return () => window.removeEventListener("keydown", handler, capture);
  }, [capture, stopPropagation]);
}
