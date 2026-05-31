/**
 * Session Status Detection System
 *
 * States:
 * - "running" (GREEN): Sustained activity within cooldown period
 * - "waiting" (YELLOW): Cooldown expired, NOT acknowledged (needs attention)
 * - "error" (RED): a structured error is on the rendered screen (needs attention)
 * - "idle" (GRAY): Cooldown expired, acknowledged (user saw it)
 * - "dead": Session doesn't exist
 *
 * Detection Strategy (in priority order):
 * 1. Busy indicators + recent activity (highest priority - actively working)
 * 2. Waiting patterns - user input needed
 * 3. Error markers - a failed turn surfaced on the current screen
 * 4. Spike detection - activity timestamp changes (2+ in 1s = sustained)
 * 5. Cooldown - 2s grace period after activity stops
 */

import { getSessionBackend } from "./session-backend";

// Resolve the backend lazily (per use). Capturing it at module load would lock
// in the wrong choice before server.ts finalizes the pty-host fallback decision.

// Configuration constants
const CONFIG = {
  ACTIVITY_COOLDOWN_MS: 2000, // Grace period after activity
  SPIKE_WINDOW_MS: 1000, // Window to detect sustained activity
  SUSTAINED_THRESHOLD: 2, // Changes needed to confirm activity
  CACHE_VALIDITY_MS: 2000, // How long tmux cache is valid
  RECENT_ACTIVITY_MS: 120000, // Window for "recent" activity (2 min, tmux updates slowly)
} as const;

// Detection patterns
const BUSY_INDICATORS = [
  "esc to interrupt",
  "(esc to interrupt)",
  "· esc to interrupt",
];

const SPINNER_CHARS = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const WHIMSICAL_WORDS = [
  "accomplishing",
  "actioning",
  "actualizing",
  "baking",
  "booping",
  "brewing",
  "calculating",
  "cerebrating",
  "channelling",
  "churning",
  "clauding",
  "coalescing",
  "cogitating",
  "combobulating",
  "computing",
  "concocting",
  "conjuring",
  "considering",
  "contemplating",
  "cooking",
  "crafting",
  "creating",
  "crunching",
  "deciphering",
  "deliberating",
  "determining",
  "discombobulating",
  "divining",
  "doing",
  "effecting",
  "elucidating",
  "enchanting",
  "envisioning",
  "finagling",
  "flibbertigibbeting",
  "forging",
  "forming",
  "frolicking",
  "generating",
  "germinating",
  "hatching",
  "herding",
  "honking",
  "hustling",
  "ideating",
  "imagining",
  "incubating",
  "inferring",
  "jiving",
  "manifesting",
  "marinating",
  "meandering",
  "moseying",
  "mulling",
  "mustering",
  "musing",
  "noodling",
  "percolating",
  "perusing",
  "philosophising",
  "pondering",
  "pontificating",
  "processing",
  "puttering",
  "puzzling",
  "reticulating",
  "ruminating",
  "scheming",
  "schlepping",
  "shimmying",
  "shucking",
  "simmering",
  "smooshing",
  "spelunking",
  "spinning",
  "stewing",
  "sussing",
  "synthesizing",
  "thinking",
  "tinkering",
  "transmuting",
  "unfurling",
  "unravelling",
  "vibing",
  "wandering",
  "whirring",
  "wibbling",
  "wizarding",
  "working",
  "wrangling",
];

const WAITING_PATTERNS = [
  /\[Y\/n\]/i,
  /\[y\/N\]/i,
  /Allow\?/i,
  /Approve\?/i,
  /Continue\?/i,
  /Press Enter to/i,
  /waiting for input/i,
  /\(yes\/no\)/i,
  /Do you want to/i,
  /Enter to confirm.*Esc to cancel/i,
  />\s*1\.\s*Yes/,
  /Yes, allow all/i,
  /allow all edits/i,
  /allow all commands/i,
];

// Hermes prints its session id in the startup banner, e.g.
// "Session: 20260531_133925_98d9fc". We capture it from the rendered screen so
// Stoa can later resume with `--resume <id>`. Hermes writes no session file
// until a clean exit, so the on-screen banner is the reliable capture source.
export const HERMES_SESSION_ID_RE = /Session:\s*(\d{8}_\d{6}_[0-9a-fA-F]+)/;

export type SessionStatus = "running" | "waiting" | "idle" | "error" | "dead";

