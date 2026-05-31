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

type SessionStatus = "idle" | "running" | "waiting" | "error" | "dead";

interface SessionState {
  id: string;
  name: string;
  status: SessionStatus;
}

interface UseNotificationsOptions {
  onSessionClick?: (sessionId: string) => void;
}

// Don't re-notify the same session+event within this window (dedup flaps).
const NOTIFY_COOLDOWN_MS = 8000;

export function useNotifications(options: UseNotificationsOptions = {}) {
  const { onSessionClick } = options;
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

      const titles: Record<NotificationEvent, string> = {
        waiting: `${sessionName} needs input`,
        error: `${sessionName} encountered an error`,
        completed: `${sessionName} completed`,
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

      // Sound
      if (settings.sound) {
        playNotificationSound(event);
      }

      // Flash tab title
      if (event === "waiting") {
        flashTabTitle(`Waiting: ${sessionName}`);
      }
    },
    [settings, permissionGranted, onSessionClick]
  );

  // Check for state changes and notify
  const checkStateChanges = useCallback(
    (sessions: SessionState[], activeSessionId?: string | null) => {
      if (!settings.enabled) return;

      const now = Date.now();
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

        if (currentStatus === "waiting") newWaitingCount++;

        // Skip on initial load (no previous state).
        if (prevStatus === undefined) {
          previousStates.current.set(session.id, currentStatus);
          return;
        }
        // Skip if unchanged, or if it's the session you're already looking at.
        if (prevStatus === currentStatus) return;
        if (session.id === activeSessionId) {
          previousStates.current.set(session.id, currentStatus);
          return;
        }

        // Notify on the meaningful transitions.
        if (currentStatus === "waiting") {
          if (shouldNotify(`${session.id}-waiting`)) {
            notify("waiting", session.id, session.name);
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

      // Update tab badge (count of sessions awaiting input).
      if (newWaitingCount !== waitingCount.current) {
        waitingCount.current = newWaitingCount;
        setTabNotificationCount(newWaitingCount);
      }
    },
    [settings.enabled, notify]
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
