/**
 * Status-tick write actors + the per-tick write arbiter (#31).
 *
 * The server status tick used to be a ~460-line mega-loop where FOUR stages write
 * into a terminal — queue-dispatch, rate-limit resume, auto-answer, channel-
 * delivery — and "at most one write per session per tick" was enforced implicitly
 * by their fixed ORDER plus per-pair predicates (queueDispatchBlocked /
 * channelDeliveryBlocked) reading each earlier stage's per-tick Set. That coupling
 * was the module's top source of composition bugs.
 *
 * This module makes the invariant STRUCTURAL and testable without changing any
 * behavior:
 *  - Each write stage is a pure `WriteActor.decide(ctx, s) -> WriteIntent | null`
 *    that performs NO I/O. It reads the one snapshot + the persistent guard maps
 *    off `ctx`, sets its once-guard SYNCHRONOUSLY (exactly as the old `.add`
 *    before the fire-and-forget send, so a later actor in the SAME tick still sees
 *    it), and returns an intent describing WHAT to write + its commit/rollback.
 *  - `makeClaimWrite()` is a fresh-per-tick arbiter granting the first (highest-
 *    priority) actor a write per session; actors run queue > resume > answer >
 *    channel, so priority is the run order.
 *  - `runWriteActor` fires the granted intent fire-and-forget with the identical
 *    onCommit(.then) / onFail(.catch) / onSettled(.finally) the inline code used.
 *
 * What claimWrite does NOT subsume (kept as explicit gates, per the design): a
 * rate-limited session is OWNED by resume and must block queue/answer/channel even
 * on a tick it doesn't itself write (claimWrite never fires for it); the cross-tick
 * once-guards (once-per-idle queueDispatched, once-per-episode rateLimitResumed,
 * once-per-prompt autoAnswered, in-flight channelDelivering, per-day budget) live
 * on `ctx.maps` and persist across ticks; and budget-park stays a per-actor gate.
 * The escalate-only stages (error-loop, watchdog) and the observe-only stages
 * (WS/push/verify/snapshot/prune/idle-clear) never claim a write and stay in
 * server.ts.
 */

import type { ManagedStatus } from "./session-status";
import type { SessionBackend } from "./session-backend";
// Type-only (erased at runtime → no better-sqlite3 pulled in): the channel row the
// delivery actor threads opaquely from nextUnreadMessage → buildChannelDeliveryText.
import type { ChannelMessageRow } from "./db";
import { nextRateLimitAction } from "./rate-limit";
import {
  nextAutoAnswerAction,
  promptSignature,
  shouldRearmAutoAnswer,
  shouldAcknowledgeQueued,
} from "./auto-steer";
import { isChannelDeliveryTurn } from "./channel-delivery";
import { queueDispatchBlocked, channelDeliveryBlocked } from "./tick-guards";

/** A day's resume budget, mutated by reference (`count++`) from an onCommit. */
export interface ResumeBudget {
  day: string;
  count: number;
}

/** The persistent, CROSS-TICK guard maps. Owned by server.ts (module scope) and
 * aliased onto the context so a decide() reads them and an async intent callback
 * mutates the SAME objects — preserving the "budget object mutated by reference"
 * and "guard set before the send" semantics of the inline code. */
export interface TickMaps {
  /** once-per-idle: a queued prompt was sent this idle period. */
  queueDispatched: Set<string>;
  /** once-per-episode: this rate-limit episode was already nudged. */
  rateLimitResumed: Set<string>;
  /** when the limit was first seen (anchors the no-reset fallback). */
  rateLimitParkedAt: Map<string, number>;
  /** per-(session,day) resume budget; `count` mutated by reference. */
  rateLimitResumeDay: Map<string, ResumeBudget>;
  /** once-per-(session,day) "budget spent" log guard. */
  rateLimitBudgetLogged: Set<string>;
  /** once-per-distinct-prompt (keyed by promptSignature) auto-answer guard. */
  autoAnswered: Map<string, string>;
  /** one channel delivery in flight per session. */
  channelDelivering: Set<string>;
}

/** The I/O boundaries an actor needs, injected so status-tick.ts stays pure +
 * unit-testable (the tick's real deps are wired in server.ts). */