// High-signal, STRUCTURED error markers — deliberately conservative so the
// word "error" in normal agent output doesn't trip a false alarm. Checked on
// only the last few rendered lines, so a stale error scrolled into history
// stops counting. Best-effort: tune against real transcripts (the detector is
// shared across agents, so prefer false-negatives over false-positives here).
export const ERROR_PATTERNS: RegExp[] = [
  /Traceback \(most recent call last\):/, // python crash
  /^\s*panic:/m, // go panic
  /\bError code: \d{3}\b/i, // API error envelope, e.g. "Error code: 400"
  /\binvalid_request_error\b/, // provider error type
  /You're out of (extra )?usage/i, // provider credit/usage exhaustion
  /\bquota (exceeded|exhausted)\b/i,
];

interface StateTracker {
  lastChangeTime: number;
  acknowledged: boolean;
  lastActivityTimestamp: number;
  spikeWindowStart: number | null;
  spikeChangeCount: number;
}

interface SessionCache {
  data: Map<string, number>;
  updatedAt: number;
}

// Content analysis helpers
function checkBusyIndicators(content: string): boolean {
  const lines = content.split("\n");
  // Focus on last 10 lines to avoid old scrollback false positives
  const recentContent = lines.slice(-10).join("\n").toLowerCase();

  // Check text indicators in recent lines
  if (BUSY_INDICATORS.some((ind) => recentContent.includes(ind))) return true;

  // Check whimsical words + "tokens" pattern in recent lines
  if (
    recentContent.includes("tokens") &&
    WHIMSICAL_WORDS.some((w) => recentContent.includes(w))
  )
    return true;

  // Check spinners in last 5 lines
  const last5 = lines.slice(-5).join("");
  if (SPINNER_CHARS.some((s) => last5.includes(s))) return true;

  return false;
}

function checkWaitingPatterns(content: string): boolean {
  const recentLines = content.split("\n").slice(-5).join("\n");
  return WAITING_PATTERNS.some((p) => p.test(recentLines));
}

function checkErrorPatterns(content: string): boolean {
  const recentLines = content.split("\n").slice(-8).join("\n");
  return ERROR_PATTERNS.some((p) => p.test(recentLines));
}

class SessionStatusDetector {
  private trackers = new Map<string, StateTracker>();
  private cache: SessionCache = { data: new Map(), updatedAt: 0 };
  // Hermes session ids captured from the rendered startup banner, memoized per
  // session (the banner prints once and may scroll off). Read by the status
  // route to persist for resume.
  private hermesSessionIds = new Map<string, string>();

  // Cache management
  async refreshCache(): Promise<void> {
    if (Date.now() - this.cache.updatedAt < CONFIG.CACHE_VALIDITY_MS) return;

    try {
      const sessions = await getSessionBackend().listWithActivity();

      const newData = new Map<string, number>();
      for (const { name, activity } of sessions) {
        if (name && activity) newData.set(name, activity || 0);
      }

      this.cache = { data: newData, updatedAt: Date.now() };
    } catch {
      // Keep existing cache on error
    }
  }

  sessionExists(name: string): boolean {
    return this.cache.data.has(name);
  }

  getTimestamp(name: string): number {
    return this.cache.data.get(name) || 0;
  }

  async capturePane(name: string): Promise<string> {
    const stdout = await getSessionBackend().capture(name);
    const trimmed = stdout.trim();
    // Capture the Hermes banner session id once (cheap; once set, has() short-
    // circuits the regex). Agent-agnostic here — only Hermes prints this line.
    if (!this.hermesSessionIds.has(name)) {
      const m = trimmed.match(HERMES_SESSION_ID_RE);
      if (m) this.hermesSessionIds.set(name, m[1]);
    }
    return trimmed;
  }

  /** Hermes session id captured from the startup banner, or null if not seen yet. */
  getHermesSessionId(name: string): string | null {
    return this.hermesSessionIds.get(name) ?? null;
  }

  private getTracker(name: string, timestamp: number): StateTracker {
    let tracker = this.trackers.get(name);
    if (!tracker) {
      tracker = {
        lastChangeTime: Date.now() - CONFIG.ACTIVITY_COOLDOWN_MS,
        acknowledged: true,
        lastActivityTimestamp: timestamp,
        spikeWindowStart: null,
        spikeChangeCount: 0,
      };
      this.trackers.set(name, tracker);
    }
    return tracker;
  }

