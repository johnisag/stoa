/**
 * Dispatch — the daily-allocation reconciler.
 *
 * State-driven, NOT a fire-once cron: each tick (and once at startup) it ingests
 * eligible issues, then tops each enabled repo up toward its daily quota,
 * honoring a concurrency cap. Because the daily cap is computed from rows
 * dispatched today (`countDispatchesToday`), a day missed while Stoa was down is
 * simply caught up on the next tick — there's no fire-time to miss.
 *
 * `computeSlots` and `pickCandidates` are pure (unit-tested); `reconcileTick`
 * and `reconcileOrphans` do the I/O.
 */

import { randomUUID } from "crypto";
import { getDb, queries, type Session } from "../db";
import { getSessionBackend } from "../session-backend";
import { expandHome } from "../platform";
import { isWorkerHung, workerMaxAgeMs } from "../watchdog";
import {
  dispatchBackoffThreshold,
  isWindowSaturated,
  type RateLimitWindow,
} from "../rate-limit-window";
import { readRateLimitWindow } from "../rate-limit-window-source";
import { sqliteTimeToMs } from "../sqlite-time";
import { retryFleetCleanupForRepo } from "../fleet/cleanup";
import { getPRForBranchAnyState } from "./issues";
import { resolveIssueSource } from "./sources";
import { dispatchSupported } from "./issue-source";
import { dispatchOne } from "./dispatcher";
import { autoMergePass, getPrReadiness } from "./auto-merge";
import { ciFixPass } from "./ci-fix";
import { parseClaims, claimsConflict, normalizeClaim } from "./claims";
import { captureLessons } from "./lessons";
import { mergeTrainPass } from "./merge-train";
import { reconcileStaleDispatches } from "./stale";
import { verifyPass } from "./verify";
import { judgePass } from "./judge";
import { sessionCeremonyPass } from "./session-ceremony";
import { nextOccurrence, isRecurrenceDue } from "./recurrence";
import { isLocalTask } from "./task-label";
import {
  spawnSurvey,
  readSurveyRun,
  cleanupSurveyRun,
  hasSurveyRun,
  trackedSurveyIds,
  buildMaintainerTaskBody,
  sweepOrphanedSurveys,
  DEDUP_LIST_CAP,
  DEFAULT_SURVEY_CAP,
  type SurveyRunStatus,
} from "./maintainer";
import type { SurveyTask } from "./types";
import {
  nextReviewAction,
  spawnReviewPanel,
  spawnFixer,
  aggregatePanelVerdict,
  MAX_FIX_ROUNDS,
} from "./reviewer";
import type { DispatchRepo, IssueDispatch, SlotInputs } from "./types";

/**
 * How many workers may be spawned for a repo right now: the smaller of the
 * remaining daily quota and the remaining concurrency headroom (never negative).
 */
export function computeSlots(input: SlotInputs): number {
  const dailyLeft = input.dailyQuota - input.dailyDone;
  const concurrencyLeft = input.maxConcurrency - input.liveInFlight;
  return Math.max(0, Math.min(dailyLeft, concurrencyLeft));
}

/**
 * M2c proactive backoff: should we HOLD new dispatches for this repo because Claude's
 * rolling rate-limit window is saturated? Claude-only — the window is Claude-account-
 * specific, so a codex/hermes/kilo/kimi worker isn't bound by it. A no-op when the
 * window is absent (M2b hook not installed) or backoff is disabled (isWindowSaturated
 * handles both → false). Reactive resume (lib/rate-limit.ts) still drains sessions
 * already AT the limit; this only stops STARTING work that would immediately hit the
 * wall. Pure → unit-tested.
 */
export function shouldBackOffDispatch(
  agentType: string,
  window: RateLimitWindow | null,
  threshold: number
): boolean {
  return agentType === "claude" && isWindowSaturated(window, threshold);
}

/** The first `slots` pending candidates (already FIFO-ordered by the query). */
export function pickCandidates(
  pending: IssueDispatch[],
  slots: number
): IssueDispatch[] {
  return slots <= 0 ? [] : pending.slice(0, slots);
}

