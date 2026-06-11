/**
 * Pure-helper coverage for the audio cue. The decision logic — which transition
 * makes a sound, whether the user's settings allow it, and which tone plays —
 * is kept out of the WebAudio playback so it can be locked here without an
 * AudioContext. Mirrors checkStateChanges / detectPushEvents so the beep fires
 * on exactly the same transitions as the visual + push alerts.
 */
import { describe, it, expect } from "vitest";
import { shouldBeep, toneForEvent } from "@/lib/notification-sound";
import {
  defaultSettings,
  type NotificationEvent,
  type NotificationSettings,
} from "@/lib/notifications";

describe("shouldBeep", () => {
  const events: NotificationEvent[] = ["waiting", "error", "completed"];

  it("beeps only when enabled AND sound AND the per-event toggle are all on", () => {
    const on: NotificationSettings = {
      enabled: true,
      browserNotifications: true,
      sound: true,
      events: { waiting: true, error: true, completed: true },
    };
    for (const e of events) expect(shouldBeep(on, e)).toBe(true);
  });

  it("the master Sound toggle mutes every event", () => {
    const muted: NotificationSettings = {
      ...defaultSettings,
      sound: false,
      events: { waiting: true, error: true, completed: true },
    };
    for (const e of events) expect(shouldBeep(muted, e)).toBe(false);
  });

  it("a disabled per-event toggle mutes only that event", () => {
    const settings: NotificationSettings = {
      enabled: true,
      browserNotifications: true,
      sound: true,
      events: { waiting: true, error: false, completed: true },
    };
    expect(shouldBeep(settings, "waiting")).toBe(true);
    expect(shouldBeep(settings, "error")).toBe(false);
    expect(shouldBeep(settings, "completed")).toBe(true);
  });

  it("the global enabled flag mutes every event", () => {
    const off: NotificationSettings = { ...defaultSettings, enabled: false };
    for (const e of events) expect(shouldBeep(off, e)).toBe(false);
  });
});

describe("toneForEvent", () => {
  const events: NotificationEvent[] = ["waiting", "error", "completed"];

  it("gives every event a distinct, non-empty, audible tone", () => {
    const sigs = new Set<string>();
    for (const e of events) {
      const tone = toneForEvent(e);
      expect(tone.freqs.length).toBeGreaterThan(0);
      expect(tone.freqs.every((f) => f > 0)).toBe(true);
      expect(tone.step).toBeGreaterThan(0);
      expect(tone.gain).toBeGreaterThan(0);
      expect(tone.gain).toBeLessThanOrEqual(1);
      sigs.add(tone.freqs.join(","));
    }
    expect(sigs.size).toBe(events.length); // no two events share a tone
  });

  it("waiting descends (attention) and completed ascends (success)", () => {
    const waiting = toneForEvent("waiting").freqs;
    const completed = toneForEvent("completed").freqs;
    expect(waiting[0]).toBeGreaterThan(waiting[1]);
    expect(completed[0]).toBeLessThan(completed[1]);
  });
});
