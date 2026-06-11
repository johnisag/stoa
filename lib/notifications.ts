// Notification utilities for Stoa

import { toneForEvent } from "./notification-sound";

export type NotificationEvent = "waiting" | "error" | "completed";

export interface NotificationSettings {
  enabled: boolean;
  browserNotifications: boolean;
  sound: boolean;
  events: {
    waiting: boolean;
    error: boolean;
    completed: boolean;
  };
}

export const defaultSettings: NotificationSettings = {
  enabled: true,
  browserNotifications: true,
  sound: true,
  events: {
    waiting: true,
    error: true,
    // Off by default: interactive agents do many running->idle cycles per task,
    // so "finished" pings get noisy. Toggle on per taste in the Bell menu.
    completed: false,
  },
};

const SETTINGS_KEY = "stoaNotificationSettings";

export function loadSettings(): NotificationSettings {
  if (typeof window === "undefined") return defaultSettings;
  try {
    const stored = localStorage.getItem(SETTINGS_KEY);
    if (stored) {
      return { ...defaultSettings, ...JSON.parse(stored) };
    }
  } catch {
    // Ignore parse errors
  }
  return defaultSettings;
}

export function saveSettings(settings: NotificationSettings): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

export async function requestNotificationPermission(): Promise<boolean> {
  if (typeof window === "undefined" || !("Notification" in window)) {
    return false;
  }

  if (Notification.permission === "granted") {
    return true;
  }

  if (Notification.permission === "denied") {
    return false;
  }

  const permission = await Notification.requestPermission();
  return permission === "granted";
}

export function canSendBrowserNotification(): boolean {
  if (typeof window === "undefined" || !("Notification" in window)) {
    return false;
  }
  return Notification.permission === "granted";
}

export function sendBrowserNotification(
  title: string,
  options?: NotificationOptions,
  onClick?: () => void
): Notification | null {
  if (!canSendBrowserNotification()) return null;

  // Only send if page is not focused
  if (document.hasFocus()) return null;

  const notification = new Notification(title, {
    icon: "/favicon.ico",
    badge: "/favicon.ico",
    ...options,
  });

  // Auto-close after 5 seconds
  setTimeout(() => notification.close(), 5000);

  // Focus window and trigger callback when clicked
  notification.onclick = () => {
    window.focus();
    notification.close();
    onClick?.();
  };

  return notification;
}

// Audio notification — a short WebAudio-synthesized beep (no external asset).
let audioContext: AudioContext | null = null;
// Debounce rapid beeps so a flurry of transitions can't stack overlapping
// oscillators into a buzz; one cue every BEEP_DEBOUNCE_MS is plenty.
let lastBeepAt = 0;
const BEEP_DEBOUNCE_MS = 400;

export function playNotificationSound(
  type: NotificationEvent = "waiting"
): void {
  if (typeof window === "undefined") return;

  const now = Date.now();
  if (now - lastBeepAt < BEEP_DEBOUNCE_MS) return;
  lastBeepAt = now;

  try {
    if (!audioContext) {
      audioContext = new AudioContext();
    }
    // Created `suspended` under the autoplay policy if the first beep fires
    // before any user gesture — resume it, else it's cached silent forever.
    if (audioContext.state === "suspended") {
      void audioContext.resume();
    }

    const oscillator = audioContext.createOscillator();
    const gainNode = audioContext.createGain();

    oscillator.connect(gainNode);
    gainNode.connect(audioContext.destination);

    // Tone params (frequency sequence + timing) are selected by event type in
    // the pure helper, so the "which beep?" mapping is unit-tested separately.
    const { freqs, step, gain } = toneForEvent(type);
    const start = audioContext.currentTime;

    // Schedule each frequency back-to-back on the single oscillator.
    freqs.forEach((freq, i) => {
      oscillator.frequency.setValueAtTime(freq, start + i * step);
    });

    const end = start + freqs.length * step;
    gainNode.gain.setValueAtTime(gain, start);
    gainNode.gain.exponentialRampToValueAtTime(0.01, end);

    oscillator.start(start);
    oscillator.stop(end);
  } catch {
    // Audio not available
  }
}

// Tab title/badge management
let originalTitle = "";
let notificationCount = 0;
let titleInterval: NodeJS.Timeout | null = null;

export function setTabNotificationCount(count: number): void {
  if (typeof window === "undefined") return;

  if (!originalTitle) {
    originalTitle = document.title.replace(/^\(\d+\)\s*/, "");
  }

  notificationCount = count;

  if (count > 0) {
    document.title = `(${count}) ${originalTitle}`;
  } else {
    document.title = originalTitle;
  }
}

export function flashTabTitle(message: string): void {
  if (typeof window === "undefined") return;

  if (!originalTitle) {
    originalTitle = document.title.replace(/^\(\d+\)\s*/, "");
  }

  // Clear existing flash
  if (titleInterval) {
    clearInterval(titleInterval);
  }

  let showMessage = true;
  titleInterval = setInterval(() => {
    if (document.hasFocus()) {
      // Stop flashing when focused
      if (titleInterval) clearInterval(titleInterval);
      document.title =
        notificationCount > 0
          ? `(${notificationCount}) ${originalTitle}`
          : originalTitle;
      return;
    }

    document.title = showMessage ? message : originalTitle;
    showMessage = !showMessage;
  }, 1000);

  // Stop after 30 seconds
  setTimeout(() => {
    if (titleInterval) {
      clearInterval(titleInterval);
      document.title =
        notificationCount > 0
          ? `(${notificationCount}) ${originalTitle}`
          : originalTitle;
    }
  }, 30000);
}

export function clearTabNotifications(): void {
  if (titleInterval) {
    clearInterval(titleInterval);
    titleInterval = null;
  }
  notificationCount = 0;
  if (originalTitle) {
    document.title = originalTitle;
  }
}