export interface TickDeps {
  backend: () => SessionBackend;
  isBudgetParked: (id: string) => boolean;
  peekPrompt: (id: string) => string | null;
  dequeuePrompt: (id: string) => void;
  /** Promote a settled (prompt-less) waiting turn to idle so its queue dispatches
   * next tick. NOT a terminal write. */
  acknowledge: (name: string) => void;
  /** Oldest unread channel message for a recipient, or null. */
  nextUnreadMessage: (id: string) => ChannelMessage | null;
  /** Atomically claim a pending message (true = this caller won and must paste). */
  claimDelivery: (messageId: string) => boolean;
  /** Un-claim a message whose paste failed, so a later tick re-delivers it. */
  resetDelivery: (messageId: string) => void;
  /** Render the "from another agent" wrapper for a claimed message. Injected (not
   * imported) so the full message type stays in server.ts and this module opaque. */
  buildChannelDeliveryText: (msg: ChannelMessage) => string;
  /** console.log seam (so tests can assert the once-per-day budget log etc.). */
  log: (message: string) => void;
}

/** The channel-message handle the actor threads from nextUnreadMessage → claim →
 * buildChannelDeliveryText → resetDelivery. The actor only reads `id`; the full
 * row shape is preserved so buildChannelDeliveryText gets its fields. */
export type ChannelMessage = ChannelMessageRow;

/** Knobs read once at startup and threaded through (no re-read from env). */
export interface TickKnobs {
  resumeFallbackMs: number;
  resumeMaxPerDay: number;
}

/** The unattended-write feature flags (the startup STOA_AUTO_* snapshot). queue is
 * always on and has no flag. `autoResume` gates only the resume ACTION — the resume
 * actor's pre-state management (guard-clears, park-anchor) is unconditional, so the
 * resume actor always runs and reads this flag internally. */
export interface TickFlags {
  autoResume: boolean;
  autoAnswer: boolean;
  channelDeliver: boolean;
}

/** Built ONCE per tick and passed to every actor. */
export interface TickContext {
  curr: ManagedStatus[];
  /** curr indexed by id (channel delivery resolves recipients through it). */
  byId: Map<string, ManagedStatus>;
  nowMs: number;
  resumeDay: string;
  knobs: TickKnobs;
  flags: TickFlags;
  maps: TickMaps;
  deps: TickDeps;
  /** The fresh-per-tick arbiter (the only per-tick state). */
  claimWrite: (id: string) => boolean;
}

/** A decision to write (or a no-op that still runs synchronous side effects). */
export type WriteIntent =
  | {
      kind: "pasteText";
      sessionName: string;
      text: string;
      onCommit?: () => void;
      onFail?: () => void;
      onSettled?: () => void;
    }
  | {
      kind: "sendEnter";
      sessionName: string;
      onCommit?: () => void;
      onFail?: () => void;
      onSettled?: () => void;
    }
  /** The resume<-queue coupling: the queue already sent this tick, so resume marks
   * itself satisfied + charges budget with NO backend call. onCommit runs
   * SYNCHRONOUSLY (matching the old unconditional inline charge). */
  | { kind: "noWrite"; onCommit: () => void };

export interface WriteActor {
  name: "queue" | "resume" | "answer" | "channel";
  /** Feature gate (queue is always on). */
  enabled: (ctx: TickContext) => boolean;
  /** Pure except it MAY set its once-guard synchronously + run the inline
   * pre-side-effects (park-anchor, budget rollover, guard-clears, acknowledge)
   * exactly as today. Returns the intent to fire, or null to skip. */
  decide: (ctx: TickContext, s: ManagedStatus) => WriteIntent | null;
}

/** Fresh-per-tick write arbiter: grants at most one write per session per tick;
 * first caller (highest-priority actor, by run order) wins. */
export function makeClaimWrite(): (id: string) => boolean {
  const claimed = new Set<string>();
  return (id: string): boolean => {
    if (claimed.has(id)) return false;
    claimed.add(id);
    return true;
  };
}

/** Fire a decided intent fire-and-forget with the same commit/rollback the inline
 * code used. decide() already ran synchronously (setting its guard); only the
 * backend I/O is deferred. Never awaits, so one slow pane can't stall the tick. */
export function runWriteActor(
  actor: WriteActor,
  ctx: TickContext,
  s: ManagedStatus
): void {
  const intent = actor.decide(ctx, s);
  if (!intent) return;
  if (intent.kind === "noWrite") {
    intent.onCommit();
    return;
  }
  const backend = ctx.deps.backend();
  const p =
    intent.kind === "pasteText"
      ? backend.pasteText(intent.sessionName, intent.text, { enter: true })
      : backend.sendEnter(intent.sessionName);
  void p
    .then(() => intent.onCommit?.())
    .catch((err) => {
      intent.onFail?.();
      console.error(`${actor.name} write failed:`, err);
    })
    .finally(() => intent.onSettled?.());
}

