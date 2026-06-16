"use client";

import { useEffect, useRef, useState } from "react";
import { isEditableTarget, type TargetLike } from "@/lib/keybindings";

/**
 * Tracks whether the spacebar is currently held, for "hold Space + drag to pan"
 * on the workflow canvas (the de-facto gesture in Figma/Miro/Excalidraw/tldraw).
 *
 * - Ignores Space pressed while typing in an input/textarea/contenteditable/xterm
 *   (via the shared isEditableTarget guard) so it never hijacks the task field.
 * - Calls preventDefault on the held Space keydown so the page doesn't page-scroll
 *   while panning — but ONLY while `enabled` (the builder tab is visible) so we
 *   don't swallow Space globally.
 * - Clears the held flag on blur/visibilitychange so a Space-down that loses focus
 *   (e.g. alt-tab) can't leave the canvas stuck in pan mode.
 *
 * Returns the live held state; the canvas reads it to switch cursor + drag mode.
 */
export function useSpacePan(enabled: boolean): boolean {
  const [spaceHeld, setSpaceHeld] = useState(false);
  // Mirror into a ref so the keyup/blur handlers are stable yet see fresh state.
  const heldRef = useRef(false);
  heldRef.current = spaceHeld;

  useEffect(() => {
    if (!enabled) {
      // Leaving the tab: drop any stuck held state and bind nothing.
      if (heldRef.current) setSpaceHeld(false);
      return;
    }

    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== " " && e.code !== "Space") return;
      if (isEditableTarget(e.target as TargetLike | null)) {
        return;
      }
      // Hold-to-pan: suppress the browser's Space = page-down while held.
      e.preventDefault();
      if (!heldRef.current) setSpaceHeld(true);
    }

    function onKeyUp(e: KeyboardEvent) {
      if (e.key !== " " && e.code !== "Space") return;
      if (heldRef.current) setSpaceHeld(false);
    }

    function release() {
      if (heldRef.current) setSpaceHeld(false);
    }

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", release);
    document.addEventListener("visibilitychange", release);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", release);
      document.removeEventListener("visibilitychange", release);
    };
  }, [enabled]);

  return spaceHeld;
}
