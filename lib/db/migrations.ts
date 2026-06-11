import type Database from "better-sqlite3";

interface Migration {
  id: number;
  name: string;
  up: (db: Database.Database) => void;
}

// All migrations in order - never modify existing ones, only add new
const migrations: Migration[] = [
  {
    id: 1,
    name: "add_group_path_to_sessions",
    up: (db) => {
      db.exec(
        `ALTER TABLE sessions ADD COLUMN group_path TEXT NOT NULL DEFAULT 'sessions'`
      );
    },
  },
  {
    id: 2,
    name: "add_agent_type_to_sessions",
    up: (db) => {
      db.exec(
        `ALTER TABLE sessions ADD COLUMN agent_type TEXT NOT NULL DEFAULT 'claude'`
      );
    },
  },
  {
    id: 3,
    name: "add_worktree_columns_to_sessions",
    up: (db) => {
      db.exec(`ALTER TABLE sessions ADD COLUMN worktree_path TEXT`);
      db.exec(`ALTER TABLE sessions ADD COLUMN branch_name TEXT`);
      db.exec(`ALTER TABLE sessions ADD COLUMN base_branch TEXT`);
      db.exec(`ALTER TABLE sessions ADD COLUMN dev_server_port INTEGER`);
    },
  },
  {
    id: 4,
    name: "add_pr_tracking_to_sessions",
    up: (db) => {
      db.exec(`ALTER TABLE sessions ADD COLUMN pr_url TEXT`);
      db.exec(`ALTER TABLE sessions ADD COLUMN pr_number INTEGER`);
      db.exec(`ALTER TABLE sessions ADD COLUMN pr_status TEXT`);
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
      db.exec(
        `ALTER TABLE sessions ADD COLUMN conductor_session_id TEXT REFERENCES sessions(id)`
      );
      db.exec(`ALTER TABLE sessions ADD COLUMN worker_task TEXT`);
      db.exec(`ALTER TABLE sessions ADD COLUMN worker_status TEXT`);
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_sessions_conductor ON sessions(conductor_session_id)`
      );
    },
  },
  {
    id: 7,
    name: "add_auto_approve_to_sessions",
    up: (db) => {
      db.exec(
        `ALTER TABLE sessions ADD COLUMN auto_approve INTEGER NOT NULL DEFAULT 0`
      );
    },
  },
  {
    id: 8,
    name: "add_dev_server_columns",
    up: (db) => {
      db.exec(
        `ALTER TABLE dev_servers ADD COLUMN type TEXT NOT NULL DEFAULT 'node'`
      );
      db.exec(
        `ALTER TABLE dev_servers ADD COLUMN name TEXT NOT NULL DEFAULT ''`
      );
      db.exec(
        `ALTER TABLE dev_servers ADD COLUMN command TEXT NOT NULL DEFAULT ''`
      );
      db.exec(`ALTER TABLE dev_servers ADD COLUMN pid INTEGER`);
      db.exec(
        `ALTER TABLE dev_servers ADD COLUMN working_directory TEXT NOT NULL DEFAULT ''`
      );
    },
  },
  {
    id: 9,
    name: "add_project_id_to_sessions",
    up: (db) => {
      db.exec(
        `ALTER TABLE sessions ADD COLUMN project_id TEXT REFERENCES projects(id)`
      );
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
      // Check if column exists first
      const cols = db.prepare(`PRAGMA table_info(dev_servers)`).all() as {
        name: string;
      }[];
      if (cols.some((c) => c.name === "project_id")) return;

      db.exec(
        `ALTER TABLE dev_servers ADD COLUMN project_id TEXT REFERENCES projects(id)`
      );
      // Migrate from session_id if it exists
      const hasSessionId = cols.some((c) => c.name === "session_id");
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
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_dev_servers_project ON dev_servers(project_id)`
      );
    },
  },
  {
    id: 11,
    name: "add_tmux_name_to_sessions",
    up: (db) => {
      db.exec(`ALTER TABLE sessions ADD COLUMN tmux_name TEXT`);
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
      db.exec(`ALTER TABLE projects ADD COLUMN initial_prompt TEXT`);
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
      db.exec(`ALTER TABLE sessions ADD COLUMN mcp_launch_args TEXT`);
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
      db.exec(`ALTER TABLE issue_dispatches ADD COLUMN scheduled_at TEXT`);
    },
  },
  {
    id: 18,
    name: "add_reviewer_gate_columns",
    up: (db) => {
      // Opt-in reviewer gate (default off). When on, a worker's PR gets a critic
      // agent; Stoa surfaces the GitHub review decision in the cockpit.
      db.exec(
        `ALTER TABLE dispatch_repos ADD COLUMN review_gate INTEGER NOT NULL DEFAULT 0`
      );
      // reviewer_session_id: set once a critic is spawned (spawn-once guard).
      // review_decision: cached GitHub reviewDecision for the cockpit badge.
      db.exec(
        `ALTER TABLE issue_dispatches ADD COLUMN reviewer_session_id TEXT`
      );
      db.exec(`ALTER TABLE issue_dispatches ADD COLUMN review_decision TEXT`);
    },
  },
  {
    id: 19,
    name: "add_fix_loop_columns",
    up: (db) => {
      // Fix loop: on CHANGES_REQUESTED a fixer worker addresses the feedback
      // (capped by fix_rounds); fixer_session_id tracks the in-flight fixer.
      db.exec(
        `ALTER TABLE issue_dispatches ADD COLUMN fix_rounds INTEGER NOT NULL DEFAULT 0`
      );
      db.exec(`ALTER TABLE issue_dispatches ADD COLUMN fixer_session_id TEXT`);
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
      db.exec(
        `ALTER TABLE issue_dispatches ADD COLUMN auto_merge INTEGER NOT NULL DEFAULT 0`
      );
    },
  },
  {
    id: 22,
    name: "add_ci_autofix_columns",
    up: (db) => {
      // Opt-in per-repo CI auto-fix (default off). When on, the reconciler spawns
      // a fixer on a worker's PR whose checks are RED, to read the failures, fix
      // them, and push — making red PRs self-heal toward a green, mergeable state.
      db.exec(
        `ALTER TABLE dispatch_repos ADD COLUMN ci_autofix INTEGER NOT NULL DEFAULT 0`
      );
      // ci_fix_rounds caps the CI-fix attempts; ci_fixer_session_id tracks the
      // in-flight CI fixer (separate from the review fixer so the two don't clash).
      db.exec(
        `ALTER TABLE issue_dispatches ADD COLUMN ci_fix_rounds INTEGER NOT NULL DEFAULT 0`
      );
      db.exec(
        `ALTER TABLE issue_dispatches ADD COLUMN ci_fixer_session_id TEXT`
      );
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
      // Some migrations may fail if columns already exist (from old system or concurrent worker)
      // Try to record as applied anyway to prevent re-running
      const errorMsg = error instanceof Error ? error.message : String(error);
      if (
        errorMsg.includes("duplicate column") ||
        errorMsg.includes("already exists")
      ) {
        insertMigration.run(migration.id, migration.name);
        console.log(
          `Migration ${migration.id}: ${migration.name} skipped (already applied)`
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