/**
 * Conflict-aware scheduling: from FIFO-ordered `pending`, pick up to `slots` rows to
 * dispatch this tick, SKIPPING any whose file_claims conflict with a claim already
 * live (seeded from `liveClaims`) or already chosen this tick. A no-claims row is
 * always schedulable (exactly today's behavior — pickCandidates). A skip is NOT a
 * hard stop: a later, disjoint row is still picked, and a skipped row stays pending
 * (FIFO-first) for a later tick — so overlapping tasks SERIALIZE rather than open
 * two PRs that collide at merge. Only ever a SUBSET of what computeSlots permitted,
 * so the quota + concurrency caps are wholly preserved. Pure → unit-tested.
 */
export function pickSchedulable(
  pending: IssueDispatch[],
  liveClaims: string[][],
  slots: number
): IssueDispatch[] {
  if (slots <= 0) return [];
  const taken: string[][] = [...liveClaims];
  const chosen: IssueDispatch[] = [];
  for (const candidate of pending) {
    if (chosen.length >= slots) break;
    const parsed = parseSchedulingClaims(candidate.file_claims);
    if (parsed.unsafe) continue;
    const claims = parsed.claims;
    if (claims.length === 0) {
      chosen.push(candidate); // legacy / unclaimed row — unaffected
      continue;
    }
    if (taken.some((t) => claimsConflict(claims, t))) continue; // serialize
    taken.push(claims);
    chosen.push(candidate);
  }
  return chosen;
}

function parseSchedulingClaims(json: string | null | undefined): {
  claims: string[];
  unsafe: boolean;
} {
  if (!json) return { claims: [], unsafe: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { claims: [], unsafe: true };
  }
  if (!Array.isArray(parsed)) return { claims: [], unsafe: true };
  const claims: string[] = [];
  for (const raw of parsed) {
    if (typeof raw !== "string") return { claims: [], unsafe: true };
    const folded = raw.trim().replace(/\\/g, "/");
    if (!folded || folded.startsWith("/") || folded.startsWith("~")) {
      return { claims: [], unsafe: true };
    }
    if (/^[a-z]:/i.test(folded)) return { claims: [], unsafe: true };
    const claim = normalizeClaim(raw);
    if (!claim) return { claims: [], unsafe: true };
    if (!claims.includes(claim)) claims.push(claim);
  }
  return { claims, unsafe: false };
}

/**
 * IDs of scheduled rows that are due (`scheduled_at <= now`). Pure + unit-tested.
 * A missing/unparseable `scheduled_at` is treated as due (fail-open, so a bad
 * timestamp can never strand an issue in 'scheduled' forever).
 */
export function dueDispatchIds(
  rows: { id: string; scheduled_at: string | null }[],
  nowMs: number
): string[] {
  return rows
    .filter((r) => {
      if (!r.scheduled_at) return true;
      const t = Date.parse(r.scheduled_at);
      return Number.isNaN(t) || t <= nowMs;
    })
    .map((r) => r.id);
}

/** A recurring task to re-arm: the fields to insert its NEXT occurrence as a
 * fresh scheduled local task. */
export interface ScheduledReArm {
  repoId: string;
  title: string | null;
  taskBody: string | null;
  scheduledAt: string;
  recurrence: string;
  autoMerge: number;
}

/**
 * Plan the scheduled-promotion step: which rows to promote to 'pending', and the
 * recurring LOCAL tasks to re-arm (their next future occurrence). Pure so the
 * re-arm is unit-testable; the reconciler applies the DB writes. A recurring row
 * is re-armed BEFORE it's promoted, so the chore keeps firing even though this
 * instance becomes a one-time dispatch.
 */
