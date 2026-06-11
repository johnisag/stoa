"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { toast } from "sonner";
import {
  NotificationSettings,
  NotificationEvent,
  defaultSettings,
  loadSettings,
  saveSettings,
  requestNotificationPermission,
  canSendBrowserNotification,
  sendBrowserNotification,
  playNotificationSound,
  setTabNotificationCount,
  flashTabTitle,
  clearTabNotifications,
} from "@/lib/notifications";
import { sanitizeNotificationText } from "@/lib/notification-text";
import { shouldBeep } from "@/lib/notification-sound";
import { shouldOfferSeeChanges } from "@/lib/see-changes";

type SessionStatus = "idle" | "running" | "waiting" | "error" | "dead";

interface SessionState {
  id: string;
  name: string;
  status: SessionStatus;
  /** True when an ACTUAL prompt is on screen — so "waiting" because the agent
   * finished its turn doesn't fire a false "needs your input" alert. */
  hasPrompt?: boolean;
}

interface UseNotificationsOptions {
  onSessionClick?: (sessionId: string) => void;
  /** Open the diff of what a session just changed (the "See changes" jump). */
  onSeeChanges?: (sessionId: string) => void;
}

// Don't re-notify the same session+event within this window. Dedups flaps
// (waiting->idle->waiting) AND rapid same-state re-entry (e.g. a flickering
// error). A genuine repeat after the window still notifies, and the
// SessionCard highlight persists in the meantime, so nothing is lost visually.
const NOTIFY_COOLDOWN_MS = 8000;

