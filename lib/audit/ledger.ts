/**
 * Audit / event ledger — the append-only record of what each session did.
 *
 * This is ROADMAP active-plan item 3: the Windows-safety moat ("what did the
 * agent run") AND the raw substrate for the analytics layer (item 4). One
 * ledger, viewed twice.
 *
 * Design:
 *  - Events are written at the `SessionBackend` seam via `RecordingBackend`, a
 *    decorator that wraps any backend (tmux or either pty tier) and records the
 *    lifecycle + input/control calls that flow through it. The seam is in the
 *    WEB-SERVER process, where better-sqlite3 lives — the Tier-2 pty daemon has
 *    no DB handle, so recording here (not inside PtySession) is what keeps the
 *    ledger consistent across all backends and tiers.
 *  - `recordEvent` is BEST-EFFORT and NON-THROWING: a failed audit write must
 *    not break the session operation it describes — the session is the product;
 *    the ledger is observability on top of it. (better-sqlite3 is synchronous,
 *    so the write runs inline and fast under WAL — this is non-throwing, not
 *    non-blocking; callers don't await it because there's nothing to await.)
 *  - Raw pty OUTPUT is intentionally NOT recorded here: it's daemon-side and
 *    high-volume, and the rendered-screen capture already serves that need.
 *  - Input payloads store METADATA (length), not the verbatim text, by default —
 *    so secrets typed into a prompt aren't copied into the ledger. Opt into full
 *    text with STOA_AUDIT_INPUT_TEXT=1 (off by default), capped at MAX_TEXT_BYTES.
 *
 * Known limitations (acceptable for v1; revisit with the analytics layer):
 *  - Events key on the MUTABLE backend key, so a rename splits a session's
 *    trail across the old/new key (the rename event carries a `{from}`
 *    breadcrumb under the new key). A stable correlation id is an item-4
 *    decision once the analytics correlation model is designed.
 *  - The spawn `command` string (shell/fallback path) is recorded verbatim
 *    regardless of STOA_AUDIT_INPUT_TEXT — it IS the "what ran" the moat exists
 *    to capture — so a command carrying an inline secret is recorded as-is.
 */

import { getDb, queries } from "../db";
import type { SessionEventType } from "../db/types";
import type {
  SessionBackend,
  CaptureOptions,
  CreateOptions,
  SendOptions,
  SessionActivity,
} from "../session-backend/types";

/** Cap on verbatim input text stored when STOA_AUDIT_INPUT_TEXT is on. */
const MAX_TEXT_BYTES = 64 * 1024;

/** Parse a boolean-ish env flag with an explicit default. */
function envFlag(name: string, defaultOn: boolean): boolean {
  const v = process.env[name]?.toLowerCase();
  if (v === undefined) return defaultOn;
  if (v === "0" || v === "false" || v === "off") return false;
  if (v === "1" || v === "true" || v === "on") return true;
  return defaultOn;
}

/** Whether the ledger is active. Default ON; opt out with STOA_AUDIT=0|false|off. */
export function auditEnabled(): boolean {
  return envFlag("STOA_AUDIT", true);
}

/** Whether to store verbatim input text (off by default — avoids logging secrets). */
function captureInputText(): boolean {
  return envFlag("STOA_AUDIT_INPUT_TEXT", false);
}

// Throttle audit-failure logging: a persistent fault (disk full, locked DB) on a
// high-frequency input path must not flood stderr. Log the first failure, then at
// most once per interval — so systemic loss stays visible without spamming.
let lastFailureLogAt = 0;
const FAILURE_LOG_INTERVAL_MS = 60_000;

/**
 * Append one event to the ledger. Best-effort: swallows every error (a failed
 * audit write must never break the session operation it describes). Synchronous
 * (better-sqlite3) and fast under WAL; callers don't await it.
 */
export function recordEvent(
  sessionKey: string,
  eventType: SessionEventType,
  payload?: Record<string, unknown>
): void {
  try {
    queries
      .appendSessionEvent(getDb())
      .run(
        sessionKey,
        eventType,
        payload ? JSON.stringify(payload) : null,
        Date.now()
      );
  } catch (err) {
    const now = Date.now();
    if (now - lastFailureLogAt > FAILURE_LOG_INTERVAL_MS) {
      lastFailureLogAt = now;
      console.error(
        "[audit] failed to record event (throttled, ignored):",
        err
      );
    }
  }
}

