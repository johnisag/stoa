import type Database from "better-sqlite3";

export function createSchema(db: Database.Database): void {
  db.exec(`
    -- Sessions table
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      status TEXT NOT NULL DEFAULT 'idle',
      working_directory TEXT NOT NULL DEFAULT '~',
      parent_session_id TEXT,
      claude_session_id TEXT,
      model TEXT DEFAULT 'sonnet',
      system_prompt TEXT,
      group_path TEXT NOT NULL DEFAULT 'sessions',
      agent_type TEXT NOT NULL DEFAULT 'claude',
      FOREIGN KEY (parent_session_id) REFERENCES sessions(id)
    );

    -- Groups table for organizing sessions
    CREATE TABLE IF NOT EXISTS groups (
      path TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      expanded INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Default group
    INSERT OR IGNORE INTO groups (path, name, sort_order) VALUES ('sessions', 'Sessions', 0);

    -- Messages table
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      timestamp TEXT NOT NULL DEFAULT (datetime('now')),
      duration_ms INTEGER,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );

    -- Tool calls table (linked to messages)
    CREATE TABLE IF NOT EXISTS tool_calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id INTEGER NOT NULL,
      session_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      tool_input TEXT NOT NULL,
      tool_result TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      timestamp TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );

    -- Dev servers table
    CREATE TABLE IF NOT EXISTS dev_servers (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'node',
      name TEXT NOT NULL DEFAULT '',
      command TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'stopped',
      pid INTEGER,
      container_id TEXT,
      ports TEXT NOT NULL DEFAULT '[]',
      working_directory TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    -- Projects table (replaces groups)
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      working_directory TEXT NOT NULL,
      agent_type TEXT NOT NULL DEFAULT 'claude',
      default_model TEXT NOT NULL DEFAULT 'sonnet',
      initial_prompt TEXT,
      expanded INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0,
      is_uncategorized INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Project dev servers (configuration templates)
    CREATE TABLE IF NOT EXISTS project_dev_servers (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'node',
      command TEXT NOT NULL,
      port INTEGER,
      port_env_var TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    -- Project repositories (for multi-repo git support)
    CREATE TABLE IF NOT EXISTS project_repositories (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      name TEXT NOT NULL,
      path TEXT NOT NULL,
      is_primary INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    -- Dispatch: tracked repos for GitHub-issue → agent-fleet ingestion
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
      review_gate INTEGER NOT NULL DEFAULT 0,
      ci_autofix INTEGER NOT NULL DEFAULT 0,
      merge_train INTEGER NOT NULL DEFAULT 0,
      verify_gate INTEGER NOT NULL DEFAULT 0,
      verify_command TEXT,
      project_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL
    );

    -- Dispatch: one row per ingested issue (a pending candidate or a live worker)
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
      scheduled_at TEXT,
      reviewer_session_id TEXT,
      review_decision TEXT,
      fix_rounds INTEGER NOT NULL DEFAULT 0,
      fixer_session_id TEXT,
      auto_merge INTEGER NOT NULL DEFAULT 0,
      ci_fix_rounds INTEGER NOT NULL DEFAULT 0,
      ci_fixer_session_id TEXT,
      rebase_rounds INTEGER NOT NULL DEFAULT 0,
      rebase_fixer_session_id TEXT,
      verify_status TEXT,
      verify_output TEXT,
      verify_sha TEXT,
      verify_ran_at TEXT,
      file_claims TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (repo_id) REFERENCES dispatch_repos(id) ON DELETE CASCADE,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE SET NULL
    );

    -- Append-only audit / event ledger (one row per recorded session event).
    -- Independent of the sessions row (no FK) ON PURPOSE: the trail must outlive
    -- a deleted session — that's the audit-moat value AND the analytics substrate.
    -- session_key is the BACKEND key (e.g. "claude-<uuid>"), not sessions.id.
    -- created_at is epoch MILLIS (integer) for cheap ordering + duration math.
    CREATE TABLE IF NOT EXISTS session_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_key TEXT NOT NULL,
      event_type TEXT NOT NULL,
      payload TEXT,
      created_at INTEGER NOT NULL
    );

    -- Session "go to auto": enrol a running session's PR into the dispatch
    -- ceremony (critic panel → fix loop → CI auto-fix → auto-merge). One per
    -- session (UNIQUE). The PR/worktree/branch live on the session row; this
    -- mirrors only the review/CI progress fields of issue_dispatches.
    CREATE TABLE IF NOT EXISTS session_ceremonies (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL UNIQUE,
      step TEXT NOT NULL DEFAULT 'queued',
      seed_prompt TEXT,
      pr_number INTEGER,
      pr_url TEXT,
      reviewer_session_id TEXT,
      review_decision TEXT,
      review_sha TEXT,
      auto_merge INTEGER NOT NULL DEFAULT 0,
      fix_rounds INTEGER NOT NULL DEFAULT 0,
      fixer_session_id TEXT,
      ci_fix_rounds INTEGER NOT NULL DEFAULT 0,
      ci_fixer_session_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );

    -- Indexes for common queries
    CREATE INDEX IF NOT EXISTS idx_session_events_key ON session_events(session_key);
    CREATE INDEX IF NOT EXISTS idx_session_events_type ON session_events(event_type);
    CREATE INDEX IF NOT EXISTS idx_session_events_created ON session_events(created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_dispatch_repo_issue ON issue_dispatches(repo_id, issue_number);
    CREATE INDEX IF NOT EXISTS idx_dispatch_status ON issue_dispatches(status);
    CREATE INDEX IF NOT EXISTS idx_dispatch_repo ON issue_dispatches(repo_id);
    CREATE INDEX IF NOT EXISTS idx_session_ceremonies_step ON session_ceremonies(step);
    CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
    CREATE INDEX IF NOT EXISTS idx_tool_calls_session ON tool_calls(session_id);
    CREATE INDEX IF NOT EXISTS idx_tool_calls_message ON tool_calls(message_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_parent ON sessions(parent_session_id);
    CREATE INDEX IF NOT EXISTS idx_project_dev_servers_project ON project_dev_servers(project_id);
    CREATE INDEX IF NOT EXISTS idx_project_repositories_project ON project_repositories(project_id);

    -- Default Uncategorized project
    INSERT OR IGNORE INTO projects (id, name, working_directory, is_uncategorized, sort_order)
    VALUES ('uncategorized', 'Uncategorized', '~', 1, 999999);
  `);
}