export function planScheduledPromotion(
  scheduled: IssueDispatch[],
  nowMs: number
): { promoteIds: string[]; reArms: ScheduledReArm[] } {
  const promoteIds = dueDispatchIds(scheduled, nowMs);
  const due = new Set(promoteIds);
  const reArms: ScheduledReArm[] = [];
  for (const row of scheduled) {
    if (!due.has(row.id) || !row.recurrence || !isLocalTask(row)) continue;
    const nextAt = nextOccurrence(row.recurrence, row.scheduled_at, nowMs);
    if (nextAt) {
      reArms.push({
        repoId: row.repo_id,
        title: row.issue_title,
        taskBody: row.task_body,
        scheduledAt: nextAt,
        recurrence: row.recurrence,
        autoMerge: row.auto_merge,
      });
    }
  }
  return { promoteIds, reArms };
}

let tickBusy = false;

/**
 * One reconcile pass over every enabled repo: ingest → compute headroom →
 * (auto) dispatch up to the slot count, or (review) leave candidates pending for
 * one-tap approval. Guarded so overlapping ticks (slow gh / spawn) can't stack.
 */
export async function reconcileTick(): Promise<void> {
  if (tickBusy) return;
  tickBusy = true;
  try {
    const db = getDb();
    // 0. Promote any scheduled rows that have come due → pending, so the normal
    // headroom/mode logic below dispatches or surfaces them this tick. A recurring
    // local task is re-armed first (its next occurrence is inserted as a fresh
    // scheduled clone) so the chore keeps firing.
    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    // M2c proactive backoff: read Claude's rolling rate-limit window ONCE this tick —
    // and only when the feature is armed (threshold > 0), so the default path does no
    // file I/O and behaves exactly as before. Used to hold new claude dispatches below.
    const backoffThreshold = dispatchBackoffThreshold();
    const rlWindow = backoffThreshold > 0 ? readRateLimitWindow(now) : null;
    const scheduledRows = queries.listScheduled(db).all() as IssueDispatch[];
    const { promoteIds, reArms } = planScheduledPromotion(scheduledRows, now);
    // Apply atomically: if a re-arm insert or a promote throws mid-block, NOTHING
    // commits and the next tick retries cleanly — otherwise an inserted clone +
    // an un-promoted (still-due) original would fork a duplicate recurrence chain.
    db.transaction(() => {
      for (const r of reArms) {
        const cloneId = randomUUID();
        queries
          .insertLocalTask(db)
          .run(
            cloneId,
            r.repoId,
            r.title,
            r.taskBody,
            nowIso,
            r.scheduledAt,
            r.recurrence,
            "scheduled"
          );
        if (r.autoMerge) queries.setDispatchAutoMerge(db).run(1, cloneId);
      }
      for (const id of promoteIds)
        queries.promoteScheduledToPending(db).run(id);
    })();

    const repos = queries.getEnabledDispatchRepos(db).all() as DispatchRepo[];
    for (const repo of repos) {
      // 1. Ingest eligible open issues as `pending` candidates (idempotent).
      //    The source picker resolves to GitHub (default) or Linear per the
      //    repo's slug prefix (#34) — the ingest loop is source-agnostic.
      const issueSource = resolveIssueSource(repo);
      for (const issue of await issueSource.listEligible(repo)) {
        if (queries.getDispatchByRepoIssue(db).get(repo.id, issue.number)) {
          continue; // already a candidate / dispatched / done — never re-add
        }
        queries
          .upsertDispatchCandidate(db)
          .run(
            randomUUID(),
            repo.id,
            issue.number,
            issue.title,
            issue.url,
            issue.createdAt
          );
      }

      // #34: a non-github repo is intake-ONLY — its issues are ingested above
      // (and browsable) but never auto-dispatched, because the dispatch→PR loop
      // downstream is GitHub-hardcoded (gh issue view / PR-linking). Skip the
      // whole dispatch path for it until that path is made source-aware.
      if (!dispatchSupported(repo)) continue;
      await retryFleetCleanupForRepo(db, repo);

      // 2. Headroom (daily cap ∧ concurrency cap).
      const dailyDone =
        (queries.countDispatchesToday(db).get(repo.id) as { n: number }).n +
        (
          queries.countFleetWorkersCreatedTodayForRepo(db).get(repo.id) as {
            n: number;
          }
        ).n;
      const liveInFlight =
        (queries.countLiveInFlight(db).get(repo.id) as { n: number }).n +
        (
          queries.countActiveFleetWorkersForRepo(db).get(repo.id) as {
            n: number;
          }
        ).n;
      const slots = computeSlots({
        dailyQuota: repo.daily_quota,
        dailyDone,
        maxConcurrency: repo.max_concurrency,
        liveInFlight,
      });
      if (slots <= 0) continue;

      // 3. Auto dispatches now; review leaves candidates for manual approval.
      if (repo.mode !== "auto") continue;
      // M2c: don't START claude work that would immediately hit the wall — the binding
      // 5h/7d window is already saturated. The candidates stay pending (FIFO) for a
      // later, less-saturated tick; reactive resume drains anything already at the limit.
      if (shouldBackOffDispatch(repo.agent_type, rlWindow, backoffThreshold)) {
        console.log(
          `dispatch: backing off ${repo.repo_slug} — Claude rate-limit window at ` +
            `${Math.round((rlWindow?.pct ?? 0) * 100)}% ` +
            `(>= ${Math.round(backoffThreshold * 100)}% threshold)`
        );
        continue;
      }
      // The fence: maintainer-proposed rows are EXCLUDED here (maintainer_proposed=1),
      // so a survey proposal never auto-ships even on an auto-mode repo — it waits
      // for one-tap Approve in the Backlog. Everything else is identical.
      const pending = queries
        .listPendingDispatchableForRepo(db)
        .all(repo.id) as IssueDispatch[];
      // Conflict-aware: skip pending rows whose claims overlap a LIVE claim
      // (dispatched/pr_open — file custody held until merge) or another row chosen
      // this tick. No-op for unclaimed rows. Replaces the bare pickCandidates.
      let liveDispatchClaimsAreUnknown = false;
      const liveClaims = (
        queries.listLiveClaims(db).all(repo.id) as {
          file_claims: string | null;
        }[]
      ).map((r) => {
        const claims = parseSchedulingClaims(r.file_claims);
        if (claims.unsafe) liveDispatchClaimsAreUnknown = true;
        return claims.claims;
      });
      let fleetClaimsAreUnknown = false;
      const liveFleetClaims = (
        queries.listLiveFleetClaimsForRepo(db).all(repo.id) as {
          file_claims_json: string | null;
        }[]
      ).map((r) => {
        const claims = parseSchedulingClaims(r.file_claims_json);
        if (claims.unsafe || claims.claims.length === 0) {
          fleetClaimsAreUnknown = true;
        }
        return claims.claims;
      });
      if (liveDispatchClaimsAreUnknown || fleetClaimsAreUnknown) continue;
      for (const candidate of pickSchedulable(
        pending,
        [...liveClaims, ...liveFleetClaims],
        slots
      )) {
        await dispatchOne(repo, candidate);
      }
    }

    // 4. Sweep active workers: link opened/merged PRs and free slots held by
    // workers that finished/died. Kept here (the slow 60s tick), not the 2.5s
    // status ticker, so the blocking gh call never stalls the live status
    // broadcast. guardEmptyList=false: 60s in, the backend is ready, so an empty
    // list genuinely means "no live sessions" and dead workers should be swept.
    await sweepActiveWorkers({ guardEmptyList: false });

    // 4a. Stale reconcile: re-check every 'pr_open' row against GitHub so a PR
    // merged or closed OUT OF BAND (a human merged/closed it on github.com) is
    // resolved (→ merged / cancelled) instead of stranding the row on the board
    // forever. Before the review/CI/verify/auto-merge passes so a just-resolved row
    // is skipped by all of them this same tick.
    await reconcileStaleDispatches();

    // 4b. Autonomous maintainer (opt-in per repo): on its cadence, run a survey
    // agent that proposes its OWN backlog; file ready proposals as pending local
    // tasks fenced out of step 3's auto loop (they wait for one-tap Approve). After
    // the sweep so a just-finished survey's run is reaped before we read it, and
    // before the review passes (a freshly-filed task isn't a PR yet, so order vs.
    // them is moot). Survey spawns are bounded only by one-in-flight-per-repo
    // (hasSurveyRun) — they don't consume the dispatch concurrency/daily budget.
    await maintainerPass();

    // 5. Reviewer gate (opt-in per repo): spawn a 3-critic panel on each new PR
    // and aggregate their verdict comments into the cached decision for the
    // cockpit + fix loop. Non-gated repos are skipped (no-op unless review_gate).
    await reviewGatePass();

    // 6. CI auto-fix (opt-in per repo): spawn a fixer on any open PR with red
    // checks so it self-heals. Before auto-merge so a fix can start the same tick
    // a failure is seen. Non-armed repos are skipped.
    await ciFixPass();

    // 7. Merge train (opt-in per repo): rebase-repair any ready-but-CONFLICTING PR
    // (the base moved under it) so it stays landable. After CI-fix (green first),
    // before auto-merge so a freshly-rebased PR can land next tick. No-op unarmed.
    await mergeTrainPass();

    // 8. Verify harness (opt-in per repo): run the repo's verify_command in each
    // worker's worktree and attach the result to the review card; the slow build
    // runs FIRE-AND-FORGET (never holds the tick). After the merge train so the
    // just-pushed head is what's verified, before auto-merge so a 'pass' gates the
    // landing. No-op for non-armed repos.
    await verifyPass();

    // 8b. Rubric judge (#26, opt-in per repo): run the binary LLM judge over each
    // open PR's diff, once per head. Fire-and-forget like verify; after the merge
    // train / verify so the judged head is current, before auto-merge so a 'pass'
    // gates the landing. No-op for non-armed repos.
    await judgePass();

    // 9. Auto-merge (opt-in per issue): merge any ready PR whose row asked for it.
    // After the reviewer + CI + verify + judge passes so a just-approved,
    // just-green, just-verified, just-judged PR can merge.
    await autoMergePass();

    // 10. Session "go to auto": drive any session a user handed off through the
    // SAME ceremony (panel → fix → CI-fix → auto-merge). A no-op when none are
    // enrolled. Last, mirroring the issue passes it reuses.
    await sessionCeremonyPass();
  } catch (err) {
    console.error("dispatch reconcile tick failed:", err);
  } finally {
    tickBusy = false;
  }
}

