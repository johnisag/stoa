import type Database from "better-sqlite3";

interface Migration {
  id: number;
  name: string;
  up: (db: Database.Database) => void;
}

function hasColumn(
  db: Database.Database,
  table: string,
  column: string
): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as {
    name: string;
  }[];
  return cols.some((c) => c.name === column);
}

function hasTable(db: Database.Database, table: string): boolean {
  const rows = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`)
    .all(table) as { name: string }[];
  return rows.length > 0;
}

// All migrations in order. Migrations are idempotent (guarded by PRAGMA table_info
// / IF NOT EXISTS) so a fresh schema or a concurrent-init race never throws a
// duplicate-column/already-exists error. The runner no longer swallows those
// errors, so every migration must be self-guarding.
const migrations: Migration[] = [
  {
    id: 1,
    name: "add_group_path_to_sessions",
    up: (db) => {
      if (!hasColumn(db, "sessions", "group_path")) {
        db.exec(
          `ALTER TABLE sessions ADD COLUMN group_path TEXT NOT NULL DEFAULT 'sessions'`
        );
      }
    },
  },
  {
    id: 2,
    name: "add_agent_type_to_sessions",
    up: (db) => {
      if (!hasColumn(db, "sessions", "agent_type")) {
        db.exec(
          `ALTER TABLE sessions ADD COLUMN agent_type TEXT NOT NULL DEFAULT 'claude'`
        );
      }
    },
  },
  {
    id: 3,
    name: "add_worktree_columns_to_sessions",
    up: (db) => {
      if (!hasColumn(db, "sessions", "worktree_path")) {
        db.exec(`ALTER TABLE sessions ADD COLUMN worktree_path TEXT`);
      }
      if (!hasColumn(db, "sessions", "branch_name")) {
        db.exec(`ALTER TABLE sessions ADD COLUMN branch_name TEXT`);
      }
      if (!hasColumn(db, "sessions", "base_branch")) {
        db.exec(`ALTER TABLE sessions ADD COLUMN base_branch TEXT`);
      }
      if (!hasColumn(db, "sessions", "dev_server_port")) {
        db.exec(`ALTER TABLE sessions ADD COLUMN dev_server_port INTEGER`);
      }
    },
  },
  {
    id: 4,
    name: "add_pr_tracking_to_sessions",
    up: (db) => {
      if (!hasColumn(db, "sessions", "pr_url")) {
        db.exec(`ALTER TABLE sessions ADD COLUMN pr_url TEXT`);
      }
      if (!hasColumn(db, "sessions", "pr_number")) {
        db.exec(`ALTER TABLE sessions ADD COLUMN pr_number INTEGER`);
      }
      if (!hasColumn(db, "sessions", "pr_status")) {
        db.exec(`ALTER TABLE sessions ADD COLUMN pr_status TEXT`);
      }
    },
  },
  {
    id: 5,
    name: "add_group_path_index",
    up: (db) => {
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_sessions_group ON sessions(group_path)`
      );
    },
  },
  {
    id: 6,
    name: "add_orchestration_columns_to_sessions",
    up: (db) => {
      if (!hasColumn(db, "sessions", "conductor_session_id")) {
        db.exec(
          `ALTER TABLE sessions ADD COLUMN conductor_session_id TEXT REFERENCES sessions(id)`
        );
      }
      if (!hasColumn(db, "sessions", "worker_task")) {
        db.exec(`ALTER TABLE sessions ADD COLUMN worker_task TEXT`);
      }
      if (!hasColumn(db, "sessions", "worker_status")) {
        db.exec(`ALTER TABLE sessions ADD COLUMN worker_status TEXT`);
      }
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_sessions_conductor ON sessions(conductor_session_id)`
      );
    },
  },
  {
    id: 7,
    name: "add_auto_approve_to_sessions",
    up: (db) => {
      if (!hasColumn(db, "sessions", "auto_approve")) {
        db.exec(
          `ALTER TABLE sessions ADD COLUMN auto_approve INTEGER NOT NULL DEFAULT 0`
        );
      }
    },
  },
  {
    id: 8,
    name: "add_dev_server_columns",
    up: (db) => {
      if (!hasColumn(db, "dev_servers", "type")) {
        db.exec(
          `ALTER TABLE dev_servers ADD COLUMN type TEXT NOT NULL DEFAULT 'node'`
        );
      }
      if (!hasColumn(db, "dev_servers", "name")) {
        db.exec(
          `ALTER TABLE dev_servers ADD COLUMN name TEXT NOT NULL DEFAULT ''`
        );
      }
      if (!hasColumn(db, "dev_servers", "command")) {
        db.exec(
          `ALTER TABLE dev_servers ADD COLUMN command TEXT NOT NULL DEFAULT ''`
        );
      }
      if (!hasColumn(db, "dev_servers", "pid")) {
        db.exec(`ALTER TABLE dev_servers ADD COLUMN pid INTEGER`);
      }
      if (!hasColumn(db, "dev_servers", "working_directory")) {
        db.exec(
          `ALTER TABLE dev_servers ADD COLUMN working_directory TEXT NOT NULL DEFAULT ''`
        );
      }
    },
  },
  {
    id: 9,
    name: "add_project_id_to_sessions",
    up: (db) => {
      if (!hasColumn(db, "sessions", "project_id")) {
        db.exec(
          `ALTER TABLE sessions ADD COLUMN project_id TEXT REFERENCES projects(id)`
        );
      }
      db.exec(
        `UPDATE sessions SET project_id = 'uncategorized' WHERE project_id IS NULL`
      );
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id)`
      );
    },
  },
  {
    id: 10,
    name: "add_project_id_to_dev_servers",
    up: (db) => {
      const projectIdExists = hasColumn(db, "dev_servers", "project_id");
      if (!projectIdExists) {
        db.exec(
          `ALTER TABLE dev_servers ADD COLUMN project_id TEXT REFERENCES projects(id)`
        );
      }
      // Migrate from session_id if it exists
      const hasSessionId = hasColumn(db, "dev_servers", "session_id");
      if (hasSessionId) {
        db.exec(`
          UPDATE dev_servers
          SET project_id = (
            SELECT COALESCE(s.project_id, 'uncategorized')
            FROM sessions s
            WHERE s.id = dev_servers.session_id
          )
          WHERE project_id IS NULL
        `);
      }
      db.exec(
        `UPDATE dev_servers SET project_id = 'uncategorized' WHERE project_id IS NULL`
      );
      // Always ensure the index exists, even when the column was already present
      // (fresh schemas created it, but the index may be missing on some DBs).
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_dev_servers_project ON dev_servers(project_id)`
      );
    },
  },
  {
    id: 11,
    name: "add_tmux_name_to_sessions",
    up: (db) => {
      if (!hasColumn(db, "sessions", "tmux_name")) {
        db.exec(`ALTER TABLE sessions ADD COLUMN tmux_name TEXT`);
      }
      // Backfill existing sessions with computed tmux name
      db.exec(
        `UPDATE sessions SET tmux_name = agent_type || '-' || id WHERE tmux_name IS NULL`
      );
    },
  },
  {
    id: 12,
    name: "add_initial_prompt_to_projects",
    up: (db) => {
      if (!hasColumn(db, "projects", "initial_prompt")) {
        db.exec(`ALTER TABLE projects ADD COLUMN initial_prompt TEXT`);
      }
    },
  },
  {
    id: 13,
    name: "add_project_repositories_table",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS project_repositories (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          name TEXT NOT NULL,
          path TEXT NOT NULL,
          is_primary INTEGER NOT NULL DEFAULT 0,
          sort_order INTEGER NOT NULL DEFAULT 0,
          FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
        )
      `);
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_project_repositories_project ON project_repositories(project_id)`
      );
    },
  },
  {
    id: 14,
    name: "add_mcp_launch_args_to_sessions",
    up: (db) => {
      // Conductor wiring for providers with no on-disk config (e.g. Codex's
      // `-c mcp_servers.stoa.*`): a JSON array of extra argv tokens replayed at
      // every spawn. NULL for non-conductors and file-configured providers.
      if (!hasColumn(db, "sessions", "mcp_launch_args")) {
        db.exec(`ALTER TABLE sessions ADD COLUMN mcp_launch_args TEXT`);
      }
    },
  },
  {
    id: 15,
    name: "add_push_subscriptions_table",
    up: (db) => {
      // Web Push subscriptions (closed-tab notifications). Keyed by endpoint so
      // a re-subscribe upserts rather than duplicating.
      db.exec(`
        CREATE TABLE IF NOT EXISTS push_subscriptions (
          endpoint TEXT PRIMARY KEY,
          p256dh TEXT NOT NULL,
          auth TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `);
    },
  },
  {
    id: 16,
    name: "add_dispatch_tables",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS dispatch_repos (
          id TEXT PRIMARY KEY,
          repo_path TEXT NOT NULL,
          repo_slug TEXT NOT NULL,
          agent_type TEXT NOT NULL DEFAULT 'claude',
          daily_quota INTEGER NOT NULL DEFAULT 0,
          max_concurrency INTEGER NOT NULL DEFAULT 1,
          label_filter TEXT,
          base_branch TEXT NOT NULL DEFAULT 'main',
          mode TEXT NOT NULL DEFAULT 'review',
          enabled INTEGER NOT NULL DEFAULT 0,
          project_id TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL
        )
      `);
      db.exec(`
        CREATE TABLE IF NOT EXISTS issue_dispatches (
          id TEXT PRIMARY KEY,
          repo_id TEXT NOT NULL,
          issue_number INTEGER NOT NULL,
          issue_title TEXT,
          issue_url TEXT,
          issue_created_at TEXT,
          status TEXT NOT NULL DEFAULT 'pending',
          session_id TEXT,
          branch_name TEXT,
          worktree_path TEXT,
          pr_url TEXT,
          pr_number INTEGER,
          pr_status TEXT,
          dispatched_at TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          FOREIGN KEY (repo_id) REFERENCES dispatch_repos(id) ON DELETE CASCADE,
          FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE SET NULL
        )
      `);
      db.exec(
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_dispatch_repo_issue ON issue_dispatches(repo_id, issue_number)`
      );
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_dispatch_status ON issue_dispatches(status)`
      );
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_dispatch_repo ON issue_dispatches(repo_id)`
      );
    },
  },
  {
    id: 17,
    name: "add_scheduled_at_to_issue_dispatches",
    up: (db) => {
      // One-shot scheduling: a 'scheduled' row waits until scheduled_at, then the
      // reconciler promotes it to 'pending' (normal headroom/mode rules apply).
      if (!hasColumn(db, "issue_dispatches", "scheduled_at")) {
        db.exec(`ALTER TABLE issue_dispatches ADD COLUMN scheduled_at TEXT`);
      }
    },
  },
  {
    id: 18,
    name: "add_reviewer_gate_columns",
    up: (db) => {
      // Opt-in reviewer gate (default off). When on, a worker's PR gets a critic
      // agent; Stoa surfaces the GitHub review decision in the cockpit.
      if (!hasColumn(db, "dispatch_repos", "review_gate")) {
        db.exec(
          `ALTER TABLE dispatch_repos ADD COLUMN review_gate INTEGER NOT NULL DEFAULT 0`
        );
      }
      // reviewer_session_id: set once a critic is spawned (spawn-once guard).
      // review_decision: cached GitHub reviewDecision for the cockpit badge.
      if (!hasColumn(db, "issue_dispatches", "reviewer_session_id")) {
        db.exec(
          `ALTER TABLE issue_dispatches ADD COLUMN reviewer_session_id TEXT`
        );
      }
      if (!hasColumn(db, "issue_dispatches", "review_decision")) {
        db.exec(`ALTER TABLE issue_dispatches ADD COLUMN review_decision TEXT`);
      }
    },
  },
  {
    id: 19,
    name: "add_fix_loop_columns",
    up: (db) => {
      // Fix loop: on CHANGES_REQUESTED a fixer worker addresses the feedback
      // (capped by fix_rounds); fixer_session_id tracks the in-flight fixer.
      if (!hasColumn(db, "issue_dispatches", "fix_rounds")) {
        db.exec(
          `ALTER TABLE issue_dispatches ADD COLUMN fix_rounds INTEGER NOT NULL DEFAULT 0`
        );
      }
      if (!hasColumn(db, "issue_dispatches", "fixer_session_id")) {
        db.exec(
          `ALTER TABLE issue_dispatches ADD COLUMN fixer_session_id TEXT`
        );
      }
    },
  },
  {
    id: 20,
    name: "add_session_events_ledger",
    up: (db) => {
      // Append-only audit / event ledger. No FK to sessions ON PURPOSE — the
      // trail must outlive a deleted session (the audit-moat value AND the
      // analytics substrate). session_key is the backend key (e.g.
      // "claude-<uuid>"); created_at is epoch millis for cheap ordering.
      db.exec(`
        CREATE TABLE IF NOT EXISTS session_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_key TEXT NOT NULL,
          event_type TEXT NOT NULL,
          payload TEXT,
          created_at INTEGER NOT NULL
        )
      `);
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_session_events_key ON session_events(session_key)`
      );
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_session_events_type ON session_events(event_type)`
      );
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_session_events_created ON session_events(created_at)`
      );
    },
  },
  {
    id: 21,
    name: "add_auto_merge_to_issue_dispatches",
    up: (db) => {
      // Opt-in per-issue auto-merge (default off). When on, the reconciler merges
      // the worker's PR once it's ready (no conflicts, checks green, and — if the
      // repo armed review_gate — the critic approved).
      if (!hasColumn(db, "issue_dispatches", "auto_merge")) {
        db.exec(
          `ALTER TABLE issue_dispatches ADD COLUMN auto_merge INTEGER NOT NULL DEFAULT 0`
        );
      }
    },
  },
  {
    id: 22,
    name: "add_ci_autofix_columns",
    up: (db) => {
      // Opt-in per-repo CI auto-fix (default off). When on, the reconciler spawns
      // a fixer on a worker's PR whose checks are RED, to read the failures, fix
      // them, and push — making red PRs self-heal toward a green, mergeable state.
      if (!hasColumn(db, "dispatch_repos", "ci_autofix")) {
        db.exec(
          `ALTER TABLE dispatch_repos ADD COLUMN ci_autofix INTEGER NOT NULL DEFAULT 0`
        );
      }
      // ci_fix_rounds caps the CI-fix attempts; ci_fixer_session_id tracks the
      // in-flight CI fixer (separate from the review fixer so the two don't clash).
      if (!hasColumn(db, "issue_dispatches", "ci_fix_rounds")) {
        db.exec(
          `ALTER TABLE issue_dispatches ADD COLUMN ci_fix_rounds INTEGER NOT NULL DEFAULT 0`
        );
      }
      if (!hasColumn(db, "issue_dispatches", "ci_fixer_session_id")) {
        db.exec(
          `ALTER TABLE issue_dispatches ADD COLUMN ci_fixer_session_id TEXT`
        );
      }
    },
  },
  {
    id: 23,
    name: "create_session_ceremonies",
    up: (db) => {
      // Session "go to auto" — enrol a running session's PR into the SAME
      // ceremony the dispatch engine runs (critic panel → fix loop → CI auto-fix
      // → auto-merge), reusing its pure decision functions. One ceremony per
      // session (UNIQUE session_id). The PR/worktree/branch live on the session
      // row; this table mirrors only the review/CI progress fields of
      // issue_dispatches. `step` is a coarse lifecycle marker for the UI badge;
      // the reconciler derives each tick's action from the fields, like dispatch.
      db.exec(`
        CREATE TABLE IF NOT EXISTS session_ceremonies (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL UNIQUE,
          step TEXT NOT NULL DEFAULT 'queued',
          seed_prompt TEXT,
          pr_number INTEGER,
          pr_url TEXT,
          reviewer_session_id TEXT,
          review_decision TEXT,
          -- The PR head SHA the CURRENT panel is reviewing (set, fail-closed, at
          -- panel SPAWN). Panelists stamp the SHA they reviewed in their verdict
          -- marker; only markers matching this count, and the merge is pinned to it
          -- (gh --match-head-commit). A push after approval is re-reviewed, never
          -- merged unreviewed — immune to round/time/cancel races.
          review_sha TEXT,
          -- Opt-in: 1 = auto-merge when ready; 0 (default) = stop at 'ready' and
          -- let the human do the final merge (the safe default — the human renders
          -- the verdict on the reviewed, green PR).
          auto_merge INTEGER NOT NULL DEFAULT 0,
          fix_rounds INTEGER NOT NULL DEFAULT 0,
          fixer_session_id TEXT,
          ci_fix_rounds INTEGER NOT NULL DEFAULT 0,
          ci_fixer_session_id TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
        )
      `);
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_session_ceremonies_step ON session_ceremonies(step)`
      );
    },
  },
  {
    id: 24,
    name: "add_merge_train_columns",
    up: (db) => {
      // Opt-in per-repo merge train (default off). When on, the reconciler keeps a
      // worker's PR LANDABLE: once it's approved + green but CONFLICTING (the base
      // moved under it), it spawns the author to rebase onto the base, resolve the
      // conflicts preserving both intents, and force-push-with-lease — so a ready
      // PR self-heals back to mergeable instead of paging a human to rebase.
      //
      // Each ALTER is guarded INDEPENDENTLY (not relying on the outer
      // "duplicate column → mark applied" recovery): a crash after the first ALTER
      // would otherwise record the migration as applied on retry and silently skip
      // the remaining columns. rebase_rounds caps the rebase attempts;
      // rebase_fixer_session_id tracks the in-flight rebase fixer (separate from the
      // review/CI fixers so they don't clash).
      const hasColumn = (table: string, column: string): boolean =>
        (
          db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
        ).some((c) => c.name === column);
      if (!hasColumn("dispatch_repos", "merge_train")) {
        db.exec(
          `ALTER TABLE dispatch_repos ADD COLUMN merge_train INTEGER NOT NULL DEFAULT 0`
        );
      }
      if (!hasColumn("issue_dispatches", "rebase_rounds")) {
        db.exec(
          `ALTER TABLE issue_dispatches ADD COLUMN rebase_rounds INTEGER NOT NULL DEFAULT 0`
        );
      }
      if (!hasColumn("issue_dispatches", "rebase_fixer_session_id")) {
        db.exec(
          `ALTER TABLE issue_dispatches ADD COLUMN rebase_fixer_session_id TEXT`
        );
      }
    },
  },
  {
    id: 25,
    name: "add_verify_columns",
    up: (db) => {
      // Opt-in per-repo verification harness (default off). When armed with a
      // verify_command, the reconciler runs it in each worker's PR worktree
      // (typecheck/test/build) and attaches the result to the review card, so
      // approvals are made from EVIDENCE, not by reading code — and (when armed)
      // gates auto-merge on a local pass. Especially fills the gap for repos with
      // NO GitHub CI (where summarizePrChecks → "none" → today merges with zero
      // test evidence). Each ALTER guarded independently (migration-24 pattern).
      const hasColumn = (table: string, column: string): boolean =>
        (
          db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
        ).some((c) => c.name === column);
      if (!hasColumn("dispatch_repos", "verify_gate")) {
        db.exec(
          `ALTER TABLE dispatch_repos ADD COLUMN verify_gate INTEGER NOT NULL DEFAULT 0`
        );
      }
      if (!hasColumn("dispatch_repos", "verify_command")) {
        db.exec(`ALTER TABLE dispatch_repos ADD COLUMN verify_command TEXT`);
      }
      // verify_status: NULL | running | pass | fail | error. verify_sha pins the
      // PR head the result is for (once-guard key + stale-verdict gating pin).
      if (!hasColumn("issue_dispatches", "verify_status")) {
        db.exec(`ALTER TABLE issue_dispatches ADD COLUMN verify_status TEXT`);
      }
      if (!hasColumn("issue_dispatches", "verify_output")) {
        db.exec(`ALTER TABLE issue_dispatches ADD COLUMN verify_output TEXT`);
      }
      if (!hasColumn("issue_dispatches", "verify_sha")) {
        db.exec(`ALTER TABLE issue_dispatches ADD COLUMN verify_sha TEXT`);
      }
      if (!hasColumn("issue_dispatches", "verify_ran_at")) {
        db.exec(`ALTER TABLE issue_dispatches ADD COLUMN verify_ran_at TEXT`);
      }
    },
  },
  {
    id: 26,
    name: "add_file_claims_to_issue_dispatches",
    up: (db) => {
      // Conflict-aware decomposition: a planner partitions a spec into tasks, each
      // owning a DISJOINT set of files (file_claims = a JSON array of repo-relative
      // path prefixes). The reconciler refuses to co-schedule two pending tasks
      // whose claims overlap a live (dispatched/pr_open) claim — so they serialize
      // instead of opening two PRs that collide at merge. NULL/absent = no claims =
      // exactly today's behavior (every legacy/non-planned row). Guarded ALTER
      // (migration-24/25 pattern).
      const hasColumn = (table: string, column: string): boolean =>
        (
          db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
        ).some((c) => c.name === column);
      if (!hasColumn("issue_dispatches", "file_claims")) {
        db.exec(`ALTER TABLE issue_dispatches ADD COLUMN file_claims TEXT`);
      }
    },
  },
  {
    id: 27,
    name: "add_repo_lessons",
    up: (db) => {
      // Fleet memory (the lessons ledger): persist each blocking critic finding per
      // repo, then inject the recent ones into every new worker's prompt so the
      // fleet stops re-making the same mistakes. CREATE TABLE IF NOT EXISTS is
      // already idempotent (no guard needed, unlike an ALTER).
      db.exec(`
        CREATE TABLE IF NOT EXISTS repo_lessons (
          id TEXT PRIMARY KEY,
          repo_id TEXT NOT NULL,
          lens TEXT,
          text TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          FOREIGN KEY (repo_id) REFERENCES dispatch_repos(id) ON DELETE CASCADE
        )
      `);
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_repo_lessons_repo ON repo_lessons(repo_id)`
      );
    },
  },
  {
    id: 28,
    name: "add_local_task_intake_to_issue_dispatches",
    up: (db) => {
      // Generalized intake (#7): a task can now come from a real GitHub issue OR a
      // freeform "local" task typed into Stoa (no issue required). Local rows carry
      // source='local', issue_number 0, and the freeform body in task_body. Both
      // sources drain through the SAME reconciler/pool. Guarded ALTERs
      // (migration-24..26 pattern); NULL/'github' default = exactly today's behavior.
      const hasColumn = (table: string, column: string): boolean =>
        (
          db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
        ).some((c) => c.name === column);
      // Swap the index FIRST: the guarded ALTERs below can throw "duplicate
      // column" under a concurrent-init race, which the runner catches and records
      // the migration as applied — so doing the swap first guarantees it can never
      // be stranded behind a caught ALTER. The swap only touches issue_number
      // (pre-existing), so it doesn't depend on the new columns.
      //
      // Make (repo, issue_number) uniqueness apply only to real GitHub issues
      // (number > 0). Local tasks share issue_number 0 and must not collide, so a
      // partial index excludes them. gh ingest dedupe (getDispatchByRepoIssue +
      // INSERT OR IGNORE) is unchanged — it only ever passes positive numbers.
      db.exec(`DROP INDEX IF EXISTS idx_dispatch_repo_issue`);
      db.exec(
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_dispatch_repo_issue ON issue_dispatches(repo_id, issue_number) WHERE issue_number > 0`
      );
      if (!hasColumn("issue_dispatches", "source")) {
        db.exec(
          `ALTER TABLE issue_dispatches ADD COLUMN source TEXT NOT NULL DEFAULT 'github'`
        );
      }
      if (!hasColumn("issue_dispatches", "task_body")) {
        db.exec(`ALTER TABLE issue_dispatches ADD COLUMN task_body TEXT`);
      }
    },
  },
  {
    id: 29,
    name: "add_recurrence_to_issue_dispatches",
    up: (db) => {
      // Cron recurrence (#7): a scheduled LOCAL task can repeat. recurrence
      // ('hourly'|'daily'|'weekly'); null/absent = one-shot = exactly today's
      // behavior. Guarded ALTER (migration-24..28 pattern).
      const hasColumn = (table: string, column: string): boolean =>
        (
          db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
        ).some((c) => c.name === column);
      if (!hasColumn("issue_dispatches", "recurrence")) {
        db.exec(`ALTER TABLE issue_dispatches ADD COLUMN recurrence TEXT`);
      }
    },
  },
  {
    id: 30,
    name: "add_source_to_repo_lessons",
    up: (db) => {
      // Fleet memory #9: distinguish operator-curated MANUAL rules from
      // auto-captured critic findings, so "forget findings" can clear the noise
      // while keeping curated facts. Guarded ALTER; default 'auto' = exactly the
      // existing (all-auto) behavior for legacy rows.
      const hasColumn = (table: string, column: string): boolean =>
        (
          db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
        ).some((c) => c.name === column);
      if (!hasColumn("repo_lessons", "source")) {
        db.exec(
          `ALTER TABLE repo_lessons ADD COLUMN source TEXT NOT NULL DEFAULT 'auto'`
        );
      }
    },
  },
  {
    id: 31,
    name: "add_maintainer_survey",
    up: (db) => {
      // Autonomous maintainer (opt-in, default off): a survey agent proposes its
      // own backlog on a cadence. Proposals carry maintainer_proposed=1 and are
      // structurally fenced out of auto-dispatch (they wait for one-tap Approve).
      // Guarded ALTERs; defaults = exactly today's behavior (no surveys, no fence).
      const hasColumn = (table: string, column: string): boolean =>
        (
          db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
        ).some((c) => c.name === column);
      const add = (table: string, column: string, ddl: string) => {
        if (!hasColumn(table, column)) {
          db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
        }
      };
      add(
        "dispatch_repos",
        "maintainer_survey_enabled",
        "maintainer_survey_enabled INTEGER NOT NULL DEFAULT 0"
      );
      add(
        "dispatch_repos",
        "maintainer_survey_goal",
        "maintainer_survey_goal TEXT"
      );
      add(
        "dispatch_repos",
        "maintainer_survey_cadence",
        "maintainer_survey_cadence TEXT"
      );
      add(
        "dispatch_repos",
        "maintainer_survey_last_at",
        "maintainer_survey_last_at TEXT"
      );
      add(
        "issue_dispatches",
        "maintainer_proposed",
        "maintainer_proposed INTEGER NOT NULL DEFAULT 0"
      );
    },
  },
  {
    id: 32,
    name: "backfill_worker_auto_approve",
    up: (db) => {
      // Workers always run with the bypass flag (lib/orchestration.ts spawns them
      // autoApprove:true), but rows created before createWorkerSession set
      // auto_approve=1 stored the column default 0. Backfill so the auto-approve
      // danger badge flags pre-upgrade workers too. Idempotent.
      // Guard the table existing — some migration tests run on a partial DB.
      const hasSessions =
        (
          db
            .prepare(
              `SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'`
            )
            .all() as { name: string }[]
        ).length > 0;
      if (!hasSessions) return;
      db.exec(
        `UPDATE sessions SET auto_approve = 1 WHERE conductor_session_id IS NOT NULL AND auto_approve = 0`
      );
    },
  },
  {
    id: 33,
    name: "add_worktree_paths_to_sessions",
    up: (db) => {
      // Multi-repo "workspace" sessions: a JSON array of the child worktree paths
      // this session created (one per picked sub-repo). NULL for ordinary
      // single-worktree (or no-worktree) sessions. Drives multi-worktree teardown
      // on delete. Guard the table existing (some migration tests run partial).
      const hasSessions =
        (
          db
            .prepare(
              `SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'`
            )
            .all() as { name: string }[]
        ).length > 0;
      if (!hasSessions) return;
      // Idempotent: skip if the column already exists (a bare ADD COLUMN would
      // throw "duplicate column name" on a partial / re-applied DB).
      const hasColumn = (
        db.prepare(`PRAGMA table_info(sessions)`).all() as { name: string }[]
      ).some((c) => c.name === "worktree_paths");
      if (!hasColumn) {
        db.exec(`ALTER TABLE sessions ADD COLUMN worktree_paths TEXT`);
      }
    },
  },
  {
    id: 34,
    name: "add_saved_workflows",
    up: (db) => {
      // Saved visual-builder workflows: the BuilderDoc (spec + canvas positions)
      // serialized as JSON. CREATE TABLE IF NOT EXISTS is inherently idempotent.
      db.exec(`
        CREATE TABLE IF NOT EXISTS saved_workflows (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          builder_doc TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `);
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_saved_workflows_updated ON saved_workflows(updated_at DESC)`
      );
    },
  },
  {
    id: 35,
    name: "add_history_to_saved_workflows",
    up: (db) => {
      // Version-history snapshots for saved workflows. Guarded so it is idempotent
      // under re-runs and concurrent init.
      const savedWorkflowsHasHistory = (
        db.prepare(`PRAGMA table_info(saved_workflows)`).all() as {
          name: string;
        }[]
      ).some((c) => c.name === "history");
      if (!savedWorkflowsHasHistory) {
        db.exec(
          `ALTER TABLE saved_workflows ADD COLUMN history TEXT NOT NULL DEFAULT '[]'`
        );
      }
    },
  },
  {
    id: 36,
    name: "add_dispatch_review_sha_and_composite_indexes",
    up: (db) => {
      // Dispatch review SHA pinning: the head commit a panel verdict was cached for.
      // Set when a complete verdict is cached; cleared on re-review/retry/rebase.
      if (
        hasTable(db, "issue_dispatches") &&
        !hasColumn(db, "issue_dispatches", "review_sha")
      ) {
        db.exec(`ALTER TABLE issue_dispatches ADD COLUMN review_sha TEXT`);
      }
      // Covering/composite indexes for common hot queries. IF NOT EXISTS prevents
      // errors when an index already exists; each CREATE is also guarded by hasTable
      // because a migration may run against a partial legacy DB that hasn't created
      // every table yet (e.g. migration tests that fake a pre-28 state).
      if (hasTable(db, "dev_servers")) {
        db.exec(
          `CREATE INDEX IF NOT EXISTS idx_dev_servers_project ON dev_servers(project_id)`
        );
      }
      if (hasTable(db, "sessions")) {
        db.exec(
          `CREATE INDEX IF NOT EXISTS idx_sessions_group ON sessions(group_path)`
        );
        db.exec(
          `CREATE INDEX IF NOT EXISTS idx_sessions_conductor ON sessions(conductor_session_id)`
        );
        db.exec(
          `CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id)`
        );
      }
      if (hasTable(db, "messages")) {
        db.exec(
          `CREATE INDEX IF NOT EXISTS idx_messages_session_timestamp ON messages(session_id, timestamp)`
        );
      }
      if (hasTable(db, "tool_calls")) {
        db.exec(
          `CREATE INDEX IF NOT EXISTS idx_tool_calls_session_timestamp ON tool_calls(session_id, timestamp)`
        );
        db.exec(
          `CREATE INDEX IF NOT EXISTS idx_tool_calls_message_timestamp ON tool_calls(message_id, timestamp)`
        );
      }
      if (hasTable(db, "issue_dispatches")) {
        db.exec(
          `CREATE INDEX IF NOT EXISTS idx_dispatch_repo_status ON issue_dispatches(repo_id, status)`
        );
        // dispatched_at was added in migration 17; a heavily-minimized legacy fixture
        // may have skipped it while still claiming that migration.
        if (hasColumn(db, "issue_dispatches", "dispatched_at")) {
          db.exec(
            `CREATE INDEX IF NOT EXISTS idx_dispatch_dispatched_at ON issue_dispatches(dispatched_at DESC)`
          );
        }
      }
      if (hasTable(db, "session_events")) {
        db.exec(
          `CREATE INDEX IF NOT EXISTS idx_session_events_key_type_id ON session_events(session_key, event_type, id)`
        );
      }
    },
  },
  {
    id: 37,
    name: "dedupe_repo_lessons_and_unique_index",
    up: (db) => {
      // The lesson INSERT…WHERE NOT EXISTS dedup wasn't atomic, so concurrent
      // captures could double-insert. Collapse any existing duplicates (keep the
      // earliest row per repo_id+text) then enforce uniqueness, so INSERT OR
      // IGNORE is a true idempotent dedup going forward. Guarded + idempotent.
      if (!hasTable(db, "repo_lessons")) return;
      db.exec(
        `DELETE FROM repo_lessons
         WHERE rowid NOT IN (
           SELECT MIN(rowid) FROM repo_lessons GROUP BY repo_id, text
         )`
      );
      db.exec(
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_repo_lessons_unique ON repo_lessons(repo_id, text)`
      );
    },
  },
  {
    id: 38,
    name: "add_best_of_n_tables",
    up: (db) => {
      // Best-of-N: run N parallel Claude sessions on the same task, each in an
      // isolated worktree, then present a compare view so the user can pick one
      // winner. The losing sessions and worktrees are cleaned up on pick.
      if (!hasTable(db, "best_of_n_runs")) {
        db.exec(`
          CREATE TABLE best_of_n_runs (
            id TEXT PRIMARY KEY,
            task TEXT NOT NULL,
            base_branch TEXT NOT NULL DEFAULT 'main',
            n INTEGER NOT NULL,
            status TEXT NOT NULL DEFAULT 'running',
            winner_session_id TEXT,
            project_id TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now')),
            FOREIGN KEY (winner_session_id) REFERENCES sessions(id) ON DELETE SET NULL,
            FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL
          )
        `);
        db.exec(
          `CREATE INDEX IF NOT EXISTS idx_bon_runs_project ON best_of_n_runs(project_id)`
        );
      }
      if (!hasTable(db, "best_of_n_candidates")) {
        db.exec(`
          CREATE TABLE best_of_n_candidates (
            id TEXT PRIMARY KEY,
            run_id TEXT NOT NULL,
            session_id TEXT,
            worktree_path TEXT,
            branch_name TEXT,
            candidate_index INTEGER NOT NULL,
            diff TEXT,
            is_winner INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now')),
            FOREIGN KEY (run_id) REFERENCES best_of_n_runs(id) ON DELETE CASCADE,
            FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE SET NULL
          )
        `);
        db.exec(
          `CREATE INDEX IF NOT EXISTS idx_bon_candidates_run ON best_of_n_candidates(run_id)`
        );
      }
    },
  },
  {
    id: 39,
    name: "add_agent_memory_table",
    up: (db) => {
      // Agent-accessible shared memory: a fleet-wide key→value scratchpad any
      // agent reads/writes via the orchestration MCP server (memory_* tools) or
      // the /api/memory route — the shared human+agent surface.
      if (!hasTable(db, "agent_memory")) {
        db.exec(`
          CREATE TABLE agent_memory (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
          )
        `);
      }
    },
  },
  {
    id: 40,
    name: "add_notes_table",
    up: (db) => {
      // Notes / shared knowledge base: persistent markdown docs readable/writable
      // by humans (the /api/notes route + a dialog) and agents (notes_* MCP tools).
      if (!hasTable(db, "notes")) {
        db.exec(`
          CREATE TABLE notes (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL DEFAULT '',
            content TEXT NOT NULL DEFAULT '',
            pinned INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
          )
        `);
      }
    },
  },
  {
    id: 41,
    name: "add_channel_messages_table",
    up: (db) => {
      // Inter-agent channels: an append-only 1:1 message log between sessions,
      // read/written via /api/channels + the channel_* MCP tools. pair_key is the
      // order-independent thread id; read_at marks a consumed message; delivered_at
      // records the opt-in turn-boundary terminal push.
      if (!hasTable(db, "channel_messages")) {
        db.exec(`
          CREATE TABLE channel_messages (
            id TEXT PRIMARY KEY,
            pair_key TEXT NOT NULL,
            from_session_id TEXT NOT NULL,
            to_session_id TEXT NOT NULL,
            body TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            delivered_at TEXT,
            read_at TEXT
          )
        `);
        db.exec(
          `CREATE INDEX IF NOT EXISTS idx_channel_messages_inbox
             ON channel_messages (to_session_id, read_at, created_at)`
        );
        db.exec(
          `CREATE INDEX IF NOT EXISTS idx_channel_messages_thread
             ON channel_messages (pair_key, created_at)`
        );
      }
    },
  },
  {
    id: 42,
    name: "add_schedules_table",
    up: (db) => {
      // General-purpose scheduler: fire a prompt into a session on a cadence. At
      // the due time the server enqueues the prompt into the session's prompt
      // queue (delivered by the existing safe turn-boundary path).
      if (!hasTable(db, "schedules")) {
        db.exec(`
          CREATE TABLE schedules (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL DEFAULT '',
            session_id TEXT NOT NULL,
            prompt TEXT NOT NULL,
            recurrence TEXT,
            next_run_at TEXT NOT NULL,
            last_run_at TEXT,
            enabled INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
          )
        `);
        db.exec(
          `CREATE INDEX IF NOT EXISTS idx_schedules_due
             ON schedules (enabled, next_run_at)`
        );
      }
    },
  },
  {
    id: 43,
    name: "add_session_costs_table",
    up: (db) => {
      // Persisted token/cost samples (#15). Cost was recomputed from the live
      // transcript on every request — so analytics had no HISTORY and a sample
      // vanished when the session was deleted or its transcript scrolled off.
      // One row per (session_key, day): the session's cumulative usage as last
      // sampled that UTC day, upserted idempotently. Survives transcript loss.
      if (!hasTable(db, "session_costs")) {
        db.exec(`
          CREATE TABLE session_costs (
            session_key TEXT NOT NULL,
            day TEXT NOT NULL,
            session_id TEXT NOT NULL,
            agent_type TEXT NOT NULL DEFAULT '',
            model TEXT,
            input_tokens INTEGER NOT NULL DEFAULT 0,
            output_tokens INTEGER NOT NULL DEFAULT 0,
            cache_read_tokens INTEGER NOT NULL DEFAULT 0,
            cache_write_tokens INTEGER NOT NULL DEFAULT 0,
            cost_usd REAL,
            updated_at TEXT NOT NULL DEFAULT (datetime('now')),
            PRIMARY KEY (session_key, day)
          )
        `);
        db.exec(
          `CREATE INDEX IF NOT EXISTS idx_session_costs_day
             ON session_costs (day)`
        );
      }
    },
  },
  {
    id: 44,
    name: "add_fork_cost_baseline",
    up: (db) => {
      // #1: a NATIVE Claude fork (--resume <parent> --fork-session) inherits the
      // parent's ENTIRE transcript, so the cost reader books the parent's full
      // history as the fork's usage (the fleet cost ~doubles, the persisted curve
      // spikes on the fork day). Record the parent's cumulative usage AT FORK TIME
      // here (a JSON TokenUsage); the cost path nets it out so only the fork's OWN
      // spend above the inherited baseline counts. NULL = no baseline (the common
      // case: not a native fork). Guarded ALTER (migration-24.. pattern).
      const hasSessions =
        (
          db
            .prepare(
              `SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'`
            )
            .all() as { name: string }[]
        ).length > 0;
      if (!hasSessions) return;
      const hasColumn = (
        db.prepare(`PRAGMA table_info(sessions)`).all() as { name: string }[]
      ).some((c) => c.name === "fork_cost_baseline");
      if (!hasColumn) {
        db.exec(`ALTER TABLE sessions ADD COLUMN fork_cost_baseline TEXT`);
      }
    },
  },
  {
    id: 45,
    name: "add_playbooks",
    up: (db) => {
      // #13: Project Playbooks + auto-recalled Knowledge. A named prompt snippet;
      // SELECT it as a recipe, or pin=1 with a project to auto-prepend it.
      if (!hasTable(db, "playbooks")) {
        db.exec(`
          CREATE TABLE IF NOT EXISTS playbooks (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            body TEXT NOT NULL,
            project_id TEXT,
            pinned INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now')),
            FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
          );
        `);
        db.exec(
          `CREATE INDEX IF NOT EXISTS idx_playbooks_project ON playbooks(project_id)`
        );
      }
    },
  },
  {
    id: 46,
    name: "add_project_startup_commands",
    up: (db) => {
      // #14b: per-project startup commands run on new-session boot (build,
      // codegen, db migrate — warming the worktree beyond npm install).
      // Safe-exec only: tokenizeCommand-validated at the API, spawned as argv.
      if (!hasTable(db, "project_startup_commands")) {
        db.exec(`
          CREATE TABLE IF NOT EXISTS project_startup_commands (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL,
            name TEXT NOT NULL,
            command TEXT NOT NULL,
            sort_order INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
          );
        `);
        db.exec(
          `CREATE INDEX IF NOT EXISTS idx_project_startup_commands_project ON project_startup_commands(project_id)`
        );
      }
    },
  },
  {
    id: 47,
    name: "add_verify_badge",
    up: (db) => {
      // #19: outcome-based verify badge. A project may configure a verify
      // command (validated with parseVerifySteps — Stoa's no-shell grammar);
      // when an interactive session finishes a turn it runs in the session's
      // worktree and the verdict lands on the sessions row (turn-scoped:
      // cleared when the next turn starts).
      const hasCol = (table: string, col: string) =>
        (
          db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
        ).some((c) => c.name === col);
      // hasTable guards: an upgrade fixture mid-migration may not have created
      // these tables yet (they'd be born WITH the columns via schema.ts).
      if (hasTable(db, "projects") && !hasCol("projects", "verify_command")) {
        db.exec(`ALTER TABLE projects ADD COLUMN verify_command TEXT`);
      }
      if (hasTable(db, "sessions")) {
        for (const col of ["verify_status", "verify_output", "verify_ran_at"]) {
          if (!hasCol("sessions", col)) {
            db.exec(`ALTER TABLE sessions ADD COLUMN ${col} TEXT`);
          }
        }
      }
    },
  },
  {
    id: 48,
    name: "add_dispatch_repo_default_model",
    up: (db) => {
      // #20 cost-aware routing: a repo may pin its dispatch workers to an
      // economical model tier (e.g. haiku). NULL = the agent's catalog default.
      // Validated at the PATCH boundary (resolveModelForAgent + isSafeModel).
      if (
        hasTable(db, "dispatch_repos") &&
        !hasColumn(db, "dispatch_repos", "default_model")
      ) {
        db.exec(`ALTER TABLE dispatch_repos ADD COLUMN default_model TEXT`);
      }
    },
  },
  {
    id: 49,
    name: "add_session_budget_usd",
    up: (db) => {
      // #21 per-session cost budget: a lifetime USD cap for this session.
      // 80%/100% alerts + an opt-in fail-closed park at the cap (the tick
      // stops feeding it work; the user can still type). NULL = no budget.
      if (
        hasTable(db, "sessions") &&
        !hasColumn(db, "sessions", "budget_usd")
      ) {
        db.exec(`ALTER TABLE sessions ADD COLUMN budget_usd REAL`);
      }
    },
  },
  {
    id: 50,
    name: "add_judge_gate",
    up: (db) => {
      // #26 LLM-as-judge rubric gate: opt-in per repo (fail-closed default 0);
      // the verdict trio mirrors verify_status/verify_output/verify_sha —
      // SHA-pinned so a stale pass can never greenlight a newer push.
      if (
        hasTable(db, "dispatch_repos") &&
        !hasColumn(db, "dispatch_repos", "judge_gate")
      ) {
        db.exec(
          `ALTER TABLE dispatch_repos ADD COLUMN judge_gate INTEGER NOT NULL DEFAULT 0`
        );
      }
      // Column order matches schema.ts's issue_dispatches judge block, so a
      // fresh-start DB and a migrated DB agree.
      if (
        hasTable(db, "issue_dispatches") &&
        !hasColumn(db, "issue_dispatches", "judge_status")
      ) {
        db.exec(`ALTER TABLE issue_dispatches ADD COLUMN judge_status TEXT`);
        db.exec(`ALTER TABLE issue_dispatches ADD COLUMN judge_output TEXT`);
        db.exec(`ALTER TABLE issue_dispatches ADD COLUMN judge_sha TEXT`);
        db.exec(`ALTER TABLE issue_dispatches ADD COLUMN judge_ran_at TEXT`);
      }
    },
  },
  {
    id: 51,
    name: "add_auth_tokens",
    up: (db) => {
      // #46/#49 per-device named revocable tokens with a SCOPE. We store only a
      // SHA-256 hash of the secret (never the plaintext), so a DB read can't
      // recover a usable token. `scope` is 'admin' (full control) or 'observer'
      // (read-only spectator: Live Wall stream + GETs, rejected by every mutation).
      // The legacy ~/.stoa/token stays valid as an implicit admin token (existing
      // shared URLs keep working); this table is ADDITIVE. `revoked_at` non-null →
      // the token fails auth immediately (revocation is checked live).
      db.exec(`
        CREATE TABLE IF NOT EXISTS auth_tokens (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          token_hash TEXT NOT NULL,
          scope TEXT NOT NULL DEFAULT 'admin',
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          last_used_at TEXT,
          revoked_at TEXT
        )
      `);
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_auth_tokens_hash ON auth_tokens(token_hash)`
      );
    },
  },
  {
    id: 52,
    name: "add_checkpoints",
    up: (db) => {
      // #44 Checkpoint / time-travel timeline. A DURABLE metadata + lineage layer
      // over the git shadow-commit snapshots (refs/stoa/snap/<session>/<seq>) —
      // the snapshot stays the store of worktree BYTES; this row pins one by
      // (seq, snapshot_sha) and adds what git refs can't hold: a human label, the
      // transcript anchor (claude_session_id at capture — native fork branches at
      // the transcript TIP), a kind, and fork lineage. snapshot_sha is stored too,
      // so a rewind/fork target survives the ref's FIFO prune (MAX 20) while the
      // object lives; a row whose sha no longer resolves is shown "expired", never
      // a broken target. ON DELETE CASCADE reaps a deleted session's checkpoints;
      // parent_checkpoint_id is SET NULL so a fork's lineage survives deleting its
      // source checkpoint.
      db.exec(`
        CREATE TABLE IF NOT EXISTS checkpoints (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          seq INTEGER NOT NULL,
          snapshot_sha TEXT NOT NULL,
          summary TEXT,
          transcript_session_id TEXT,
          kind TEXT NOT NULL DEFAULT 'manual',
          created_by TEXT NOT NULL DEFAULT 'manual',
          parent_checkpoint_id TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
          FOREIGN KEY (parent_checkpoint_id) REFERENCES checkpoints(id) ON DELETE SET NULL
        )
      `);
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_checkpoints_session ON checkpoints(session_id, seq)`
      );
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_checkpoints_parent ON checkpoints(parent_checkpoint_id)`
      );
    },
  },
  {
    id: 53,
    name: "add_approval_mode_to_sessions",
    up: (db) => {
      // #27 OS-level sandbox launch tier. Replaces all-or-nothing auto_approve
      // with a tri-state: 'prompt' | 'sandboxed-auto' | 'full-bypass'. Backfill
      // from the existing boolean so behavior is UNCHANGED on upgrade
      // (auto_approve=1 → 'full-bypass' = today's yolo; 0 → 'prompt'). auto_approve
      // is KEPT and kept in sync (the ~4 badge read-sites still read it), so this
      // migration is purely additive.
      // hasTable guard: an upgrade fixture mid-migration may not have created
      // the sessions table (it predates the migration system), so don't ALTER a
      // table that isn't there (mirrors migrations 47/49).
      if (
        hasTable(db, "sessions") &&
        !hasColumn(db, "sessions", "approval_mode")
      ) {
        db.exec(`ALTER TABLE sessions ADD COLUMN approval_mode TEXT`);
        db.exec(
          `UPDATE sessions SET approval_mode = CASE WHEN auto_approve = 1 THEN 'full-bypass' ELSE 'prompt' END WHERE approval_mode IS NULL`
        );
      }
    },
  },
  {
    id: 54,
    name: "add_fleet_management_tables",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS fleet_runs (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          goal TEXT NOT NULL,
          repo_id TEXT,
          project_id TEXT,
          status TEXT NOT NULL DEFAULT 'draft',
          budget_usd REAL,
          provider TEXT NOT NULL DEFAULT 'claude',
          model TEXT,
          max_concurrency INTEGER NOT NULL DEFAULT 1,
          review_policy TEXT NOT NULL DEFAULT 'four_agent',
          approval_state TEXT NOT NULL DEFAULT 'draft',
          settings_json TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          FOREIGN KEY (repo_id) REFERENCES dispatch_repos(id) ON DELETE SET NULL,
          FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL
        );

        CREATE TABLE IF NOT EXISTS fleet_tasks (
          id TEXT PRIMARY KEY,
          fleet_run_id TEXT NOT NULL,
          parent_task_id TEXT,
          title TEXT NOT NULL,
          description TEXT,
          status TEXT NOT NULL DEFAULT 'draft',
          task_type TEXT NOT NULL DEFAULT 'planning',
          sort_order INTEGER NOT NULL DEFAULT 0,
          file_claims_json TEXT NOT NULL DEFAULT '[]',
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          FOREIGN KEY (fleet_run_id) REFERENCES fleet_runs(id) ON DELETE CASCADE,
          FOREIGN KEY (parent_task_id) REFERENCES fleet_tasks(id) ON DELETE SET NULL
        );

        CREATE TABLE IF NOT EXISTS fleet_workers (
          id TEXT PRIMARY KEY,
          fleet_run_id TEXT NOT NULL,
          task_id TEXT,
          session_id TEXT,
          status TEXT NOT NULL DEFAULT 'waiting_for_operator',
          provider TEXT,
          model TEXT,
          attempt INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          last_heartbeat_at TEXT,
          ended_at TEXT,
          FOREIGN KEY (fleet_run_id) REFERENCES fleet_runs(id) ON DELETE CASCADE,
          FOREIGN KEY (task_id) REFERENCES fleet_tasks(id) ON DELETE SET NULL,
          FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE SET NULL
        );

        CREATE TABLE IF NOT EXISTS fleet_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          fleet_run_id TEXT NOT NULL,
          event_type TEXT NOT NULL,
          actor TEXT NOT NULL DEFAULT 'system',
          payload TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          FOREIGN KEY (fleet_run_id) REFERENCES fleet_runs(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_fleet_runs_status ON fleet_runs(status);
        CREATE INDEX IF NOT EXISTS idx_fleet_runs_updated ON fleet_runs(updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_fleet_tasks_run ON fleet_tasks(fleet_run_id, sort_order);
        CREATE INDEX IF NOT EXISTS idx_fleet_workers_run ON fleet_workers(fleet_run_id);
        CREATE INDEX IF NOT EXISTS idx_fleet_events_run ON fleet_events(fleet_run_id, id DESC);
      `);
    },
  },
];