// ── WRITE ACTOR 1: queue-dispatch (always on) ──────────────────────────────
// Drain the next queued prompt when a session is genuinely idle-ready. A settled
// waiting turn (no prompt) is ACKNOWLEDGED here (a state mutation, not a write) so
// it flips to idle and dispatches next tick — but a real prompt is left for the
// human. Mirrors server.ts's old 671-724 loop verbatim.
export const queueActor: WriteActor = {
  name: "queue",
  enabled: () => true,
  decide(ctx, s) {
    const { maps, deps } = ctx;
    if (deps.isBudgetParked(s.id)) return null;
    if (
      queueDispatchBlocked({
        rateLimited: !!s.rateLimit,
        channelInFlight: maps.channelDelivering.has(s.id),
      })
    ) {
      // Reset the once-guard for a rate-limited session so it dispatches fresh
      // once the limit clears (a transient channel-in-flight just skips a tick).
      if (s.rateLimit) maps.queueDispatched.delete(s.id);
      return null;
    }
    const next = deps.peekPrompt(s.id);
    if (
      next == null ||
      s.status === "running" ||
      s.status === "error" ||
      s.status === "dead"
    ) {
      maps.queueDispatched.delete(s.id);
      return null;
    }
    if (s.status === "waiting") {
      // Promote a SETTLED turn to idle next tick — but NOT a real prompt (that
      // would paste the queued task into an open permission dialog).
      if (shouldAcknowledgeQueued(s.status, !!s.prompt)) {
        deps.acknowledge(s.name);
      }
      return null;
    }
    // idle → ready. Once per idle period.
    if (maps.queueDispatched.has(s.id)) return null;
    if (!ctx.claimWrite(s.id)) return null;
    maps.queueDispatched.add(s.id);
    return {
      kind: "pasteText",
      sessionName: s.name,
      text: next,
      onCommit: () => deps.dequeuePrompt(s.id),
      onFail: () => maps.queueDispatched.delete(s.id),
    };
  },
};

// ── WRITE ACTOR 2: rate-limit auto-resume ──────────────────────────────────
// Owns the rate-limited session. Runs pre-state management for EVERY session
// (clear guards when not limited / errored, anchor parkedAt) before the resume
// decision. Mirrors server.ts's old 736-827 loop verbatim.
export const resumeActor: WriteActor = {
  name: "resume",
  // ALWAYS runs: the pre-state management (guard-clears + park-anchor) is
  // unconditional. `flags.autoResume` gates only the resume action, inside decide.
  enabled: () => true,
  decide(ctx, s) {
    const { maps, deps, knobs } = ctx;
    if (!s.rateLimit) {
      maps.rateLimitResumed.delete(s.id);
      maps.rateLimitParkedAt.delete(s.id);
      maps.rateLimitBudgetLogged.delete(s.id);
      return null;
    }
    if (s.status === "error" || s.status === "dead") {
      maps.rateLimitResumed.delete(s.id);
      maps.rateLimitParkedAt.delete(s.id);
      maps.rateLimitBudgetLogged.delete(s.id);
      return null;
    }
    // Anchor the no-reset fallback at first sight of the limit (before the
    // enabled/once-guard short-circuit, exactly as today).
    if (!maps.rateLimitParkedAt.has(s.id))
      maps.rateLimitParkedAt.set(s.id, ctx.nowMs);
    if (!ctx.flags.autoResume || maps.rateLimitResumed.has(s.id)) return null;
    if (deps.isBudgetParked(s.id)) return null;
    // Per-day budget: roll over on a UTC-day change.
    let budget = maps.rateLimitResumeDay.get(s.id);
    if (!budget || budget.day !== ctx.resumeDay) {
      budget = { day: ctx.resumeDay, count: 0 };
      maps.rateLimitResumeDay.set(s.id, budget);
      maps.rateLimitBudgetLogged.delete(s.id);
    }
    const action = nextRateLimitAction({
      detected: true,
      resetAtMs: s.rateLimit.resetAt,
      nowMs: ctx.nowMs,
      hasPrompt: !!s.prompt,
      busy: s.status === "running",
      parkedAtMs: maps.rateLimitParkedAt.get(s.id) ?? null,
      fallbackMs: knobs.resumeFallbackMs,
      resumesUsedToday: budget.count,
      maxPerDay: knobs.resumeMaxPerDay,
    });
    if (action !== "resume") {
      if (
        knobs.resumeMaxPerDay > 0 &&
        budget.count >= knobs.resumeMaxPerDay &&
        s.status !== "running" &&
        !s.prompt &&
        !maps.rateLimitBudgetLogged.has(s.id)
      ) {
        maps.rateLimitBudgetLogged.add(s.id);
        deps.log(
          `rate-limit auto-resume: daily budget (${knobs.resumeMaxPerDay}) spent for ${s.name} — holding until tomorrow.`
        );
      }
      return null;
    }
    // The queue loop already sent this session's prompt this idle period → THAT is
    // the resume. Mark resumed + charge budget, send NOTHING (avoid double-send).
    if (maps.queueDispatched.has(s.id)) {
      const b = budget;
      return {
        kind: "noWrite",
        onCommit: () => {
          maps.rateLimitResumed.add(s.id);
          b.count++;
        },
      };
    }
    // Guard once-per-episode BEFORE the async send. Charge the budget only on a
    // DELIVERED nudge (onCommit), so a failed send that retries doesn't burn one.
    maps.rateLimitResumed.add(s.id);
    const queued = deps.peekPrompt(s.id);
    const b = budget;
    if (queued) {
      return {
        kind: "pasteText",
        sessionName: s.name,
        text: queued,
        onCommit: () => {
          b.count++;
          deps.dequeuePrompt(s.id);
        },
        onFail: () => maps.rateLimitResumed.delete(s.id),
      };
    }
    return {
      kind: "sendEnter",
      sessionName: s.name,
      onCommit: () => {
        b.count++;
      },
      onFail: () => maps.rateLimitResumed.delete(s.id),
    };
  },
};