/**
 * Re-check every still-'dispatched' worker and free its concurrency slot when it
 * is no longer actively coding:
 *   - PR exists for the branch → 'merged' (PR merged) or 'pr_open' (work delivered),
 *   - session no longer live (finished or a Tier-1-restart orphan) and no PR
 *     → 'failed'.
 * This keeps the concurrency cap honest — without it a worker that opened a PR,
 * merged it, or exited would pin its slot forever.
 *
 * `guardEmptyList`: when the backend returns ZERO live sessions, the dead→failed
 * sweep is ambiguous (a just-restarted Tier-2 daemon may not have rehydrated yet).
 * Pass `true` ONLY at startup to skip the dead-mark and avoid mass false failures.
 * Steady-state ticks pass `false` — otherwise, once all workers finish and no
 * other session exists, the empty list would skip the sweep forever and pin every
 * slot (a deadlock).
 */
export async function sweepActiveWorkers(opts: {
  guardEmptyList: boolean;
}): Promise<void> {
  const db = getDb();
  const rows = queries.listDispatched(db).all() as IssueDispatch[];
  if (rows.length === 0) return;

  let liveNames: Set<string>;
  try {
    liveNames = new Set(await getSessionBackend().list());
  } catch {
    return; // can't enumerate sessions → don't risk false "failed" marks
  }
  const skipDeadMark = opts.guardEmptyList && liveNames.size === 0;
  // Self-healing watchdog (opt-in via STOA_DISPATCH_WORKER_MAX_AGE_MS): age past
  // which a still-live worker is treated as hung and reaped, freeing its slot. 0
  // (default) = never reap by age (today's behavior). Read once per sweep.
  const maxAgeMs = workerMaxAgeMs();
  const nowMs = Date.now();
  // M2c: while Claude's rate-limit window is saturated, a 'dispatched' worker parked on
  // the limit is THROTTLED, not hung — skip the age-reaper so we don't false-reap (and
  // orphan the session of) a worker that's just waiting out the window. Consulted ONLY
  // when both the reaper (maxAgeMs) and backoff (threshold) are armed, so the default
  // path does no extra I/O. Fleet-wide: a non-claude worker is briefly spared too, which
  // only delays freeing its slot until the window clears — never a correctness loss.
  const reaperThreshold = dispatchBackoffThreshold();
  const reaperSaturated =
    maxAgeMs > 0 &&
    reaperThreshold > 0 &&
    isWindowSaturated(readRateLimitWindow(nowMs), reaperThreshold);

  for (const d of rows) {
    if (d.worktree_path && d.branch_name) {
      // Look up the PR repo-explicitly from the stable main checkout, not the
      // worker's worktree (which may have been reclaimed → misleading gh ENOENT).
      const repo = queries.getDispatchRepo(db).get(d.repo_id) as
        DispatchRepo | undefined;
      const pr = await getPRForBranchAnyState(
        repo ? expandHome(repo.repo_path) : expandHome(d.worktree_path),
        d.branch_name,
        repo?.repo_slug
      );
      // OPEN/MERGED → terminal-ish, frees the slot. A CLOSED (abandoned) PR falls
      // through to the dead-session check.
      if (pr && (pr.state === "OPEN" || pr.state === "MERGED")) {
        const status = pr.state === "MERGED" ? "merged" : "pr_open";
        queries
          .updateDispatchPR(db)
          .run(pr.url, pr.number, pr.state, status, d.id);
        continue;
      }
    }
    // The startup guard also gates the reaper: when the live list is
    // (ambiguously) empty right after a Tier-2 daemon restart, a worker that is
    // actually still alive but mid-rehydration must not be reaped on age alone —
    // that would defeat the very race the guard protects against.
    if (skipDeadMark) continue;
    // Hung-worker reaper: a worker still 'dispatched' (no OPEN/MERGED PR above)
    // that has been coding past the configured ceiling pins its concurrency slot
    // forever — reap it → 'failed' so the merge train keeps flowing. We only free
    // the slot; the pty is left alone (the operator can still inspect/resume the
    // session). Runs before the dead-session check so a hung-but-live worker is
    // caught (the dead check would leave a live one dispatched).
    if (
      !reaperSaturated &&
      isWorkerHung({
        dispatchedAtMs: sqliteTimeToMs(d.dispatched_at),
        nowMs,
        maxAgeMs,
      })
    ) {
      queries.updateDispatchStatus(db).run("failed", d.id);
      console.log(
        `dispatch: worker reaped (hung > ${Math.round(maxAgeMs / 60000)}m) → failed (${d.id})`
      );
      continue;
    }
    const sess = d.session_id
      ? (queries.getSession(db).get(d.session_id) as Session | undefined)
      : undefined;
    const live = sess && liveNames.has(sess.tmux_name);
    if (!live) {
      queries.updateDispatchStatus(db).run("failed", d.id);
      console.log(`dispatch: worker swept → failed (${d.id})`);
    }
  }
}

