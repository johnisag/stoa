# Agent-Pipeline (Stage 1) — Ultra-Review Findings

**Status:** Open — fix sequence in progress (2026-06-07)
**Feature:** declarative agent-pipeline DAG (#136) — `lib/pipeline/*`, `/api/pipelines`, MCP `run_pipeline`/`get_pipeline`
**Review:** 2× 3-agent supremacy pass (correctness/security · conventions/cross-platform/test-efficacy ·
simplicity/API-UX, then concurrency/resource-safety · failure-mode/data-integrity · API-contract-polish)

## TL;DR

The **pure engine is solid** — DAG validation (DFS cycle detection), the run-state reducer
(no double-start, outcomes only hit running steps), transitive cascade-skip, and run-status
derivation are all verified correct and exhaustively tested. The gaps are in the **executor's
lifecycle shell**, not the engine. Two of them make the feature actively unsafe to run today:
a **resource leak** (terminated/finished runs never kill their workers or reap worktrees) and a
**false "succeeded" signal** (success = "terminal went quiet", not "task done"). The feature is
backend-only/headless, so nothing bites until a pipeline is actually run — but it should not be
relied on until at least FIX 1 + FIX 2 land.

## Verified solid (no action)

- Engine: cycle detection (white/grey/black DFS, self-edge + back-edge handling), reducer guards
  (`applyStepStarted` only on pending, `applyStepOutcome` only on running, `endedAt ≥ startedAt`),
  transitive `cascadeSkip` to fixpoint, exhaustive `deriveRunStatus`.
- Crash-to-terminal **state** handling; registry eviction as a **memory** bound; `model` injection guard.
- The hypothesized launch/poll **races do not exist** _(in the current code)_ —
  single sequential per-run loop, per-run registry keys, no external abort path.
  Not worth further hunting — though note FIX 4/5 below add concurrent
  `putRun`/reattach paths, so re-check this once they land.

## Findings (severity-ordered → fix sequence)

### FIX 1 — CRITICAL · `forceTerminate` kills nothing (resource leak)

`lib/pipeline/executor.ts:219` · `ExecutorDeps` (`:36`) has no kill seam.
`killWorker()` exists (`lib/orchestration.ts:414`, kills pty/tmux + optional worktree removal) but
the pipeline **never calls it**. On timeout/crash/stuck — _and on clean success_ — every spawned
pty + git worktree + agent process leaks. A 50-step run orphans ~50 worktrees/processes with no
reaper; ≥`maxParallelism` keep burning tokens after a force-fail. Repeated runs accumulate until
disk / pty table fills.
**Fix:** add `terminate(sessionId)` to `ExecutorDeps` wired to `killWorker(id, cleanupWorktree=true)`;
`forceTerminate` awaits termination for every failed step; define + apply a cleanup policy for
succeeded steps' worktrees. Cap cumulative (not just concurrent) spawns. **Note:** this reaper only
covers sessions the in-memory run still knows about — orphans left by a mid-run _restart_ can't be
reaped until FIX 5 persists run↔session linkage.

### FIX 2 — HIGH · "succeeded" is not verified (false-positive outcome)

`lib/pipeline/default-deps.ts:71-88`.
`succeeded` is returned solely when a session was seen `running` then goes `idle` — zero inspection
of what the agent produced (no exit code, diff, commit, or PR). An agent that refuses, no-ops, or
errors with the error scrolled off-screen all report **succeeded**. Error scan only reads the current
rendered screen, so an early error that scrolls away before the next 3s poll is invisible.
**Fix:** require a truth signal before `succeeded` (completion sentinel, non-empty diff/commit in the
worktree, or PR existence); scan full scrollback for error markers; and/or rename the v1 outcome to
reflect what's actually known (e.g. `completed-turn` vs `verified`).

### FIX 3 — HIGH · No idempotency → double-launch on retry

`lib/pipeline/start.ts:64`.
Every `startPipeline` mints a fresh `randomUUID()` and launches. A conductor that retries
`run_pipeline` (timeout, dropped response, naive retry) launches the same expensive multi-agent DAG
twice. Dispatch already solved this with an atomic claim (`lib/dispatch/dispatcher.ts:76`); the
pipeline API is the one-off that omits it.
**Fix:** accept an optional `idempotencyKey` (or hash of `{conductorSessionId, spec}`); if a
non-terminal run with that key exists, return it instead of launching.

### FIX 4 — HIGH · Registry evicts LIVE runs

`lib/pipeline/registry.ts:63-74`.
Past the 100-run ceiling, the fallback drops the oldest-created run regardless of liveness; the
executor's next `putRun` resurrects it → thrash + intermittent 404s for pollers. The "true bound"
comment is false (re-insertion defeats it).
**Fix:** never evict a non-terminal run — apply back-pressure on new starts at the live ceiling, or
carry a tombstone set so an evicted id is dropped on re-`putRun` and the executor stops emitting.

### FIX 5 — HIGH · Orphans unrecoverable in principle (no run↔session linkage)

`lib/pipeline/start.ts`, `lib/db/queries.ts:116`.
The run id lives only in the in-memory registry; nothing on the session row records the run/step id.
`StepState.sessionId` is the only link and it's lost on restart. After a mid-run restart, worker
sessions survive in the DB with no marker tying them to a run/step — indistinguishable from
hand-spawned workers. No reconciler can exist without persisted linkage.
**Fix:** persist linkage (`pipeline_run_id`/`pipeline_step_id` columns on sessions, or a
`pipeline_runs` table snapshotting run state on every update) + a startup reconciler that re-attaches
or fails+cleans non-terminal runs. (Overlaps the roadmap's "run persistence" Stage-2 item.)

### FIX 6 — HIGH · `spawn_worker` MCP enum hardcoded (drift)

`mcp/orchestration-server.ts:114`.
`spawn_worker` hardcodes `["claude","codex","hermes"]` while `run_pipeline` derives from
`PROVIDER_IDS`/`SPAWNABLE_AGENTS`. Add a provider and the two silently diverge.
**Fix:** derive the `spawn_worker` enum from `SPAWNABLE_AGENTS`.

### FIX 7 — MED cluster (batch)

- `validateSpec` trusts field **types** it never checks → hostile JSON throws a 500 instead of a
  clean 400, and aborts the "report every problem" contract (`engine.ts:105`). Add type guards;
  also run cycle detection independent of unrelated field errors (`engine.ts:158`).
- **Timeout horizon**: `maxPollCycles` 4000 × 3s = **3.3h** before a stuck run force-fails, and the
  cycle counter is bypassed by launch/progress cycles → effectively unbounded. Use a real elapsed
  deadline; add a per-step timeout so a stuck `waiting` worker can't hold a slot for hours.
- **Termination reason**: `partial`/`failed` can't distinguish a designed mixed-outcome DAG from a
  timed-out/crashed one. Carry `terminationReason` on the run.
- **API hygiene**: don't echo raw `error.message` on 500 (match the spawn route's fixed string +
  server log); add a `toRunDTO` serializer so internal renames don't break the wire + omit/echo
  `spec` deliberately; surface a machine-readable done/running marker in `get_pipeline` instead of
  prose; add a spec example + dependsOn-validation note to the MCP tool descriptions.
- **Tests**: cover the HTTP/MCP route boundary (400 vs 500 vs 404); replace the synchronous
  parallelism test with one that can actually catch a slot race; add a diamond fan-in **failure**
  assertion (one branch fails → join skipped, other branch succeeds → run `partial`).
- **Engine truthfulness nits**: `applyStepFailedToStart` stamps a fake `startedAt` (should be null);
  `initRun` silently collapses duplicate ids (assert/throw); `deriveRunStatus` vs `isRunComplete`
  disagree on the empty-step set (validation-guarded, but exported reducers are public).
- **Observability**: a headless backend feature gives an operator no way to notice a leaked or
  force-failed run. Emit actionable logs/metrics on force-terminate + cumulative-spawn-cap hits so
  "50 orphaned worktrees" is visible, not silent.

## Fix order rationale

1–2 first (they make the feature unsafe/misleading to run). 3–6 next (correctness + cost + drift).
7 is a batched cleanup PR. Each ships as its own PR through the 3-OS CI matrix + 3-agent review gate.
