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
export function useGlobalKeybindings(
  bindings: Keybinding[],
  onAction: (action: string, e: KeyboardEvent) => void
): void {
  const onActionRef = useRef(onAction);
  onActionRef.current = onAction;

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
        bindings,
        isMac
      );
      if (!hit) return;
      e.preventDefault();
      onActionRef.current(hit.action, e);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [bindings]);
}