/** First non-empty line of a task body, trimmed and capped — the dedup-list hint
 * shown to the survey so it judges overlap by meaning. */
function firstLine(body: string | null): string {
  if (!body) return "";
  const line = body.split("\n").find((l) => l.trim().length > 0) ?? "";
  const trimmed = line.trim();
  return trimmed.length > 120 ? `${trimmed.slice(0, 117)}…` : trimmed;
}

/** File a ready survey's proposals as pending, maintainer-proposed local tasks in
 * ONE transaction, skipping any whose exact title already has an open task (the
 * dedup backstop behind the agent's semantic dedup). */
function fileSurveyTasks(
  db: ReturnType<typeof getDb>,
  repoId: string,
  tasks: SurveyTask[],
  nowIso: string
): void {
  db.transaction(() => {
    for (const task of tasks) {
      if (queries.findOpenLocalTaskByTitle(db).get(repoId, task.title)) {
        continue; // an open task with this exact title already exists
      }
      queries
        .insertMaintainerTask(db)
        .run(
          randomUUID(),
          repoId,
          task.title,
          buildMaintainerTaskBody(task),
          nowIso
        );
    }
  })();
}

/**
 * Autonomous-maintainer pass (opt-in per repo). Two halves, both no-ops unless a
 * repo armed `maintainer_survey_enabled` with a goal:
 *
 *   (a) SPAWN — for each enabled, armed repo whose cadence is due and which has no
 *       survey already in flight, stamp `last_at` (the cadence anchor, written
 *       BEFORE the spawn so a crash can't re-fire it every tick) then launch a
 *       read-only survey worker. On a spawn failure the anchor is rolled back so
 *       the next tick retries.
 *   (b) FILE — for each tracked survey run, poll its survey artifact: 'ready' files the
 *       proposed tasks as pending local rows (maintainer_proposed=1, fenced out of
 *       step-3 auto-dispatch — they wait for one-tap Approve), de-duped by exact
 *       title; 'ready' and 'failed' both reclaim the worktree. 'running' waits.
 */