  // Spike detection: filters single activity spikes from sustained activity
  private processSpikeDetection(
    tracker: StateTracker,
    currentTimestamp: number
  ): "running" | null {
    const now = Date.now();
    const timestampChanged = tracker.lastActivityTimestamp !== currentTimestamp;

    if (timestampChanged) {
      tracker.lastActivityTimestamp = currentTimestamp;

      const windowExpired =
        tracker.spikeWindowStart === null ||
        now - tracker.spikeWindowStart > CONFIG.SPIKE_WINDOW_MS;

      if (windowExpired) {
        // Start new detection window
        tracker.spikeWindowStart = now;
        tracker.spikeChangeCount = 1;
      } else {
        // Within window - count change
        tracker.spikeChangeCount++;
        if (tracker.spikeChangeCount >= CONFIG.SUSTAINED_THRESHOLD) {
          // Sustained activity confirmed
          tracker.lastChangeTime = now;
          tracker.acknowledged = false;
          tracker.spikeWindowStart = null;
          tracker.spikeChangeCount = 0;
          return "running";
        }
      }
    } else if (
      tracker.spikeChangeCount === 1 &&
      tracker.spikeWindowStart !== null
    ) {
      // Check if single spike should be filtered
      if (now - tracker.spikeWindowStart > CONFIG.SPIKE_WINDOW_MS) {
        tracker.spikeWindowStart = null;
        tracker.spikeChangeCount = 0;
      }
    }

    return null;
  }

  private isInSpikeWindow(tracker: StateTracker): boolean {
    return (
      tracker.spikeWindowStart !== null &&
      Date.now() - tracker.spikeWindowStart < CONFIG.SPIKE_WINDOW_MS
    );
  }

  private isInCooldown(tracker: StateTracker): boolean {
    return Date.now() - tracker.lastChangeTime < CONFIG.ACTIVITY_COOLDOWN_MS;
  }

  private getIdleOrWaiting(tracker: StateTracker): SessionStatus {
    return tracker.acknowledged ? "idle" : "waiting";
  }

  async getStatus(sessionName: string): Promise<SessionStatus> {
    await this.refreshCache();

    // Dead check
    if (!this.sessionExists(sessionName)) {
      this.trackers.delete(sessionName);
      return "dead";
    }

    const timestamp = this.getTimestamp(sessionName);
    const tracker = this.getTracker(sessionName, timestamp);
    const content = await this.capturePane(sessionName);

    // 1. Busy indicators in last 10 lines (highest priority - Claude is actively working)
    // No activity timestamp check needed since we only look at recent terminal lines
    if (checkBusyIndicators(content)) {
      tracker.lastChangeTime = Date.now();
      tracker.acknowledged = false;
      return "running";
    }

    // 2. Waiting patterns (only if not actively running)
    if (checkWaitingPatterns(content)) return "waiting";

    // 3. Error markers on the current screen (not working, not awaiting input).
    //    Checked after busy/waiting so an actively-retrying agent still reads
    //    as running; surfaces a turn that failed and needs attention.
    if (checkErrorPatterns(content)) return "error";

    // 4. Spike detection
    const spikeResult = this.processSpikeDetection(tracker, timestamp);
    if (spikeResult) return spikeResult;

    // 5. During spike window, maintain stable status
    if (this.isInSpikeWindow(tracker)) {
      return this.isInCooldown(tracker)
        ? "running"
        : this.getIdleOrWaiting(tracker);
    }

    // 6. Cooldown check
    if (this.isInCooldown(tracker)) return "running";

    // 7. Cooldown expired
    return this.getIdleOrWaiting(tracker);
  }

  acknowledge(sessionName: string): void {
    const tracker = this.trackers.get(sessionName);
    if (tracker) tracker.acknowledged = true;
  }

  async getAllStatuses(names: string[]): Promise<Map<string, SessionStatus>> {
    await this.refreshCache();
    const results = await Promise.all(
      names.map(async (name) => ({ name, status: await this.getStatus(name) }))
    );
    return new Map(results.map((r) => [r.name, r.status]));
  }

  cleanup(): void {
    for (const [name] of this.trackers) {
      if (!this.sessionExists(name)) this.trackers.delete(name);
    }
    for (const [name] of this.hermesSessionIds) {
      if (!this.sessionExists(name)) this.hermesSessionIds.delete(name);
    }
  }
}

export const statusDetector = new SessionStatusDetector();
