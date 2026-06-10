import { getSessionBackend } from "./session-backend";
import { statusDetector, type SessionStatus } from "./status-detector";
import type { RateLimitState } from "./rate-limit";
import type { PromptState } from "./auto-steer";
import {
  getManagedSessionPattern,
  getSessionIdFromName,
} from "./providers/registry";

export interface ManagedStatus {
  /** Session id, parsed from the `{provider}-{id}` managed name. */
  id: string;
  /** The managed session name (backend key). */
  name: string;
  status: SessionStatus;
  lastLine: string;
  /** Rate-limit state read off the same capture, or null if not limited. */
  rateLimit: RateLimitState | null;
  /** Detected interactive prompt read off the same capture (auto-steer), or null. */
  prompt: PromptState | null;
}

const MANAGED = getManagedSessionPattern();

/**
 * {id, status, lastLine} for every Stoa-managed session, via the SAME backend +
 * status detector the /api/sessions/status poll uses. Drives the server-side
 * /ws/events broadcaster (pushes live transitions to clients). Best-effort — a
 * session that errors mid-capture is skipped, and getSessionBackend() is called
 * at run time (not module load) so it reflects the finalized Tier-1/2 decision.
 */
export async function computeManagedStatuses(): Promise<ManagedStatus[]> {
  const backend = getSessionBackend();
  let names: string[];
  try {
    names = (await backend.list()).filter((n) => MANAGED.test(n));
  } catch {
    return [];
  }
  const out: ManagedStatus[] = [];
  await Promise.all(
    names.map(async (name) => {
      try {
        const { status, lastLine, rateLimit, prompt } =
          await statusDetector.getStatusDetail(name);
        out.push({
          id: getSessionIdFromName(name),
          name,
          status,
          lastLine,
          rateLimit,
          prompt,
        });
      } catch {
        // Session vanished / capture failed — skip; the client poll backstops.
      }
    })
  );
  return out;
}

export interface StatusDelta {
  id: string;
  name: string;
  status: SessionStatus;
  lastLine: string;
  /** Rate-limit state, so the client can badge "limited / resets in N". */
  rateLimit: RateLimitState | null;
}

// One snapshot value per session, so a diff is a cheap string compare. NUL
// separates the fields (can't appear in a status, rendered line, or our marker) —
// rateLimit is included so a limit appearing/clearing broadcasts a delta.
const snapKey = (s: {
  status: SessionStatus;
  lastLine: string;
  rateLimit: RateLimitState | null;
}) =>
  `${s.status}\0${s.lastLine}\0${
    s.rateLimit ? `${s.rateLimit.reason}@${s.rateLimit.resetAt ?? ""}` : ""
  }`;

/**
 * Entries that CHANGED vs the previous snapshot (new id, different status, or
 * different last line) — exactly what the broadcaster pushes. Pure → unit-tested.
 * Disappeared sessions aren't emitted here; the client's status poll reconciles
 * removals (a session gone from the list reads as dead).
 */
export function diffStatuses(
  prev: Map<string, string>,
  curr: ManagedStatus[]
): StatusDelta[] {
  const deltas: StatusDelta[] = [];
  for (const s of curr) {
    if (prev.get(s.id) !== snapKey(s)) {
      deltas.push({
        id: s.id,
        name: s.name,
        status: s.status,
        lastLine: s.lastLine,
        rateLimit: s.rateLimit,
      });
    }
  }
  return deltas;
}

/** Snapshot the current statuses for the next diff. */
export function snapshotStatuses(curr: ManagedStatus[]): Map<string, string> {
  return new Map(curr.map((s) => [s.id, snapKey(s)]));
}

export type PushEventKind = "waiting" | "error" | "done";
export interface PushEvent {
  id: string;
  name: string;
  kind: PushEventKind;
}

/**
 * Meaningful status transitions worth a Web Push — mirrors the client's
 * checkStateChanges so closed-tab pushes match in-app alerts: → waiting (needs
 * input), → error, and running/waiting → idle (done). Skips the initial tick
 * (no prev) and unchanged statuses. Pure → unit-tested.
 */
export function detectPushEvents(
  prev: Map<string, SessionStatus>,
  curr: ManagedStatus[]
): PushEvent[] {
  const events: PushEvent[] = [];
  for (const s of curr) {
    const p = prev.get(s.id);
    if (p === undefined || p === s.status) continue;
    if (s.status === "waiting") {
      events.push({ id: s.id, name: s.name, kind: "waiting" });
    } else if (s.status === "error") {
      events.push({ id: s.id, name: s.name, kind: "error" });
    } else if (s.status === "idle" && (p === "running" || p === "waiting")) {
      events.push({ id: s.id, name: s.name, kind: "done" });
    }
  }
  return events;
}

/** Status-only snapshot (for push transition detection). */
export function statusById(curr: ManagedStatus[]): Map<string, SessionStatus> {
  return new Map(curr.map((s) => [s.id, s.status]));
}