export async function maintainerPass(): Promise<void> {
  const db = getDb();
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();

  // (a) Spawn surveys whose cadence is due.
  const repos = queries.getEnabledDispatchRepos(db).all() as DispatchRepo[];
  for (const repo of repos) {
    if (repo.maintainer_survey_enabled !== 1) continue;
    const goal = repo.maintainer_survey_goal?.trim();
    if (!goal) continue; // armed but no goal → nothing to survey toward
    if (
      !isRecurrenceDue(
        repo.maintainer_survey_cadence,
        repo.maintainer_survey_last_at,
        nowMs
      )
    ) {
      continue;
    }
    if (hasSurveyRun(repo.id)) continue; // a survey is already in flight (spawn-once)

    // Stamp the anchor BEFORE spawning; roll back if the spawn throws so the next
    // tick retries instead of waiting a whole interval on a transient failure.
    const prevAnchor = repo.maintainer_survey_last_at;
    queries.setMaintainerSurveyRanAt(db).run(nowIso, repo.id);
    try {
      const openTasks = (
        queries
          .listOpenTasksForSurveyDedup(db)
          .all(repo.id, DEDUP_LIST_CAP) as {
          issue_title: string | null;
          task_body: string | null;
        }[]
      ).map((r) => ({
        title: r.issue_title ?? "",
        bodyFirstLine: firstLine(r.task_body),
      }));
      await spawnSurvey(repo, goal, openTasks);
    } catch (err) {
      queries.setMaintainerSurveyRanAt(db).run(prevAnchor, repo.id);
      console.error(
        `maintainer: survey spawn failed (${repo.repo_slug}):`,
        err
      );
    }
  }

  // (b) File ready surveys; reclaim finished/failed ones.
  for (const surveyId of trackedSurveyIds()) {
    let status: SurveyRunStatus;
    try {
      status = await readSurveyRun(surveyId);
    } catch {
      continue; // transient read/list error → re-poll next tick
    }
    if (status.status === "running") continue;
    if (status.status === "ready" && status.tasks.length > 0) {
      try {
        // Enforce the cap structurally (it's only advisory in the prompt) so a
        // runaway/injected survey can't flood the backlog with proposals.
        fileSurveyTasks(
          db,
          status.repoId,
          status.tasks.slice(0, DEFAULT_SURVEY_CAP),
          nowIso
        );
      } catch (err) {
        console.error("maintainer: filing survey tasks failed:", err);
      }
    }
    await cleanupSurveyRun(surveyId);
  }
}

