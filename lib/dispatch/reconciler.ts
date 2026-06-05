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

    // 4. Sweep active workers: link opened PRs and free slots held by workers
    // that finished/died. Kept here (the slow 60s tick), not the 2.5s status
    // ticker, so the blocking gh call never stalls the live status broadcast.
    await sweepActiveWorkers();
  } catch (err) {
    console.error("dispatch reconcile tick failed:", err);
  } finally {
    tickBusy = false;
  }
}

/**
 * Re-check every still-'dispatched' worker and free its concurrency slot when it
 * is no longer actively coding:
 *   - PR opened (branch has a PR) → 'pr_open' (work delivered),
 *   - session no longer live (finished or a Tier-1-restart orphan) and no PR
 *     → 'failed'.
 * This is what keeps the concurrency cap honest over time — without it a worker
 * that opened a PR or exited would pin its slot forever.
 */
export async function sweepActiveWorkers(): Promise<void> {
  const db = getDb();
  const rows = queries.listDispatched(db).all() as IssueDispatch[];
  if (rows.length === 0) return;

  let liveNames: Set<string>;
  try {
    liveNames = new Set(await getSessionBackend().list());
  } catch {
    return; // can't enumerate sessions → don't risk false "failed" marks
  }
  // An empty list is ambiguous: a just-restarted Tier-2 daemon may not have
  // rehydrated its registry yet vs there being genuinely no live sessions. PR
  // detection is always safe, but skip the dead→failed marking in that case to
  // avoid mass false failures right after a restart — a truly dead worker is
  // swept on a later tick once any session is live.
  const skipDeadMark = liveNames.size === 0;

  for (const d of rows) {
    if (d.worktree_path && d.branch_name) {
      const pr = getPRForBranch(d.worktree_path, d.branch_name);
      if (pr) {
        queries.updateDispatchPR(db).run(pr.url, pr.number, pr.state, d.id);
        continue;
      }
    }
    if (skipDeadMark) continue;
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

/**
 * Startup reconcile: free slots held by workers that didn't survive a Tier-1
 * restart (and link any PRs opened just before). Delegates to the same sweep the
 * 60s tick uses. (Tier-2 sessions survive a restart, so they stay live.)
 */
export async function reconcileOrphans(): Promise<void> {
  await sweepActiveWorkers();
}
