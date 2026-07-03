import type Database from "better-sqlite3";
import { getStmt } from "./_shared";

export const dispatchQueries = {
  // Dispatch — tracked repos (the allocation console rows)
  createDispatchRepo: (db: Database.Database) =>
    getStmt(
      db,
      `INSERT INTO dispatch_repos (id, repo_path, repo_slug, agent_type, daily_quota, max_concurrency, label_filter, base_branch, mode, enabled, review_gate, ci_autofix, merge_train, verify_gate, verify_command, project_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ),

  getDispatchRepo: (db: Database.Database) =>
    getStmt(db, `SELECT * FROM dispatch_repos WHERE id = ?`),

  getAllDispatchRepos: (db: Database.Database) =>
    getStmt(db, `SELECT * FROM dispatch_repos ORDER BY created_at ASC`),

  getEnabledDispatchRepos: (db: Database.Database) =>
    getStmt(
      db,
      `SELECT * FROM dispatch_repos WHERE enabled = 1 ORDER BY created_at ASC`
    ),

  updateDispatchRepo: (db: Database.Database) =>
    getStmt(
      db,
      `UPDATE dispatch_repos SET agent_type = ?, daily_quota = ?, max_concurrency = ?, label_filter = ?, base_branch = ?, mode = ?, enabled = ?, review_gate = ?, ci_autofix = ?, merge_train = ?, verify_gate = ?, verify_command = ?, updated_at = datetime('now') WHERE id = ?`
    ),

  // #20 cost-aware routing: the repo's worker base model (NULL = agent default).
  updateDispatchRepoDefaultModel: (db: Database.Database) =>
    getStmt(
      db,
      `UPDATE dispatch_repos SET default_model = ?, updated_at = datetime('now') WHERE id = ?`
    ),

  // #26 rubric judge: arm/disarm the per-repo gate (focused update, #20 pattern).
  updateDispatchRepoJudgeGate: (db: Database.Database) =>
    getStmt(
      db,
      `UPDATE dispatch_repos SET judge_gate = ?, updated_at = datetime('now') WHERE id = ?`
    ),

  deleteDispatchRepo: (db: Database.Database) =>
    getStmt(db, `DELETE FROM dispatch_repos WHERE id = ?`),

  // Autonomous maintainer config (a focused update so it doesn't disturb the
  // positional updateDispatchRepo). Args: (enabled 0/1, goal|null, cadence|null, id).
  updateMaintainerSurvey: (db: Database.Database) =>
    getStmt(
      db,
      `UPDATE dispatch_repos SET maintainer_survey_enabled = ?, maintainer_survey_goal = ?, maintainer_survey_cadence = ?, updated_at = datetime('now') WHERE id = ?`
    ),

  // Stamp the cadence anchor (pass-only — never operator-settable). Intentionally
  // does NOT bump updated_at: this is a machine timestamp, not a config edit, so it
  // mustn't churn the row's mtime. Args: (iso|null, id).
  setMaintainerSurveyRanAt: (db: Database.Database) =>
    getStmt(
      db,
      `UPDATE dispatch_repos SET maintainer_survey_last_at = ? WHERE id = ?`
    ),

  // Dispatch — reviewer gate
  listPrOpen: (db: Database.Database) =>
    getStmt(db, `SELECT * FROM issue_dispatches WHERE status = 'pr_open'`),

  setDispatchReviewer: (db: Database.Database) =>
    getStmt(
      db,
      `UPDATE issue_dispatches SET reviewer_session_id = ?, updated_at = datetime('now') WHERE id = ?`
    ),

  // Cache the panel verdict AND the head SHA it was evaluated against so a later
  // auto-merge can pin to that SHA and refuse if the head moved.
  setDispatchReviewDecision: (db: Database.Database) =>
    getStmt(
      db,
      `UPDATE issue_dispatches SET review_decision = ?, review_sha = ?, updated_at = datetime('now') WHERE id = ?`
    ),

  // Fix loop: start a fix round (record the fixer session, bump the counter).
  startFixRound: (db: Database.Database) =>
    getStmt(
      db,
      `UPDATE issue_dispatches SET fixer_session_id = ?, fix_rounds = fix_rounds + 1, updated_at = datetime('now') WHERE id = ?`
    ),

  // CI-fix loop: start a CI-fix round (record the CI fixer session, bump counter).
  startCiFixRound: (db: Database.Database) =>
    getStmt(
      db,
      `UPDATE issue_dispatches SET ci_fixer_session_id = ?, ci_fix_rounds = ci_fix_rounds + 1, updated_at = datetime('now') WHERE id = ?`
    ),

  // Merge train: start a rebase-repair round (record the rebase fixer, bump counter).
  startRebaseRound: (db: Database.Database) =>
    getStmt(
      db,
      `UPDATE issue_dispatches SET rebase_fixer_session_id = ?, rebase_rounds = rebase_rounds + 1, updated_at = datetime('now') WHERE id = ?`
    ),

  // Merge train: a rebase fixer finished on an UNGATED repo — clear it so the board
  // stops showing "rebasing…" (it's set on spawn and otherwise never cleared).
  clearRebaseFixer: (db: Database.Database) =>
    getStmt(
      db,
      `UPDATE issue_dispatches SET rebase_fixer_session_id = NULL, updated_at = datetime('now') WHERE id = ?`
    ),

  // Merge train: a rebase fixer finished on a GATED repo — clear the fixer AND wipe
  // the cached panel verdict + SHA so a fresh critic re-reviews the REBASED head. A
  // rebase resolution rewrites the diff; it must never auto-merge under the pre-rebase
  // APPROVED (the same "never merge unreviewed code" rule the session ceremony pins).
  resetReviewAfterRebase: (db: Database.Database) =>
    getStmt(
      db,
      `UPDATE issue_dispatches SET reviewer_session_id = NULL, review_decision = NULL, review_sha = NULL, rebase_fixer_session_id = NULL, updated_at = datetime('now') WHERE id = ?`
    ),

  // Merge train: the PR is MERGEABLE again — zero the rebase counter so the cap
  // bounds CONSECUTIVE failed repairs, not a busy PR's lifetime of (each fixed)
  // conflicts. Also clears any lingering fixer id defensively.
  resetRebaseRounds: (db: Database.Database) =>
    getStmt(
      db,
      `UPDATE issue_dispatches SET rebase_rounds = 0, rebase_fixer_session_id = NULL, updated_at = datetime('now') WHERE id = ?`
    ),

  // Verify harness: a verification run is STARTING for this head — record
  // running + pin the SHA up-front (so the UI shows "verifying…" and the per-SHA
  // once-guard holds even across a restart), clearing any prior output.
  setVerifyRunning: (db: Database.Database) =>
    getStmt(
      db,
      `UPDATE issue_dispatches SET verify_status = 'running', verify_sha = ?, verify_output = NULL, updated_at = datetime('now') WHERE id = ?`
    ),

  // Verify harness: a verification run FINISHED — record the verdict, the bounded
  // output tail, and the head SHA it's for (the gating + staleness pin).
  setVerifyResult: (db: Database.Database) =>
    getStmt(
      db,
      `UPDATE issue_dispatches SET verify_status = ?, verify_output = ?, verify_sha = ?, verify_ran_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`
    ),

  // Verify harness: clear ONE row's verdict — the head moved off the verified SHA,
  // so the verdict is stale (the board/inbox must stop showing it; auto-merge/inbox
  // must stop trusting it). The next tick re-verifies the new head.
  clearVerify: (db: Database.Database) =>
    getStmt(
      db,
      `UPDATE issue_dispatches SET verify_status = NULL, verify_output = NULL, verify_sha = NULL, updated_at = datetime('now') WHERE id = ?`
    ),

  // Verify harness: clear a REPO's open dispatches' verdicts — the verify_command
  // changed, so prior verdicts no longer reflect what would run. The next tick
  // re-verifies (recovers a PR stuck on a misconfigured-command 'error').
  clearVerifyForRepo: (db: Database.Database) =>
    getStmt(
      db,
      `UPDATE issue_dispatches SET verify_status = NULL, verify_output = NULL, verify_sha = NULL, updated_at = datetime('now') WHERE repo_id = ? AND status = 'pr_open'`
    ),

  // #26 rubric judge: a judge run is STARTING for this head — record running +
  // pin the SHA up-front (mirrors setVerifyRunning: the once-guard holds across
  // a restart), clearing any prior verdict detail.
  setJudgeRunning: (db: Database.Database) =>
    getStmt(
      db,
      `UPDATE issue_dispatches SET judge_status = 'running', judge_sha = ?, judge_output = NULL, updated_at = datetime('now') WHERE id = ?`
    ),

  // #26 rubric judge: a run FINISHED — the verdict, bounded detail, and the pin.
  setJudgeResult: (db: Database.Database) =>
    getStmt(
      db,
      `UPDATE issue_dispatches SET judge_status = ?, judge_output = ?, judge_sha = ?, judge_ran_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`
    ),

  // #26 rubric judge: the head moved off the judged SHA — clear the stale verdict.
  clearJudge: (db: Database.Database) =>
    getStmt(
      db,
      `UPDATE issue_dispatches SET judge_status = NULL, judge_output = NULL, judge_sha = NULL, updated_at = datetime('now') WHERE id = ?`
    ),

  // Fix loop: a fixer finished — clear reviewer + decision + SHA + fixer so the
  // next tick spawns a fresh critic against the updated PR (re-review).
  resetForReReview: (db: Database.Database) =>
    getStmt(
      db,
      `UPDATE issue_dispatches SET reviewer_session_id = NULL, review_decision = NULL, review_sha = NULL, fixer_session_id = NULL, updated_at = datetime('now') WHERE id = ?`
    ),

  // Retry a failed dispatch: wipe all worker/PR/review state back to a clean
  // 'pending' so dispatchOne can claim + spawn it fresh (new worktree/branch).
  resetDispatchForRetry: (db: Database.Database) =>
    getStmt(
      db,
      // WHERE status='failed' so a double-tap retry only resets once (the second
      // is a no-op; dispatchOne's claimDispatch is still the spawn-once gate).
      `UPDATE issue_dispatches SET status = 'pending', session_id = NULL, branch_name = NULL, worktree_path = NULL, pr_url = NULL, pr_number = NULL, pr_status = NULL, dispatched_at = NULL, reviewer_session_id = NULL, review_decision = NULL, review_sha = NULL, fix_rounds = 0, fixer_session_id = NULL, ci_fix_rounds = 0, ci_fixer_session_id = NULL, rebase_rounds = 0, rebase_fixer_session_id = NULL, verify_status = NULL, verify_output = NULL, verify_sha = NULL, verify_ran_at = NULL, updated_at = datetime('now') WHERE id = ? AND status = 'failed'`
    ),

  // Dispatch — issue pipeline rows
  getDispatchByRepoIssue: (db: Database.Database) =>
    getStmt(
      db,
      `SELECT * FROM issue_dispatches WHERE repo_id = ? AND issue_number = ?`
    ),

  upsertDispatchCandidate: (db: Database.Database) =>
    getStmt(
      db,
      `INSERT OR IGNORE INTO issue_dispatches (id, repo_id, issue_number, issue_title, issue_url, issue_created_at, source, status)
       VALUES (?, ?, ?, ?, ?, ?, 'github', 'pending')`
    ),

  // Webhook-sourced task: source='webhook', issue_number 0 (same partial-index
  // exclusion as local tasks). Args: (id, repo_id, title, body|null, createdAt).
  insertWebhookTask: (db: Database.Database) =>
    getStmt(
      db,
      `INSERT INTO issue_dispatches (id, repo_id, issue_number, issue_title, task_body, issue_created_at, source, status)
       VALUES (?, ?, 0, ?, ?, ?, 'webhook', 'pending')`
    ),

  // Local (GitHub-free) task: source='local', issue_number 0 (excluded from the
  // gh-dedupe partial index so locals never collide), freeform body in task_body.
  // status is 'pending' or 'scheduled'; scheduled_at/recurrence null unless scheduled
  // (recurrence 'hourly'|'daily'|'weekly' makes a scheduled task repeat).
  insertLocalTask: (db: Database.Database) =>
    getStmt(
      db,
      `INSERT INTO issue_dispatches (id, repo_id, issue_number, issue_title, task_body, issue_created_at, scheduled_at, recurrence, source, status)
       VALUES (?, ?, 0, ?, ?, ?, ?, ?, 'local', ?)`
    ),

  // Schedule a candidate for a future time: 'scheduled' until the reconciler
  // promotes it to 'pending' at/after scheduled_at.
  insertScheduledCandidate: (db: Database.Database) =>
    getStmt(
      db,
      `INSERT OR IGNORE INTO issue_dispatches (id, repo_id, issue_number, issue_title, issue_url, issue_created_at, scheduled_at, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'scheduled')`
    ),

  // All rows with status='scheduled' (the reconciler filters due ones in JS) —
  // used by the reconciler promotion + the UI list.
  listScheduled: (db: Database.Database) =>
    getStmt(
      db,
      `SELECT * FROM issue_dispatches WHERE status = 'scheduled' ORDER BY scheduled_at ASC`
    ),

  // Promote a due scheduled row → pending (then normal headroom/mode applies).
  promoteScheduledToPending: (db: Database.Database) =>
    getStmt(
      db,
      `UPDATE issue_dispatches SET status = 'pending', updated_at = datetime('now') WHERE id = ? AND status = 'scheduled'`
    ),

  getDispatch: (db: Database.Database) =>
    getStmt(db, `SELECT * FROM issue_dispatches WHERE id = ?`),

  // Opt-in per-issue auto-merge flag (0/1): the reconciler merges this row's PR
  // once it's ready. Set at creation; toggleable from the board.
  setDispatchAutoMerge: (db: Database.Database) =>
    getStmt(
      db,
      `UPDATE issue_dispatches SET auto_merge = ?, updated_at = datetime('now') WHERE id = ?`
    ),

  // Daily cap: rows DISPATCHED today (calendar day, UTC) for a repo.
  // Daily-cap count. A sargable range on dispatched_at (text 'YYYY-MM-DD HH:MM:SS'
  // in UTC, so it compares correctly against the date strings) instead of wrapping
  // the column in date() — the latter defeats idx_dispatch_dispatched_at and scans
  // the repo's whole history every tick. Excludes 'failed' rows so a transient
  // spawn failure (which leaves dispatched_at set) doesn't burn the day's quota.
  countDispatchesToday: (db: Database.Database) =>
    getStmt(
      db,
      `SELECT COUNT(*) AS n FROM issue_dispatches
       WHERE repo_id = ?
         AND dispatched_at IS NOT NULL
         AND status != 'failed'
         AND dispatched_at >= date('now')
         AND dispatched_at < date('now', '+1 day')`
    ),

  // Concurrency cap: workers still actively coding (status 'dispatched'). Once a
  // worker opens its PR (→ 'pr_open') or finishes/dies, its slot frees — so a
  // completed-but-unmerged PR never pins the cap forever.
  countLiveInFlight: (db: Database.Database) =>
    getStmt(
      db,
      `SELECT COUNT(*) AS n FROM issue_dispatches
       WHERE repo_id = ? AND status = 'dispatched'`
    ),

  listPendingForRepo: (db: Database.Database) =>
    getStmt(
      db,
      `SELECT * FROM issue_dispatches WHERE repo_id = ? AND status = 'pending'
       ORDER BY issue_created_at ASC`
    ),

  // The AUTO-DISPATCH fence: pending rows the auto loop may drain — EXCLUDES
  // maintainer-proposed rows, so a survey proposal is never auto-shipped (it waits
  // for one-tap Approve). The only difference from listPendingForRepo.
  listPendingDispatchableForRepo: (db: Database.Database) =>
    getStmt(
      db,
      `SELECT * FROM issue_dispatches
       WHERE repo_id = ? AND status = 'pending' AND maintainer_proposed = 0
       ORDER BY issue_created_at ASC`
    ),

  // A maintainer-proposed local task: pending, fenced from auto-dispatch. Args:
  // (id, repo_id, issue_title, task_body, issue_created_at).
  insertMaintainerTask: (db: Database.Database) =>
    getStmt(
      db,
      `INSERT INTO issue_dispatches (id, repo_id, issue_number, issue_title, task_body, issue_created_at, source, status, maintainer_proposed)
       VALUES (?, ?, 0, ?, ?, ?, 'local', 'pending', 1)`
    ),

  // Dedup backstop: is there already an OPEN local task with this exact title?
  // Args: (repo_id, title). Catches the exact-title race the agent's semantic dedup
  // can miss. "Open" = in flight or awaiting action; cancelled/merged/failed are
  // deliberately excluded so a dropped, completed, or not-yet-landed task can be
  // re-proposed by a later survey (the operator can dismiss a stale failed row).
  findOpenLocalTaskByTitle: (db: Database.Database) =>
    getStmt(
      db,
      `SELECT 1 FROM issue_dispatches
       WHERE repo_id = ? AND source = 'local' AND issue_title = ?
         AND status IN ('pending','dispatched','pr_open','scheduled') LIMIT 1`
    ),

  // The open-task list fed to the survey so it dedupes semantically. Newest first,
  // capped by the caller. Args: (repo_id, limit).
  listOpenTasksForSurveyDedup: (db: Database.Database) =>
    getStmt(
      db,
      `SELECT issue_title, task_body FROM issue_dispatches
       WHERE repo_id = ? AND status IN ('pending','dispatched','pr_open','scheduled')
       ORDER BY created_at DESC LIMIT ?`
    ),

  // Conflict-aware decomposition: set a row's file-ownership claims (JSON).
  setDispatchClaims: (db: Database.Database) =>
    getStmt(
      db,
      `UPDATE issue_dispatches SET file_claims = ?, updated_at = datetime('now') WHERE id = ?`
    ),

  // Claims held by LIVE work in a repo. INTENTIONALLY broader than countLiveInFlight
  // (which counts only 'dispatched' — agent slots free at pr_open): a worker's
  // worktree holds its claimed files until MERGE, so 'pr_open' rows (incl. mid-fix /
  // mid-rebase) still hold their claims. Conflating these two windows would let two
  // overlapping PRs open and collide at merge — keep them separate.
  listLiveClaims: (db: Database.Database) =>
    getStmt(
      db,
      `SELECT file_claims FROM issue_dispatches
       WHERE repo_id = ? AND status IN ('dispatched', 'pr_open') AND file_claims IS NOT NULL`
    ),

  // Fleet memory: record a blocking critic finding for a repo, de-duped on the exact
  // text (so re-capturing the same finding across fix rounds is a no-op, bounding
  // growth to DISTINCT lessons). Args: (id, repo_id, lens, text, repo_id, text).
  insertLessonIfNew: (db: Database.Database) =>
    getStmt(
      db,
      // OR IGNORE + the UNIQUE(repo_id,text) index (migration 37) make a concurrent
      // insert that races past the NOT EXISTS check a silent no-op, not a duplicate.
      `INSERT OR IGNORE INTO repo_lessons (id, repo_id, lens, text)
       SELECT ?, ?, ?, ?
       WHERE NOT EXISTS (
         SELECT 1 FROM repo_lessons WHERE repo_id = ? AND text = ?
       )`
    ),

  // Fleet memory: the most recent distinct lessons for a repo, to inject into a
  // worker's prompt. Operator-curated MANUAL rules sort first (always injected),
  // then recent auto findings. Args: (repo_id, limit).
  listRecentLessons: (db: Database.Database) =>
    getStmt(
      db,
      `SELECT lens, text FROM repo_lessons
       WHERE repo_id = ?
       ORDER BY (source = 'manual') DESC, created_at DESC, rowid DESC LIMIT ?`
    ),

  // Fleet memory: ALL of a repo's lessons for the visibility view (manual rules
  // first, then newest findings). source distinguishes the two in the UI.
  listLessonsForRepo: (db: Database.Database) =>
    getStmt(
      db,
      `SELECT id, lens, text, source, created_at FROM repo_lessons
       WHERE repo_id = ?
       ORDER BY (source = 'manual') DESC, created_at DESC, rowid DESC`
    ),

  // Fleet memory: forget the auto-captured FINDINGS for a repo (the noise);
  // operator-curated manual rules survive (removed individually via deleteLesson).
  clearLessonsForRepo: (db: Database.Database) =>
    getStmt(
      db,
      `DELETE FROM repo_lessons WHERE repo_id = ? AND source = 'auto'`
    ),

  // Fleet memory: forget ONE lesson (e.g. a stale or wrong finding). Scoped to the
  // repo too, so a lesson id can't be deleted out from under another repo's URL.
  deleteLesson: (db: Database.Database) =>
    getStmt(db, `DELETE FROM repo_lessons WHERE id = ? AND repo_id = ?`),

  // Fleet memory: an operator-curated MANUAL rule, inserted only if the text isn't
  // already a lesson (NOT EXISTS guard — idempotent under concurrent "remember").
  // Args: (id, repo_id, lens, text, repo_id, text).
  insertManualLesson: (db: Database.Database) =>
    getStmt(
      db,
      // OR IGNORE backstops the non-atomic NOT EXISTS against the UNIQUE index.
      `INSERT OR IGNORE INTO repo_lessons (id, repo_id, lens, text, source)
       SELECT ?, ?, ?, ?, 'manual'
       WHERE NOT EXISTS (
         SELECT 1 FROM repo_lessons WHERE repo_id = ? AND text = ?
       )`
    ),

  // Fleet memory: PROMOTE an existing lesson (same text) to manual so it survives
  // "forget findings" — used when curating a fact that the critic already found.
  // Args: (repo_id, text). changes===0 ⇒ no existing row, caller inserts fresh.
  markLessonManual: (db: Database.Database) =>
    getStmt(
      db,
      `UPDATE repo_lessons SET source = 'manual' WHERE repo_id = ? AND text = ?`
    ),

  listDispatchesForRepo: (db: Database.Database) =>
    getStmt(
      db,
      `SELECT * FROM issue_dispatches WHERE repo_id = ? ORDER BY created_at DESC`
    ),

  listAllPending: (db: Database.Database) =>
    getStmt(
      db,
      `SELECT * FROM issue_dispatches WHERE status = 'pending' ORDER BY issue_created_at ASC`
    ),

  listDispatchesForBoard: (db: Database.Database) =>
    getStmt(
      db,
      `SELECT * FROM issue_dispatches
       WHERE status IN ('dispatched', 'pr_open', 'merged', 'failed')
       ORDER BY dispatched_at DESC`
    ),

  // Workers still 'dispatched' (actively coding) — the sweep re-checks each:
  // PR opened → pr_open; session gone without a PR → failed.
  listDispatched: (db: Database.Database) =>
    getStmt(db, `SELECT * FROM issue_dispatches WHERE status = 'dispatched'`),

  // Atomically claim a pending candidate → dispatched. The WHERE status='pending'
  // makes concurrent dispatchers safe (a reconcile tick racing a manual approve,
  // or two rapid approves): exactly one .run() reports changes===1, the rest get 0
  // and bail — an issue is never double-spawned. dispatched_at counts it toward the
  // daily cap immediately (a failed attempt still consumes its slot — no retry storm).
  claimDispatch: (db: Database.Database) =>
    getStmt(
      db,
      `UPDATE issue_dispatches SET status = 'dispatched', dispatched_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND status = 'pending'`
    ),

  // Fill in the worker's session/branch/worktree after the claim+spawn (status is
  // already 'dispatched' from the claim).
  setDispatchSession: (db: Database.Database) =>
    getStmt(
      db,
      `UPDATE issue_dispatches SET session_id = ?, branch_name = ?, worktree_path = ?, updated_at = datetime('now') WHERE id = ?`
    ),

  // Record the worker's PR + set the terminal status (caller passes 'pr_open' or
  // 'merged' so a merged PR isn't mislabeled).
  updateDispatchPR: (db: Database.Database) =>
    getStmt(
      db,
      `UPDATE issue_dispatches SET pr_url = ?, pr_number = ?, pr_status = ?, status = ?, updated_at = datetime('now') WHERE id = ?`
    ),

  updateDispatchStatus: (db: Database.Database) =>
    getStmt(
      db,
      `UPDATE issue_dispatches SET status = ?, updated_at = datetime('now') WHERE id = ?`
    ),

  // Stale reconcile: resolve a stuck open-PR row to a terminal status (merged from
  // an out-of-band merge, cancelled from an out-of-band close) — but ONLY while it's
  // still 'pr_open'. The guard makes it idempotent and race-safe: a concurrent
  // auto-merge/sweep (or a second reconcile tap) that already moved the row wins,
  // and this is a no-op (changes===0) rather than clobbering the newer status.
  resolveStaleDispatch: (db: Database.Database) =>
    getStmt(
      db,
      `UPDATE issue_dispatches SET status = ?, updated_at = datetime('now') WHERE id = ? AND status = 'pr_open'`
    ),

  // ── Session ceremonies ("go to auto") — mirror the dispatch review/CI fields so
  // the reconciler drives them with the same pure decision functions. ──
  createSessionCeremony: (db: Database.Database) =>
    getStmt(
      db,
      // OR IGNORE: re-tapping "go to auto" on an already-enrolled session is a no-op
      // (session_id is UNIQUE) rather than an error. auto_merge is opt-in (0/1).
      `INSERT OR IGNORE INTO session_ceremonies (id, session_id, seed_prompt, auto_merge) VALUES (?, ?, ?, ?)`
    ),

  getSessionCeremony: (db: Database.Database) =>
    getStmt(db, `SELECT * FROM session_ceremonies WHERE session_id = ?`),

  // Active ceremonies the reconciler drives ('merged'/'stuck' are terminal).
  listActiveCeremonies: (db: Database.Database) =>
    getStmt(
      db,
      `SELECT * FROM session_ceremonies WHERE step NOT IN ('merged', 'stuck')`
    ),

  // Ceremonies for the Verdict Inbox: everything not yet merged — INCLUDING
  // 'stuck', the row that most needs a human (the reconciler gave up on it).
  listCeremoniesForReview: (db: Database.Database) =>
    getStmt(db, `SELECT * FROM session_ceremonies WHERE step != 'merged'`),

  setCeremonyReviewDecision: (db: Database.Database) =>
    getStmt(
      db,
      `UPDATE session_ceremonies SET review_decision = ?, updated_at = datetime('now') WHERE id = ?`
    ),

  // Pin the panel to the reviewer session + the SHA it's reviewing, set at panel
  // SPAWN (run together). Panelists stamp this SHA in their markers; the merge is
  // --match-head-commit-pinned to it; a moved head → re-review.
  setCeremonyReview: (db: Database.Database) =>
    getStmt(
      db,
      `UPDATE session_ceremonies SET reviewer_session_id = ?, review_sha = ?, updated_at = datetime('now') WHERE id = ?`
    ),

  startCeremonyFixRound: (db: Database.Database) =>
    getStmt(
      db,
      `UPDATE session_ceremonies SET fixer_session_id = ?, fix_rounds = fix_rounds + 1, updated_at = datetime('now') WHERE id = ?`
    ),

  startCeremonyCiFixRound: (db: Database.Database) =>
    getStmt(
      db,
      `UPDATE session_ceremonies SET ci_fixer_session_id = ?, ci_fix_rounds = ci_fix_rounds + 1, updated_at = datetime('now') WHERE id = ?`
    ),

  // A fixer finished → clear reviewer + decision + fixer so the next tick spawns a
  // fresh critic against the updated PR (re-review). Mirrors resetForReReview.
  resetCeremonyForReReview: (db: Database.Database) =>
    getStmt(
      db,
      // Clears review_sha too so a fresh panel must re-review the new commits (its
      // round is re-seeded above existing markers at the next spawn).
      `UPDATE session_ceremonies SET reviewer_session_id = NULL, review_decision = NULL, review_sha = NULL, fixer_session_id = NULL, updated_at = datetime('now') WHERE id = ?`
    ),

  updateCeremonyPR: (db: Database.Database) =>
    getStmt(
      db,
      `UPDATE session_ceremonies SET pr_url = ?, pr_number = ?, updated_at = datetime('now') WHERE id = ?`
    ),

  setCeremonyStep: (db: Database.Database) =>
    getStmt(
      db,
      `UPDATE session_ceremonies SET step = ?, updated_at = datetime('now') WHERE id = ?`
    ),

  deleteSessionCeremony: (db: Database.Database) =>
    getStmt(db, `DELETE FROM session_ceremonies WHERE session_id = ?`),

  // ── Warm worktree pool ── (feeds the dispatcher: pre-warmed worktrees a
  // dispatch can claim without a cold clone; lives with dispatch, not analytics).
  insertWarmWorktree: (db: Database.Database) =>
    getStmt(
      db,
      `INSERT INTO warm_worktrees (id, repo_id, worktree_path, branch_name, status)
       VALUES (?, ?, ?, ?, 'warming')`
    ),

  markWarmWorktreeReady: (db: Database.Database) =>
    getStmt(
      db,
      `UPDATE warm_worktrees SET status = 'ready' WHERE id = ? AND status = 'warming'`
    ),

  // Atomically claim the oldest ready warm worktree for a repo. Returns the row or
  // undefined (no ready entry). The DELETE is intentional: claimed worktrees are
  // consumed and removed from the pool — the dispatcher owns the path from here.
  claimWarmWorktree: (db: Database.Database) =>
    getStmt(
      db,
      `DELETE FROM warm_worktrees
       WHERE id = (
         SELECT id FROM warm_worktrees
         WHERE repo_id = ? AND status = 'ready'
         ORDER BY created_at ASC
         LIMIT 1
       )
       RETURNING id, worktree_path, branch_name`
    ),

  countWarmWorktrees: (db: Database.Database) =>
    getStmt(db, `SELECT COUNT(*) as n FROM warm_worktrees WHERE repo_id = ?`),

  deleteWarmWorktree: (db: Database.Database) =>
    getStmt(db, `DELETE FROM warm_worktrees WHERE id = ?`),

  // Returns all 'warming' rows — used at startup to evict entries that were left
  // mid-creation by a crash (their worktrees are partially set up and unusable).
  listWarmingWorktrees: (db: Database.Database) =>
    getStmt(
      db,
      `SELECT id, worktree_path FROM warm_worktrees WHERE status = 'warming'`
    ),

  listReadyWarmWorktreesForRepo: (db: Database.Database) =>
    getStmt(
      db,
      `SELECT id, worktree_path FROM warm_worktrees WHERE repo_id = ? AND status IN ('warming','ready')`
    ),

  // Like listWarmingWorktrees but also returns the source repo_path (via JOIN)
  // so evictStale can pass the correct projectPath to deleteWorktree.
  listStaleWarmWorktreesWithRepo: (db: Database.Database) =>
    getStmt(
      db,
      `SELECT ww.id, ww.worktree_path, dr.repo_path
       FROM warm_worktrees ww
       LEFT JOIN dispatch_repos dr ON ww.repo_id = dr.id
       WHERE ww.status = 'warming'`
    ),

  getDispatchRepoBySlug: (db: Database.Database) =>
    getStmt(db, `SELECT * FROM dispatch_repos WHERE repo_slug = ?`),
};
