import type Database from "better-sqlite3";

// Prepared statement cache
const stmtCache = new Map<string, Database.Statement>();

function getStmt(db: Database.Database, sql: string): Database.Statement {
  const key = sql;
  let stmt = stmtCache.get(key);
  if (!stmt) {
    stmt = db.prepare(sql);
    stmtCache.set(key, stmt);
  }
  return stmt;
}

export const queries = {
  // Sessions
  createSession: (db: Database.Database) =>
    getStmt(
      db,
      `INSERT INTO sessions (id, name, tmux_name, working_directory, parent_session_id, model, system_prompt, group_path, agent_type, auto_approve, project_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ),

  getSession: (db: Database.Database) =>
    getStmt(db, `SELECT * FROM sessions WHERE id = ?`),

  getAllSessions: (db: Database.Database) =>
    getStmt(db, `SELECT * FROM sessions ORDER BY updated_at DESC`),

  updateSessionStatus: (db: Database.Database) =>
    getStmt(
      db,
      `UPDATE sessions SET status = ?, updated_at = datetime('now') WHERE id = ?`
    ),

  updateSessionClaudeId: (db: Database.Database) =>
    getStmt(
      db,
      `UPDATE sessions SET claude_session_id = ?, updated_at = datetime('now') WHERE id = ?`
    ),

  updateSessionName: (db: Database.Database) =>
    getStmt(
      db,
      `UPDATE sessions SET name = ?, tmux_name = ?, updated_at = datetime('now') WHERE id = ?`
    ),

  deleteSession: (db: Database.Database) =>
    getStmt(db, `DELETE FROM sessions WHERE id = ?`),

  updateSessionWorktree: (db: Database.Database) =>
    getStmt(
      db,
      `UPDATE sessions SET worktree_path = ?, branch_name = ?, base_branch = ?, dev_server_port = ?, updated_at = datetime('now') WHERE id = ?`
    ),

  updateSessionMcpArgs: (db: Database.Database) =>
    getStmt(
      db,
      `UPDATE sessions SET mcp_launch_args = ?, updated_at = datetime('now') WHERE id = ?`
    ),

  updateSessionPR: (db: Database.Database) =>
    getStmt(
      db,
      `UPDATE sessions SET pr_url = ?, pr_number = ?, pr_status = ?, updated_at = datetime('now') WHERE id = ?`
    ),

  updateSessionGroup: (db: Database.Database) =>
    getStmt(
      db,
      `UPDATE sessions SET group_path = ?, updated_at = datetime('now') WHERE id = ?`
    ),

  getSessionsByGroup: (db: Database.Database) =>
    getStmt(
      db,
      `SELECT * FROM sessions WHERE group_path = ? ORDER BY updated_at DESC`
    ),

  moveSessionsToGroup: (db: Database.Database) =>
    getStmt(
      db,
      `UPDATE sessions SET group_path = ?, updated_at = datetime('now') WHERE group_path = ?`
    ),

  updateSessionProject: (db: Database.Database) =>
    getStmt(
      db,
      `UPDATE sessions SET project_id = ?, updated_at = datetime('now') WHERE id = ?`
    ),

  getSessionsByProject: (db: Database.Database) =>
    getStmt(
      db,
      `SELECT * FROM sessions WHERE project_id = ? ORDER BY updated_at DESC`
    ),

  // Orchestration
  getWorkersByConductor: (db: Database.Database) =>
    getStmt(
      db,
      `SELECT * FROM sessions WHERE conductor_session_id = ? ORDER BY created_at ASC`
    ),

  updateWorkerStatus: (db: Database.Database) =>
    getStmt(
      db,
      `UPDATE sessions SET worker_status = ?, updated_at = datetime('now') WHERE id = ?`
    ),

  createWorkerSession: (db: Database.Database) =>
    getStmt(
      db,
      `INSERT INTO sessions (id, name, tmux_name, working_directory, conductor_session_id, worker_task, worker_status, model, group_path, agent_type, project_id)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`
    ),

  // Messages
  createMessage: (db: Database.Database) =>
    getStmt(
      db,
      `INSERT INTO messages (session_id, role, content, duration_ms)
       VALUES (?, ?, ?, ?)`
    ),

  getSessionMessages: (db: Database.Database) =>
    getStmt(
      db,
      `SELECT * FROM messages WHERE session_id = ? ORDER BY timestamp ASC`
    ),

  getLastMessage: (db: Database.Database) =>
    getStmt(
      db,
      `SELECT * FROM messages WHERE session_id = ? ORDER BY timestamp DESC LIMIT 1`
    ),

  updateMessageDuration: (db: Database.Database) =>
    getStmt(db, `UPDATE messages SET duration_ms = ? WHERE id = ?`),

  // Tool calls
  createToolCall: (db: Database.Database) =>
    getStmt(
      db,
      `INSERT INTO tool_calls (message_id, session_id, tool_name, tool_input, status)
       VALUES (?, ?, ?, ?, 'pending')`
    ),

  updateToolCallResult: (db: Database.Database) =>
    getStmt(
      db,
      `UPDATE tool_calls SET tool_result = ?, status = ? WHERE id = ?`
    ),

  updateToolCallStatus: (db: Database.Database) =>
    getStmt(db, `UPDATE tool_calls SET status = ? WHERE id = ?`),

  getSessionToolCalls: (db: Database.Database) =>
    getStmt(
      db,
      `SELECT * FROM tool_calls WHERE session_id = ? ORDER BY timestamp ASC`
    ),

  getMessageToolCalls: (db: Database.Database) =>
    getStmt(
      db,
      `SELECT * FROM tool_calls WHERE message_id = ? ORDER BY timestamp ASC`
    ),

  // Groups
  getAllGroups: (db: Database.Database) =>
    getStmt(db, `SELECT * FROM groups ORDER BY sort_order ASC, name ASC`),

  getGroup: (db: Database.Database) =>
    getStmt(db, `SELECT * FROM groups WHERE path = ?`),

  createGroup: (db: Database.Database) =>
    getStmt(db, `INSERT INTO groups (path, name, sort_order) VALUES (?, ?, ?)`),

  updateGroupName: (db: Database.Database) =>
    getStmt(db, `UPDATE groups SET name = ? WHERE path = ?`),

  updateGroupExpanded: (db: Database.Database) =>
    getStmt(db, `UPDATE groups SET expanded = ? WHERE path = ?`),

  updateGroupOrder: (db: Database.Database) =>
    getStmt(db, `UPDATE groups SET sort_order = ? WHERE path = ?`),

  deleteGroup: (db: Database.Database) =>
    getStmt(db, `DELETE FROM groups WHERE path = ?`),

  // Projects
  createProject: (db: Database.Database) =>
    getStmt(
      db,
      `INSERT INTO projects (id, name, working_directory, agent_type, default_model, initial_prompt, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ),

  getProject: (db: Database.Database) =>
    getStmt(db, `SELECT * FROM projects WHERE id = ?`),

  getAllProjects: (db: Database.Database) =>
    getStmt(
      db,
      `SELECT * FROM projects ORDER BY is_uncategorized ASC, sort_order ASC, name ASC`
    ),

  updateProject: (db: Database.Database) =>
    getStmt(
      db,
      `UPDATE projects SET name = ?, working_directory = ?, agent_type = ?, default_model = ?, initial_prompt = ?, updated_at = datetime('now') WHERE id = ?`
    ),

  updateProjectExpanded: (db: Database.Database) =>
    getStmt(db, `UPDATE projects SET expanded = ? WHERE id = ?`),

  updateProjectOrder: (db: Database.Database) =>
    getStmt(db, `UPDATE projects SET sort_order = ? WHERE id = ?`),

  deleteProject: (db: Database.Database) =>
    getStmt(db, `DELETE FROM projects WHERE id = ? AND is_uncategorized = 0`),

  // Project dev servers
  createProjectDevServer: (db: Database.Database) =>
    getStmt(
      db,
      `INSERT INTO project_dev_servers (id, project_id, name, type, command, port, port_env_var, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ),

  getProjectDevServer: (db: Database.Database) =>
    getStmt(db, `SELECT * FROM project_dev_servers WHERE id = ?`),

  getProjectDevServers: (db: Database.Database) =>
    getStmt(
      db,
      `SELECT * FROM project_dev_servers WHERE project_id = ? ORDER BY sort_order ASC`
    ),

  updateProjectDevServer: (db: Database.Database) =>
    getStmt(
      db,
      `UPDATE project_dev_servers SET name = ?, type = ?, command = ?, port = ?, port_env_var = ?, sort_order = ? WHERE id = ?`
    ),

  deleteProjectDevServer: (db: Database.Database) =>
    getStmt(db, `DELETE FROM project_dev_servers WHERE id = ?`),

  deleteProjectDevServers: (db: Database.Database) =>
    getStmt(db, `DELETE FROM project_dev_servers WHERE project_id = ?`),

  // Project repositories
  createProjectRepository: (db: Database.Database) =>
    getStmt(
      db,
      `INSERT INTO project_repositories (id, project_id, name, path, is_primary, sort_order)
       VALUES (?, ?, ?, ?, ?, ?)`
    ),

  getProjectRepository: (db: Database.Database) =>
    getStmt(db, `SELECT * FROM project_repositories WHERE id = ?`),

  getProjectRepositories: (db: Database.Database) =>
    getStmt(
      db,
      `SELECT * FROM project_repositories WHERE project_id = ? ORDER BY sort_order ASC`
    ),

  updateProjectRepository: (db: Database.Database) =>
    getStmt(
      db,
      `UPDATE project_repositories SET name = ?, path = ?, is_primary = ?, sort_order = ? WHERE id = ?`
    ),

  deleteProjectRepository: (db: Database.Database) =>
    getStmt(db, `DELETE FROM project_repositories WHERE id = ?`),

  deleteProjectRepositories: (db: Database.Database) =>
    getStmt(db, `DELETE FROM project_repositories WHERE project_id = ?`),

  // Dev servers
  createDevServer: (db: Database.Database) =>
    getStmt(
      db,
      `INSERT INTO dev_servers (id, project_id, type, name, command, status, pid, container_id, ports, working_directory)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ),

  getDevServer: (db: Database.Database) =>
    getStmt(db, `SELECT * FROM dev_servers WHERE id = ?`),

  getAllDevServers: (db: Database.Database) =>
    getStmt(db, `SELECT * FROM dev_servers ORDER BY created_at DESC`),

  getDevServersByProject: (db: Database.Database) =>
    getStmt(
      db,
      `SELECT * FROM dev_servers WHERE project_id = ? ORDER BY created_at DESC`
    ),

  updateDevServerStatus: (db: Database.Database) =>
    getStmt(
      db,
      `UPDATE dev_servers SET status = ?, updated_at = datetime('now') WHERE id = ?`
    ),

  updateDevServerPid: (db: Database.Database) =>
    getStmt(
      db,
      `UPDATE dev_servers SET pid = ?, status = ?, updated_at = datetime('now') WHERE id = ?`
    ),

  updateDevServer: (db: Database.Database) =>
    getStmt(
      db,
      `UPDATE dev_servers SET status = ?, pid = ?, container_id = ?, ports = ?, updated_at = datetime('now') WHERE id = ?`
    ),

  deleteDevServer: (db: Database.Database) =>
    getStmt(db, `DELETE FROM dev_servers WHERE id = ?`),

  deleteDevServersByProject: (db: Database.Database) =>
    getStmt(db, `DELETE FROM dev_servers WHERE project_id = ?`),

  // Web Push subscriptions (closed-tab notifications)
  upsertPushSubscription: (db: Database.Database) =>
    getStmt(
      db,
      `INSERT INTO push_subscriptions (endpoint, p256dh, auth) VALUES (?, ?, ?)
       ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth`
    ),

  deletePushSubscription: (db: Database.Database) =>
    getStmt(db, `DELETE FROM push_subscriptions WHERE endpoint = ?`),

  getAllPushSubscriptions: (db: Database.Database) =>
    getStmt(db, `SELECT endpoint, p256dh, auth FROM push_subscriptions`),

  countPushSubscriptions: (db: Database.Database) =>
    getStmt(db, `SELECT COUNT(*) AS n FROM push_subscriptions`),

  // Dispatch — tracked repos (the allocation console rows)
  createDispatchRepo: (db: Database.Database) =>
    getStmt(
      db,
      `INSERT INTO dispatch_repos (id, repo_path, repo_slug, agent_type, daily_quota, max_concurrency, label_filter, base_branch, mode, enabled, review_gate, ci_autofix, project_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
      `UPDATE dispatch_repos SET agent_type = ?, daily_quota = ?, max_concurrency = ?, label_filter = ?, base_branch = ?, mode = ?, enabled = ?, review_gate = ?, ci_autofix = ?, updated_at = datetime('now') WHERE id = ?`
    ),

  deleteDispatchRepo: (db: Database.Database) =>
    getStmt(db, `DELETE FROM dispatch_repos WHERE id = ?`),

  // Dispatch — reviewer gate
  listPrOpen: (db: Database.Database) =>
    getStmt(db, `SELECT * FROM issue_dispatches WHERE status = 'pr_open'`),

  setDispatchReviewer: (db: Database.Database) =>
    getStmt(
      db,
      `UPDATE issue_dispatches SET reviewer_session_id = ?, updated_at = datetime('now') WHERE id = ?`
    ),

  setDispatchReviewDecision: (db: Database.Database) =>
    getStmt(
      db,
      `UPDATE issue_dispatches SET review_decision = ?, updated_at = datetime('now') WHERE id = ?`
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

  // Fix loop: a fixer finished — clear reviewer + decision + fixer so the next
  // tick spawns a fresh critic against the updated PR (re-review).
  resetForReReview: (db: Database.Database) =>
    getStmt(
      db,
      `UPDATE issue_dispatches SET reviewer_session_id = NULL, review_decision = NULL, fixer_session_id = NULL, updated_at = datetime('now') WHERE id = ?`
    ),

  // Retry a failed dispatch: wipe all worker/PR/review state back to a clean
  // 'pending' so dispatchOne can claim + spawn it fresh (new worktree/branch).
  resetDispatchForRetry: (db: Database.Database) =>
    getStmt(
      db,
      // WHERE status='failed' so a double-tap retry only resets once (the second
      // is a no-op; dispatchOne's claimDispatch is still the spawn-once gate).
      `UPDATE issue_dispatches SET status = 'pending', session_id = NULL, branch_name = NULL, worktree_path = NULL, pr_url = NULL, pr_number = NULL, pr_status = NULL, dispatched_at = NULL, reviewer_session_id = NULL, review_decision = NULL, fix_rounds = 0, fixer_session_id = NULL, ci_fix_rounds = 0, ci_fixer_session_id = NULL, updated_at = datetime('now') WHERE id = ? AND status = 'failed'`
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
      `INSERT OR IGNORE INTO issue_dispatches (id, repo_id, issue_number, issue_title, issue_url, issue_created_at, status)
       VALUES (?, ?, ?, ?, ?, ?, 'pending')`
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
  countDispatchesToday: (db: Database.Database) =>
    getStmt(
      db,
      `SELECT COUNT(*) AS n FROM issue_dispatches
       WHERE repo_id = ? AND dispatched_at IS NOT NULL AND date(dispatched_at) = date('now')`
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

  setCeremonyReviewDecision: (db: Database.Database) =>
    getStmt(
      db,
      `UPDATE session_ceremonies SET review_decision = ?, updated_at = datetime('now') WHERE id = ?`
    ),

  // Pin the panel to the SHA it's reviewing + its generation round, set at panel
  // SPAWN (run together). The merge re-reviews if the live head moved off review_sha;
  // review_round is seeded above any existing marker so stale markers never count.
  setCeremonyReview: (db: Database.Database) =>
    getStmt(
      db,
      `UPDATE session_ceremonies SET reviewer_session_id = ?, review_sha = ?, review_round = ?, updated_at = datetime('now') WHERE id = ?`
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

  // Audit / event ledger (append-only)
  appendSessionEvent: (db: Database.Database) =>
    getStmt(
      db,
      `INSERT INTO session_events (session_key, event_type, payload, created_at)
       VALUES (?, ?, ?, ?)`
    ),

  getSessionEvents: (db: Database.Database) =>
    getStmt(
      db,
      `SELECT * FROM session_events WHERE session_key = ? ORDER BY id ASC`
    ),

  // Window-bounded event read for analytics — projects only the columns the
  // engine reads (NOT payload, which can hold large input/paste bodies) and
  // orders by created_at so the idx_session_events_created range scan is used
  // directly. Keeps a busy 90-day window from materializing MBs of payload text.
  getSessionEventsSince: (db: Database.Database) =>
    getStmt(
      db,
      `SELECT session_key, event_type, created_at FROM session_events
       WHERE created_at >= ? ORDER BY created_at ASC, id ASC`
    ),

  getSessionEventsByType: (db: Database.Database) =>
    getStmt(
      db,
      `SELECT * FROM session_events WHERE session_key = ? AND event_type = ? ORDER BY id ASC`
    ),

  countSessionEvents: (db: Database.Database) =>
    getStmt(
      db,
      `SELECT COUNT(*) AS n FROM session_events WHERE session_key = ?`
    ),
};