export function useNotifications(options: UseNotificationsOptions = {}) {
  const { onSessionClick, onSeeChanges } = options;
  const [settings, setSettings] =
    useState<NotificationSettings>(defaultSettings);
  const [permissionGranted, setPermissionGranted] = useState(false);
  const previousStates = useRef<Map<string, SessionStatus>>(new Map());
  const waitingCount = useRef(0);
  // Last time we notified each `${sessionId}-${event}`, for cooldown-based
  // dedup: suppresses flap (waiting->idle->waiting) and repeat alerts while
  // still allowing a genuine re-notification once the cooldown passes.
  const lastNotified = useRef<Map<string, number>>(new Map());

  // Load settings on mount
  useEffect(() => {
    setSettings(loadSettings());
    setPermissionGranted(canSendBrowserNotification());
  }, []);

  // Request permission
  const requestPermission = useCallback(async () => {
    const granted = await requestNotificationPermission();
    setPermissionGranted(granted);
    return granted;
  }, []);

  // Update settings
  const updateSettings = useCallback(
    (newSettings: Partial<NotificationSettings>) => {
      setSettings((prev) => {
        const updated = { ...prev, ...newSettings };
        saveSettings(updated);
        return updated;
      });
    },
    []
  );

  // Toggle a specific event
  const toggleEvent = useCallback(
    (event: NotificationEvent, enabled: boolean) => {
      setSettings((prev) => {
        const updated = {
          ...prev,
          events: { ...prev.events, [event]: enabled },
        };
        saveSettings(updated);
        return updated;
      });
    },
    []
  );

  // Send notification for an event
  const notify = useCallback(
    (
      event: NotificationEvent,
      sessionId: string,
      sessionName: string,
      message?: string
    ) => {
      if (!settings.enabled || !settings.events[event]) return;

      // Names are untrusted — strip terminal artifacts (ANSI/box-drawing/control
      // chars) so a toast never renders as "strange vertical lines" / tofu.
      const safeName = sanitizeNotificationText(sessionName, {
        fallback: "Session",
      });

      const titles: Record<NotificationEvent, string> = {
        waiting: `${safeName} needs input`,
        error: `${safeName} encountered an error`,
        completed: `${safeName} completed`,
      };

      const title = titles[event];
      const body = message || getDefaultMessage(event);

      // In-app toast with click action
      const toastTypes: Record<
        NotificationEvent,
        "warning" | "error" | "success"
      > = {
        waiting: "warning",
        error: "error",
        completed: "success",
      };
      toast[toastTypes[event]](title, {
        description: body,
        action: {
          label: "Go to session",
          onClick: () => onSessionClick?.(sessionId),
        },
      });

      // Browser notification (only if page not focused)
      if (settings.browserNotifications && permissionGranted) {
        sendBrowserNotification(
          title,
          { body, tag: `stoa-${event}-${sessionName}` },
          () => onSessionClick?.(sessionId)
        );
      }

      // Audio cue — synthesized beep, gated by the master Sound toggle AND this
      // event's per-event toggle (the playback itself debounces rapid repeats).
      if (shouldBeep(settings, event)) {
        playNotificationSound(event);
      }

      // Flash tab title
      if (event === "waiting") {
        flashTabTitle(`Waiting: ${safeName}`);
      }
    },
    [settings, permissionGranted, onSessionClick]
  );

  // Transient "See changes" affordance: when the active session's turn settles
  // to idle, surface a dismissible toast whose action opens the diff of what it
  // just changed. It still respects the master `settings.enabled` kill switch
  // (checkStateChanges returns early when off), but not the per-EVENT toggles —
  // it's a navigation shortcut, not an alert. The caller gates it through the
  // same cooldown as `notify` (so status flaps don't stack toasts), and a stable
  // toast id makes sonner REPLACE rather than pile up repeats.
  const offerSeeChanges = useCallback(
    (sessionId: string, sessionName: string) => {
      const safeName = sanitizeNotificationText(sessionName, {
        fallback: "Session",
      });
      toast(`${safeName} finished`, {
        id: `seechanges-${sessionId}`,
        description: "Review what changed",
        action: {
          label: "See changes",
          onClick: () => onSeeChanges?.(sessionId),
        },
      });
    },
    [onSeeChanges]
  );

  // Check for state changes and notify
  const checkStateChanges = useCallback(
    (sessions: SessionState[], activeSessionId?: string | null) => {
      if (!settings.enabled) return;

      const now = Date.now();
      // Only suppress the focused session while the WINDOW itself is focused —
      // if you're in another app you can't see it, so it should still alert.
      const windowFocused =
        typeof document !== "undefined" && document.hasFocus();
      // Notify once per session+event, then hold off for the cooldown — this
      // dedups both repeats and flaps (e.g. waiting->idle->waiting) without
      // permanently muting a genuine later re-notification.
      const shouldNotify = (key: string): boolean => {
        const last = lastNotified.current.get(key) || 0;
        if (now - last < NOTIFY_COOLDOWN_MS) return false;
        lastNotified.current.set(key, now);
        return true;
      };

      let newWaitingCount = 0;

      sessions.forEach((session) => {
        const prevStatus = previousStates.current.get(session.id);
        const currentStatus = session.status;

        // Only a real prompt counts toward the "needs you" tab badge — a session
        // that merely finished its turn isn't waiting on YOU.
        if (currentStatus === "waiting" && session.hasPrompt) newWaitingCount++;

        // Skip on initial load (no previous state).
        if (prevStatus === undefined) {
          previousStates.current.set(session.id, currentStatus);
          return;
        }
        // Skip if unchanged, or if it's the session you're already looking at.
        if (prevStatus === currentStatus) return;
        if (session.id === activeSessionId && windowFocused) {
          // The session you're watching gets no "completed" ping (you can see
          // it). But when its turn just settled to idle, offer a one-tap jump to
          // the diff of what it changed — review is then one tap, not a hunt.
          // The previousStates update below is the once-per-transition gate.
          if (
            onSeeChanges &&
            shouldOfferSeeChanges(prevStatus, currentStatus) &&
            shouldNotify(`${session.id}-seechanges`)
          ) {
            offerSeeChanges(session.id, session.name);
          }
          previousStates.current.set(session.id, currentStatus);
          return;
        }

        // Notify on the meaningful transitions. A "waiting" session only "needs
        // your input" if there's an ACTUAL prompt; otherwise it just finished its
        // turn → "completed" (mirrors detectPushEvents, so in-app and lock-screen
        // agree). This is the fix for the false "needs input" alarm at every turn end.
        if (currentStatus === "waiting") {
          if (session.hasPrompt) {
            if (shouldNotify(`${session.id}-waiting`)) {
              notify("waiting", session.id, session.name);
            }
          } else if (prevStatus === "running" || prevStatus === "waiting") {
            if (shouldNotify(`${session.id}-completed`)) {
              notify("completed", session.id, session.name);
            }
          }
        } else if (currentStatus === "error") {
          if (shouldNotify(`${session.id}-error`)) {
            notify("error", session.id, session.name);
          }
        } else if (
          currentStatus === "idle" &&
          (prevStatus === "running" || prevStatus === "waiting")
        ) {
          // running/waiting -> idle = the agent finished a turn ("done").
          if (shouldNotify(`${session.id}-completed`)) {
            notify("completed", session.id, session.name);
          }
        }

        previousStates.current.set(session.id, currentStatus);
      });

      // Prune tracking for sessions that no longer exist so neither map grows
      // unbounded over a long-lived mount (also covers the previousStates map).
      const liveIds = new Set(sessions.map((s) => s.id));
      for (const id of previousStates.current.keys()) {
        if (!liveIds.has(id)) previousStates.current.delete(id);
      }
      // Build the set of valid `${id}-${event}` keys from live sessions rather
      // than parsing ids out of keys (robust if id/event names ever change).
      const validKeys = new Set<string>();
      for (const id of liveIds) {
        validKeys.add(`${id}-waiting`);
        validKeys.add(`${id}-error`);
        validKeys.add(`${id}-completed`);
        validKeys.add(`${id}-seechanges`);
      }
      for (const key of lastNotified.current.keys()) {
        if (!validKeys.has(key)) lastNotified.current.delete(key);
      }

      // Update tab badge (count of sessions awaiting input).
      if (newWaitingCount !== waitingCount.current) {
        waitingCount.current = newWaitingCount;
        setTabNotificationCount(newWaitingCount);
      }
    },
    [settings.enabled, notify, onSeeChanges, offerSeeChanges]
  );

  // Clear notifications when focused
  useEffect(() => {
    const handleFocus = () => {
      // Don't clear count, just stop flashing
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        // User returned to tab
      }
    };

    window.addEventListener("focus", handleFocus);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      window.removeEventListener("focus", handleFocus);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      clearTabNotifications();
    };
  }, []);

  return {
    settings,
    permissionGranted,
    requestPermission,
    updateSettings,
    toggleEvent,
    notify,
    checkStateChanges,
  };
}

function getDefaultMessage(event: NotificationEvent): string {
  switch (event) {
    case "waiting":
      return "Session is waiting for your input";
    case "error":
      return "Something went wrong";
    case "completed":
      return "Task has finished";
  }
}
