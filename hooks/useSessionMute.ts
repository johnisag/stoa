"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import {
  loadSettings,
  saveSettings,
  SETTINGS_CHANGED_EVENT,
} from "@/lib/notifications";
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
 * change surgical. Cards on the same page stay in sync via the shared
 * SETTINGS_CHANGED_EVENT (dispatched by saveSettings) that each mounted hook
 * listens for.
 */

function readMutes(): string[] {
  return loadSettings().mutedSessionIds;
}

export function useSessionMute(sessionId: string) {
  const [muted, setMutedState] = useState(false);

  useEffect(() => {
    const sync = () => setMutedState(readMutes().includes(sessionId));
    sync();
    // Same-tab: any saveSettings (this hook or the Bell menu) broadcasts this
    // event. Cross-tab: the storage event fires when another tab writes.
    window.addEventListener(SETTINGS_CHANGED_EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(SETTINGS_CHANGED_EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, [sessionId]);

  const toggle = useCallback(() => {
    // Read FRESH (never a stale React copy) so a mute set elsewhere is preserved.
    const current = loadSettings();
    const nextMutes = toggleMuted(current.mutedSessionIds, sessionId);
    const nowMuted = nextMutes.includes(sessionId);
    // saveSettings broadcasts SETTINGS_CHANGED_EVENT so sibling hooks re-read.
    void saveSettings({ ...current, mutedSessionIds: nextMutes }).then((ok) => {
      // A failed IndexedDB mirror write means the service worker keeps reading
      // the PREVIOUS policy — an un-mute that doesn't reach the SW would keep
      // suppressing this session's closed-tab pushes. Tell the user.
      if (!ok) {
        toast.error(
          `Couldn't sync ${nowMuted ? "mute" : "unmute"} to closed-tab alerts — it may not apply until you retry.`
        );
      }
    });
    setMutedState(nowMuted);
  }, [sessionId]);

  return { muted, toggle };
}