/**
 * Reviewer-gate pass: for every open PR whose repo armed `review_gate`, spawn the
 * 3-critic panel once, then aggregate the critics' verdict comments into the
 * cached decision that drives the fix loop + cockpit badge. A no-op for non-gated
 * repos (the common case).
 */
export async function reviewGatePass(): Promise<void> {
  const db = getDb();
  const prOpen = queries.listPrOpen(db).all() as IssueDispatch[];
  if (prOpen.length === 0) return;

  // One backend list for the whole pass — used to tell if a fixer is still live.
  let liveNames: Set<string>;
  try {
    liveNames = new Set(await getSessionBackend().list());
  } catch {
    liveNames = new Set();
  }
  const isAlive = (sessionId: string | null): boolean => {
    if (!sessionId) return false;
    const s = queries.getSession(db).get(sessionId) as Session | undefined;
    return !!s && liveNames.has(s.tmux_name);
  };

  for (const d of prOpen) {
    const repo = queries.getDispatchRepo(db).get(d.repo_id) as
      DispatchRepo | undefined;
    if (!repo || repo.review_gate !== 1) continue;

    const fixerAlive = isAlive(d.fixer_session_id);

    // Once the panel is spawned and no fixer is active, aggregate the critics'
    // verdict comments (this fix round only) and cache the decision when complete.
    let decision = d.review_decision;
    if (
      d.reviewer_session_id &&
      !fixerAlive &&
      d.worktree_path &&
      d.pr_number != null
    ) {
      const verdict = await aggregatePanelVerdict(
        expandHome(repo.repo_path),
        d.pr_number,
        d.fix_rounds,
        repo.repo_slug
      );
      if (
        verdict.complete &&
        verdict.decision &&
        verdict.decision !== decision
      ) {
        // Pin the verdict to the head SHA that was read in the SAME gh invocation
        // as the comments, so the pinned SHA cannot race a push between verdict
        // aggregation and a separate SHA read. A gh failure leaves headRefOid null;
        // we still cache the decision but auto-merge will wait for a non-null pin.
        queries
          .setDispatchReviewDecision(db)
          .run(verdict.decision, verdict.headRefOid, d.id);
        decision = verdict.decision;
      }
    }

    const action = nextReviewAction({
      reviewGate: true,
      status: d.status,
      prNumber: d.pr_number,
      reviewerSessionId: d.reviewer_session_id,
      reviewDecision: decision,
      fixerSessionId: d.fixer_session_id,
      fixerAlive,
      fixRounds: d.fix_rounds,
      maxFixRounds: MAX_FIX_ROUNDS,
    });

    if (action === "spawn_critic") await spawnReviewPanel(repo, d);
    else if (action === "spawn_fixer") {
      // Fleet memory: record the BLOCKING findings (once per fix round) before the
      // fixer runs, so future workers in this repo see them as known pitfalls.
      await captureLessons(repo, d);
      await spawnFixer(repo, d);
    } else if (action === "rereview") queries.resetForReReview(db).run(d.id);
    // wait / approved / stuck / idle → nothing to do this tick
  }
}

/**
 * Startup reconcile: link any PRs opened just before a restart and free slots
 * held by workers that didn't survive a Tier-1 restart. Uses the empty-list guard
 * so a Tier-2 daemon mid-rehydration doesn't get its live workers mass-failed;
 * any genuinely-dead worker it skips is swept by the first 60s tick.
 */
export async function reconcileOrphans(): Promise<void> {
  // Reclaim survey sessions/worktrees orphaned by a restart (the in-memory
  // surveyRuns map doesn't survive one). FIRST — it's fast (DB + kill) and runs at
  // t≈0, before the slow per-worker gh calls below could let the 60s tick spawn a
  // fresh survey. Decoupled so a failure here never blocks the worker sweep.
  try {
    await sweepOrphanedSurveys();
  } catch (err) {
    console.error("maintainer: orphan-survey sweep failed:", err);
  }
  await sweepActiveWorkers({ guardEmptyList: true });
}