/**
 * A SessionBackend decorator that records lifecycle + input events to the
 * ledger as they pass through, then delegates to the wrapped backend. Read-only
 * operations (capture/list/listWithActivity/exists/getEnv/getPanePath) are NOT
 * recorded — they don't change session state and would only add noise.
 */
export class RecordingBackend implements SessionBackend {
  constructor(private readonly inner: SessionBackend) {}

  async create(opts: CreateOptions): Promise<void> {
    // Record AFTER the spawn succeeds — the ledger reflects what ACTUALLY ran,
    // not a spawn that threw. If inner.create rejects, no event is recorded.
    await this.inner.create(opts);
    recordEvent(opts.name, "session_create", {
      cwd: opts.cwd,
      binary: opts.binary,
      argCount: opts.args?.length ?? 0,
      // The banner-wrapped shell command (tmux / fallback path) is recorded
      // verbatim when present — it's the literal "what did the agent run" the
      // moat is about. When a binary argv path is used, the command string still
      // captures the joined invocation for audit readability.
      command: opts.command ?? undefined,
    });
  }

  async kill(name: string): Promise<void> {
    // Record BEFORE the kill so the event lands even if the kill races a
    // teardown that tears down the recording path too.
    recordEvent(name, "session_kill");
    await this.inner.kill(name);
  }

  async rename(oldName: string, newName: string): Promise<void> {
    await this.inner.rename(oldName, newName);
    // Key the event under the NEW name so it groups with the renamed session's
    // subsequent events; the payload preserves the prior name for traceability.
    recordEvent(newName, "session_rename", { from: oldName });
  }

  async sendEnter(name: string): Promise<void> {
    recordEvent(name, "input_enter");
    await this.inner.sendEnter(name);
  }

  async sendEscape(name: string): Promise<void> {
    recordEvent(name, "input_escape");
    await this.inner.sendEscape(name);
  }

  async sendKeysLiteral(name: string, text: string): Promise<void> {
    recordEvent(name, "input_text", inputPayload(text));
    await this.inner.sendKeysLiteral(name, text);
  }

  async sendKeysInterpreted(
    name: string,
    text: string,
    opts?: SendOptions
  ): Promise<void> {
    recordEvent(name, "input_text", {
      ...inputPayload(text),
      enter: !!opts?.enter,
    });
    await this.inner.sendKeysInterpreted(name, text, opts);
  }

  async pasteText(
    name: string,
    text: string,
    opts?: SendOptions
  ): Promise<void> {
    recordEvent(name, "input_paste", {
      ...inputPayload(text),
      enter: !!opts?.enter,
    });
    await this.inner.pasteText(name, text, opts);
  }

  // ── Read-only passthroughs (not recorded) ──────────────────────────────
  exists(name: string): Promise<boolean> {
    return this.inner.exists(name);
  }
  list(): Promise<string[]> {
    return this.inner.list();
  }
  listWithActivity(): Promise<SessionActivity[]> {
    return this.inner.listWithActivity();
  }
  getPanePath(name: string): Promise<string | null> {
    return this.inner.getPanePath(name);
  }
  getEnv(name: string, varName: string): Promise<string | null> {
    return this.inner.getEnv(name, varName);
  }
  getPid(name: string): Promise<number | null> {
    return this.inner.getPid(name);
  }
  capture(name: string, opts?: CaptureOptions): Promise<string> {
    return this.inner.capture(name, opts);
  }
}

/**
 * Build the input payload: always the length; the verbatim text only if opted
 * in, truncated to MAX_TEXT_BYTES so a whole-file paste can't bloat one row.
 */
function inputPayload(text: string): Record<string, unknown> {
  if (!captureInputText()) return { length: text.length };
  if (text.length <= MAX_TEXT_BYTES) return { length: text.length, text };
  return {
    length: text.length,
    text: text.slice(0, MAX_TEXT_BYTES),
    truncated: true,
  };
}

/** Wrap a backend with audit recording when the ledger is enabled; else passthrough. */
export function withAudit(backend: SessionBackend): SessionBackend {
  return auditEnabled() ? new RecordingBackend(backend) : backend;
}
