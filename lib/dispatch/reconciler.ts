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
import { getPRForBranch } from "../pr";
import { listEligibleIssues } from "./issues";
import { dispatchOne } from "./dispatcher";
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

/** The first `slots` pending candidates (already FIFO-ordered by the query). */
export function pickCandidates(
  pending: IssueDispatch[],
  slots: number
): IssueDispatch[] {
  return slots <= 0 ? [] : pending.slice(0, slots);
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
    const repos = queries.getEnabledDispatchRepos(db).all() as DispatchRepo[];
    for (const repo of repos) {
      // 1. Ingest eligible open issues as `pending` candidates (idempotent).
      for (const issue of listEligibleIssues(repo)) {
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

      // 2. Headroom (daily cap ∧ concurrency cap).
      const dailyDone = (
        queries.countDispatchesToday(db).get(repo.id) as { n: number }
      ).n;
      const liveInFlight = (
        queries.countLiveInFlight(db).get(repo.id) as { n: number }
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
      const pending = queries
        .listPendingForRepo(db)
        .all(repo.id) as IssueDispatch[];
      for (const candidate of pickCandidates(pending, slots)) {
        await dispatchOne(repo, candidate);
      }
    }

    // 4. Link PRs: detect a worker's PR by its branch and store it. Kept here
    // (the slow 60s tick) rather than the 2.5s status ticker so the blocking gh
    // call never stalls the live status broadcast.
    for (const d of queries
      .listInFlightMissingPR(db)
      .all() as IssueDispatch[]) {
      if (!d.worktree_path || !d.branch_name) continue;
      const pr = getPRForBranch(d.worktree_path, d.branch_name);
      if (pr) {
        queries.updateDispatchPR(db).run(pr.url, pr.number, pr.state, d.id);
      }
    }
  } catch (err) {
    console.error("dispatch reconcile tick failed:", err);
  } finally {
    tickBusy = false;
  }
}

/**
 * Startup orphan reconcile: a Tier-1 (in-process) restart kills running agents
 * but leaves their `dispatched` rows, which would wrongly hold concurrency
 * slots. Mark any active dispatch whose session is no longer live as `failed`.
 * (Tier-2 sessions survive a restart, so they stay live and are untouched.)
 */
export async function reconcileOrphans(): Promise<void> {
  const db = getDb();
  const active = queries.listActiveDispatches(db).all() as IssueDispatch[];
  if (active.length === 0) return;

  let liveNames: Set<string>;
  try {
    liveNames = new Set(await getSessionBackend().list());
  } catch {
    return; // can't enumerate sessions → don't risk false "failed" marks
  }

  for (const d of active) {
    if (!d.session_id) continue;
    const sess = queries.getSession(db).get(d.session_id) as
      | Session
      | undefined;
    const live = sess && liveNames.has(sess.tmux_name);
    if (!live) {
      queries.updateDispatchStatus(db).run("failed", d.id);
      console.log(`dispatch: orphan reconciled → failed (${d.id})`);
    }
  }
}