// ── WRITE ACTOR 3: auto-answer ─────────────────────────────────────────────
// Press Enter on a routine prompt whose default is the safe affirmative, once per
// distinct prompt. Never touches a rate-limited session (resume owns it). Mirrors
// server.ts's old 837-869 loop verbatim.
export const answerActor: WriteActor = {
  name: "answer",
  enabled: (ctx) => ctx.flags.autoAnswer,
  decide(ctx, s) {
    const { maps } = ctx;
    if (!s.prompt || s.rateLimit || s.status !== "waiting") {
      // Re-arm the once-per-prompt guard ONLY on a truly settled turn (idle/dead),
      // never on a transient running flap that would let the SAME prompt answer twice.
      if (shouldRearmAutoAnswer(s.status)) maps.autoAnswered.delete(s.id);
      return null;
    }
    const action = nextAutoAnswerAction({ prompt: s.prompt, status: s.status });
    if (action !== "answer") return null;
    const sig = promptSignature(s.prompt);
    if (maps.autoAnswered.get(s.id) === sig) return null;
    if (!ctx.claimWrite(s.id)) return null;
    maps.autoAnswered.set(s.id, sig);
    ctx.deps.log(
      `auto-answer: accepted ${s.prompt.kind} prompt in ${s.name} (${s.prompt.line})`
    );
    return {
      kind: "sendEnter",
      sessionName: s.name,
      onFail: () => maps.autoAnswered.delete(s.id),
    };
  },
};

// ── WRITE ACTOR 4: inter-agent channel delivery ────────────────────────────
// Inject one unread channel message into a settled recipient's terminal, claiming
// the row atomically BEFORE the paste so two attempts can't double-deliver. One
// delivery in flight per session. Mirrors server.ts's old 989-1044 loop verbatim.
export const channelActor: WriteActor = {
  name: "channel",
  enabled: (ctx) => ctx.flags.channelDeliver,
  decide(ctx, s) {
    const { maps, deps } = ctx;
    if (deps.isBudgetParked(s.id)) return null;
    if (
      channelDeliveryBlocked({
        rateLimited: !!s.rateLimit,
        rateLimitResumed: maps.rateLimitResumed.has(s.id),
        queueDispatched: maps.queueDispatched.has(s.id),
        channelInFlight: maps.channelDelivering.has(s.id),
      })
    )
      return null;
    if (!isChannelDeliveryTurn({ status: s.status, hasPrompt: !!s.prompt }))
      return null;
    const msg = deps.nextUnreadMessage(s.id);
    if (!msg) return null;
    // Atomically claim BEFORE pasting; a loser (or a message a pull consumed) skips.
    if (!deps.claimDelivery(msg.id)) return null;
    if (!ctx.claimWrite(s.id)) return null;
    maps.channelDelivering.add(s.id);
    const text = deps.buildChannelDeliveryText(msg);
    return {
      kind: "pasteText",
      sessionName: s.name,
      text,
      onFail: () => {
        // The paste failed → un-claim so the next tick re-delivers (else the row
        // is stamped delivered+read: invisible to push AND pull, silently lost).
        try {
          deps.resetDelivery(msg.id);
        } catch (resetErr) {
          console.error("channel un-claim failed:", resetErr);
        }
      },
      onSettled: () => maps.channelDelivering.delete(s.id),
    };
  },
};