export function runMigrations(db: Database.Database): void {
  // Create migrations tracking table
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // Get already applied migrations
  const applied = new Set(
    (db.prepare(`SELECT id FROM _migrations`).all() as { id: number }[]).map(
      (r) => r.id
    )
  );

  // Use INSERT OR IGNORE to handle concurrent workers
  const insertMigration = db.prepare(
    `INSERT OR IGNORE INTO _migrations (id, name) VALUES (?, ?)`
  );

  for (const migration of migrations) {
    if (applied.has(migration.id)) continue;

    try {
      migration.up(db);
      const result = insertMigration.run(migration.id, migration.name);
      if (result.changes > 0) {
        console.log(`Migration ${migration.id}: ${migration.name} applied`);
      } else {
        console.log(
          `Migration ${migration.id}: ${migration.name} skipped (concurrent apply)`
        );
      }
    } catch (error) {
      // Migrations are written to be idempotent (hasColumn / hasTable / IF NOT
      // EXISTS), but a legacy or externally-modified DB can still have a column /
      // table the guard can't detect. A "duplicate column" / "already exists"
      // there means the schema is effectively present, so record it applied and
      // move on. ANY OTHER error is a genuine migration bug — re-throw it loud
      // rather than silently marking a half-applied migration done.
      const msg = error instanceof Error ? error.message : String(error);
      if (/duplicate column|already exists/i.test(msg)) {
        insertMigration.run(migration.id, migration.name);
        console.log(
          `Migration ${migration.id}: ${migration.name} skipped (schema already present)`
        );
      } else {
        console.error(
          `Migration ${migration.id}: ${migration.name} failed:`,
          error
        );
        throw error;
      }
    }
  }
}
