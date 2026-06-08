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

    // Run the migration AND record it in one transaction so a multi-statement
    // migration that fails partway (SQLITE_BUSY from the dev+install two-writer
    // setup, disk full, killed process) rolls back atomically and re-runs
    // cleanly next start — never leaving a half-applied schema recorded as done.
    const applyOne = db.transaction(() => {
      migration.up(db);
      return insertMigration.run(migration.id, migration.name);
    });

    try {
      const result = applyOne();
      if (result.changes > 0) {
        console.log(`Migration ${migration.id}: ${migration.name} applied`);
      } else {
        console.log(
          `Migration ${migration.id}: ${migration.name} skipped (concurrent apply)`
        );
      }
    } catch (error) {
      // The transaction above rolled the failed migration back. If it failed only
      // because its effect already exists (a pre-_migrations-era schema from the
      // old system), record it as applied so it isn't retried. Any OTHER failure
      // re-throws (left unrecorded) so it re-runs cleanly next start.
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
