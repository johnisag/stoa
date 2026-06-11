// Audio-cue logic for notifications — kept pure (no AudioContext/DOM) so the
// "should I beep, and with what tone?" decision is unit-testable. The actual
// WebAudio playback lives in playNotificationSound (lib/notifications.ts);
// this module only decides WHETHER and computes the tone params.

import type { NotificationEvent, NotificationSettings } from "./notifications";

/**
 * A short synthesized cue — no external audio asset. `freqs` is the sequence of
 * oscillator frequencies (Hz) played back-to-back, each for `step` seconds, with
 * peak `gain`. Mirrors the visual/push event types so the ear matches the eye:
 * a descending two-tone for "needs you", a low pair for an error, an ascending
 * pair for a finish.
 */
export interface BeepTone {
  freqs: number[];
  /** Seconds each tone is held. */
  step: number;
  /** Peak gain (0–1) — kept low so the cue is a tap, not a blast. */
  gain: number;
}

const TONES: Record<NotificationEvent, BeepTone> = {
  waiting: { freqs: [800, 600], step: 0.1, gain: 0.1 }, // descending — needs attention
  error: { freqs: [300, 200], step: 0.12, gain: 0.1 }, // low pair — something broke
  completed: { freqs: [600, 800], step: 0.1, gain: 0.1 }, // ascending — done
};

/** The tone params for an event's audio cue. */
export function toneForEvent(event: NotificationEvent): BeepTone {
  return TONES[event];
}

/**
 * Whether a beep should sound for `event`, given the user's settings — the
 * master Sound toggle AND the per-event toggle must both be on (the same gate
 * the visual/push path uses, so sound never fires for a muted event). Pure, so
 * the gating is locked by a test independent of any AudioContext.
 */
export function shouldBeep(
  settings: NotificationSettings,
  event: NotificationEvent
): boolean {
  return settings.enabled && settings.sound && settings.events[event];
}
