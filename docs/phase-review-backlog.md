# Phase-review backlog — cross-advancement integration bugs

A **holistic, cross-advancement ultra review** of the shipped amux operator backlog
(#1–#12, #14, #15), run 2026-06-28: 33 agents — 7 adversarial reviewers (one per
phase + 3 cross-cutting on the convergence seams: the shared `server.ts` ticks, the
shared prompt-queue's producers, the MCP-server/DB-migration stack) → a per-finding
refutation pass → synthesis. It found bugs the **isolated per-advancement reviews
structurally could not see**: each only saw one diff, never the phases as an
integrated whole.

**Verdict:** 16 confirmed bugs (4 HIGH, 7 MED, 5 LOW). **None CRITICAL** — no data
corruption, crash, or security hole. Dominant root cause: the four unattended
`server.ts` status-tick loops (prompt-queue dispatch, rate-limit resume #10, channel
delivery #6, scheduler #5) act on **one shared status snapshot** with only partial
shared guards, but were each built/reviewed in isolation, so their **composition**
was wrong.

> Every fix below should land with the regression test AGENTS.md requires, through
> the normal gate (tsc + test + build → 3-agent review → PR). `main` requires
> **linear history** — merge PRs with `gh pr merge --rebase`. Required CI checks are
> only `ubuntu/macos/windows`; `visual-regression` always fails (no committed
> baselines) and is **not** required.

---

## ✅ Fixed — PR #301 (merged `fd2ffb4`)

- **HIGH — queue dispatch ignored rate-limits (default path, no flag).** A Claude
  "limit reached" screen classifies as **idle**, so the status-tick queue-dispatch
  loop pasted a queued / scheduled / fork-seed prompt into the limited TUI **before
  its reset** — defeating #10's auto-resume gating, and the prompt was dequeued
  (silently lost). Fix: pure, unit-tested cross-loop predicates in
  `lib/tick-guards.ts` (`queueDispatchBlocked` / `channelDeliveryBlocked`) wired into
  `server.ts` — the queue loop skips a rate-limited or channel-in-flight session
  (the resume loop owns delivery at `resetAt`, or it waits for the limit to clear);
  the channel loop skips rate-limited / just-resumed / queue-dispatched / in-flight.
- **HIGH — offline action stranded when `fetch` rejects while online (#12).** A 502 /
  server restart / captive portal queued the action + toasted "will send when you
  reconnect", but no `online` event ever fires → never replayed until a page reload.
  Fix: while-online drain triggers (`visibilitychange` + a 45s safety-net interval)
  in `hooks/useOfflineQueue.ts` + accurate toast wording in `hooks/useSessionQueue.ts`.
- **MED (×3, subsumed by the above)** — channel-vs-rate-limit double-inject; the
  queue↔channel asymmetric in-flight guard; and the "zero tick integration-test
  coverage" gap (now covered by the pure tested predicates).

---

## 🔴 Open — HIGH

### HIGH#2 — native fork double-counts token/cost (#11 × #15)

A native Claude fork (`--resume <parent> --fork-session`) inherits the parent's
**entire** transcript, so `parseClaudeUsage` reads the parent's full history as the
fork's usage. The fleet **cost badge roughly doubles** the parent's spend, and the
persisted fleet curve shows a **spurious spike on the fork day**.

- **Files:** `lib/session-cost.ts` (`readClaudeSessionUsage` / `computeSessionCosts`),
  `lib/cost-history.ts` (`aggregateFleetHistory` / `persistCostSamples`),
  `app/api/sessions/[id]/fork/route.ts`, `app/api/sessions/cost/route.ts`.
- **Fix:** make the cost path **fork-aware**. Capture a per-session
  `baselineTokens` / `baselineCost` at fork time (the parent's cumulative-at-fork)
  and only book a native fork's spend **above** that inherited baseline — e.g. seed
  the fork's `session_costs` starting peak with the parent's baseline, or subtract
  the parent baseline when persisting/aggregating for a session whose
  `parent_session_id` is set and `forkModeForProvider === "native"`.
- **Test:** fork a Claude session; assert the fleet total / history is **not**
  inflated by the parent's copied history.
- **Effort:** medium · **Risk:** low–medium (pure-ish cost path; well-tested seam).

### HIGH#3 — Windows Tier-2 live-wall observer permanently breaks full-screen resize (#7)

On the Windows pty-host daemon (the **default** Windows backend), a live-wall
**observer** attach evicts the **real** terminal's sizing client, so a full-screen
pane can **never resize again** until a full re-attach. Repro is ordering-dependent
(observer attaches _after_ the sizing client — the live flow: a worker full-screen in
pane A, the live wall observing the same session in pane B).

- **Files:** `lib/session-backend/pty/host.ts` (attach / `detachKey` / resize),
  `lib/session-backend/pty/host-client.ts` (ref-counted detach).
- **Fix:** give the daemon **per-subscription slots** for a key
  (`Map<key, Set<sub>>` with a sub id in the attach/detach protocol) so an observer
  attach never evicts the real terminal's sizing client. Minimal stopgap: skip the
  `detachKey()` eviction when the incoming attach is an **observer**, and key
  `conn.attached` by `(key, observer)` so a same-key observer doesn't clobber the
  real viewer's entry.
- **Test:** a Tier-2 IPC test for the observer-attaches-after-sizing-client ordering,
  asserting resize still applies after the observer detaches.
- **Effort:** medium–high · **Risk:** **higher** — touches the backend daemon
  protocol seam; needs care + the daemon test isolation pattern (`STOA_PTY_HOST_NAME`).

---

## 🟡 Open — MED

- **`STOA_PORT` → `PORT` not mapped for the dev server.** `lib/load-env.ts` loads
  `.env` verbatim but doesn't translate `STOA_PORT`→`PORT` the way `serverEnv()`
  does, so `npm run dev` ignores the documented `STOA_PORT` knob and `stoa doctor`'s
  port probe disagrees with where the server actually binds. **Fix:** after loading
  `.env`, if `process.env.PORT` is unset, set it from `STOA_PORT` (in `load-env.ts`).
- **`session_costs` PK collision.** `lib/cost-history.ts` keys cost samples by
  `tmux_name || name` (a display name, not unique) instead of the canonical backend
  key; two same-named non-tmux sessions overwrite each other's daily cost row.
  **Fix:** key by `backendKeyForSession(s)` (or add `session_id` to the PK); align
  `lib/analytics/queries.ts:101` on the same key. (Trigger needs the non-default
  "Use tmux session" unchecked + two same-named cost-bearing Claude sessions.)
- **Recurring schedule grows the prompt queue unbounded.** A schedule (#5) targeting
  a session that stays non-idle enqueues a copy every fire; `SCHEDULE_MAX_PER_SESSION`
  caps distinct schedules, not enqueued copies → a backlog dumps one-per-turn on
  recovery. **Fix:** cap queue depth in `enqueuePrompt` (drop/coalesce over a
  `MAX_QUEUE_DEPTH`), or have `fireSchedule` skip when the prompt is already queued.
- **Native fork loses its branch on WS reconnect before its first turn.** The
  reattach path (`components/Pane/index.tsx` `onConnected`) calls
  `buildSpawnForSession` with no `parentSessionId` / `--fork-session`, launching a
  brand-new empty Claude. **Fix:** make `buildSpawnForSession` self-resolve the
  native-fork parent like `app/page.tsx` does (look up the parent's
  `claude_session_id` when `parent_session_id` is set and fork mode is native).

---

## 🟢 Open — LOW

- **error↔rate-limit classification asymmetry.** A rate-limit phrasing that also
  matches `ERROR_PATTERNS` (the "exceeded/exhausted" family) is never auto-resumed,
  because `status === "error"` short-circuits the resume loop — coverage silently
  depends on exact provider wording. Document the asymmetry and/or treat
  `s.rateLimit` as authoritative over an `error` classification.
- **Session delete orphans channel data.** Deleting a session clears its prompt-queue
  but leaves its `channel_messages` (and lets schedules self-disable on next fire).
  Hygiene only (nothing polls a dead session). **Fix:** also delete the session's
  `schedules` + `channel_messages` in `app/api/sessions/[id]/route.ts`.
- **Channel push double-deliver race.** `nextUnreadMessage → pasteText →
markDelivered` isn't atomic vs. a concurrent `channel_inbox` pull, so one message
  can be both pasted and read as inbox data. **Fix:** claim-and-mark in one
  transaction (like `consumeInbox`) before pasting.
- **Budget tick + cost sampler re-read every transcript** with no shared cache (~+10%
  load when both opt-ins are armed). **Fix:** memoize `computeSessionCosts` for
  ~10–15s keyed on the session set.

---

_Full structured findings (per-agent + the refutation verdicts) live in the
`wd2mkz8t8` workflow output under the session transcript dir._
