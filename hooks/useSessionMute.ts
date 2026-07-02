"use client";

import { useCallback, useEffect, useState } from "react";
import { loadSettings, saveSettings } from "@/lib/notifications";
import { toggleMuted } from "@/lib/notification-policy";

/**
 * Per-session notification mute (#52). A muted session sends no closed-tab (Web
 * Push) ping — the mute list lives in the same localStorage notification settings
 * and is mirrored into IndexedDB (via saveSettings) so the service worker can
 * apply it at push DISPLAY time.
 *
 * This reads/writes the shared settings DIRECTLY rather than threading a prop
 * through the whole session-list tree: the mute list is a per-device client
 * concern (the SW is the real consumer), so a self-contained hook keeps the
 * change surgical. Cards on the same page stay in sync via a custom
 * "stoa:mutes-changed" event that each mounted hook listens for.
 */

const MUTES_EVENT = "stoa:mutes-changed";

function readMutes(): string[] {
  return loadSettings().mutedSessionIds;
}

export function useSessionMute(sessionId: string) {
  const [muted, setMutedState] = useState(false);

  useEffect(() => {
    const sync = () => setMutedState(readMutes().includes(sessionId));
    sync();
    // Same-tab: our own toggle broadcasts this event. Cross-tab: the storage
    // event fires when another tab writes localStorage.
    window.addEventListener(MUTES_EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(MUTES_EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, [sessionId]);

  const toggle = useCallback(() => {
    const current = loadSettings();
    const nextMutes = toggleMuted(current.mutedSessionIds, sessionId);
    saveSettings({ ...current, mutedSessionIds: nextMutes });
    // Notify sibling hooks in THIS tab (storage events don't fire same-tab).
    window.dispatchEvent(new Event(MUTES_EVENT));
    setMutedState(nextMutes.includes(sessionId));
  }, [sessionId]);

  return { muted, toggle };
}
