import type Database from "better-sqlite3";

const PROFILE_COLUMNS = [
  {
    name: "session_role",
    ddl: "session_role TEXT NOT NULL DEFAULT 'interactive'",
  },
  { name: "launch_profile_json", ddl: "launch_profile_json TEXT" },
  { name: "launch_profile_hash", ddl: "launch_profile_hash TEXT" },
] as const;

function hasTable(db: Database.Database, table: string): boolean {
  return Boolean(
    db
      .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`)
      .get(table)
  );
}

function hasColumn(
  db: Database.Database,
  table: string,
  column: string
): boolean {
  return (
    db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  ).some((row) => row.name === column);
}

function installSessionLaunchProfileSchema(db: Database.Database): void {
  if (!hasTable(db, "sessions")) return;

  for (const column of PROFILE_COLUMNS) {
    if (!hasColumn(db, "sessions", column.name)) {
      db.exec(`ALTER TABLE sessions ADD COLUMN ${column.ddl}`);
    }
  }

  // Empty roles can exist only in a partially applied pre-profile schema. They
  // were ordinary sessions before roles existed, so normalize them before
  // validating the new invariant. Never downgrade an explicit internal role.
  db.exec(`
    UPDATE sessions
    SET session_role = 'interactive'
    WHERE session_role IS NULL OR session_role = '';
  `);

  const invalid = db
    .prepare(
      `SELECT id FROM sessions
       WHERE
         (session_role = 'interactive' AND (
           launch_profile_json IS NOT NULL OR launch_profile_hash IS NOT NULL
         ))
         OR
         (session_role <> 'interactive' AND (
           launch_profile_json IS NULL
           OR trim(launch_profile_json) = ''
           OR NOT json_valid(launch_profile_json)
           OR json_type(launch_profile_json) <> 'object'
           OR json_extract(launch_profile_json, '$.role') IS NOT session_role
           OR launch_profile_hash IS NULL
           OR length(launch_profile_hash) <> 64
           OR lower(launch_profile_hash) GLOB '*[^0-9a-f]*'
         ))
       LIMIT 1`
    )
    .get() as { id: string } | undefined;
  if (invalid) {
    throw new Error(
      `invalid persisted session launch profile for session ${invalid.id}`
    );
  }

  db.exec(`
    DROP TRIGGER IF EXISTS trg_sessions_launch_profile_insert_valid;
    DROP TRIGGER IF EXISTS trg_sessions_launch_profile_immutable;

    CREATE TRIGGER trg_sessions_launch_profile_insert_valid
    BEFORE INSERT ON sessions
    WHEN
      NEW.session_role IS NULL
      OR trim(NEW.session_role) = ''
      OR (
        NEW.session_role = 'interactive'
        AND (
          NEW.launch_profile_json IS NOT NULL
          OR NEW.launch_profile_hash IS NOT NULL
        )
      )
      OR (
        NEW.session_role <> 'interactive'
        AND (
          NEW.launch_profile_json IS NULL
          OR trim(NEW.launch_profile_json) = ''
          OR NOT json_valid(NEW.launch_profile_json)
          OR json_type(NEW.launch_profile_json) <> 'object'
          OR json_extract(NEW.launch_profile_json, '$.role')
             IS NOT NEW.session_role
          OR NEW.launch_profile_hash IS NULL
          OR length(NEW.launch_profile_hash) <> 64
          OR lower(NEW.launch_profile_hash) GLOB '*[^0-9a-f]*'
        )
      )
    BEGIN
      SELECT RAISE(ABORT, 'invalid session launch profile');
    END;

    CREATE TRIGGER trg_sessions_launch_profile_immutable
    BEFORE UPDATE OF
      session_role, launch_profile_json, launch_profile_hash,
      tmux_name, working_directory, parent_session_id, claude_session_id,
      model, system_prompt, group_path, agent_type, worktree_path, branch_name,
      base_branch, conductor_session_id, worker_task, auto_approve,
      approval_mode, project_id, worktree_paths, mcp_launch_args
    ON sessions
    WHEN OLD.session_role IS NOT NEW.session_role
      OR OLD.launch_profile_json IS NOT NEW.launch_profile_json
      OR OLD.launch_profile_hash IS NOT NEW.launch_profile_hash
      OR (
        OLD.session_role <> 'interactive'
        AND (
          OLD.tmux_name IS NOT NEW.tmux_name
          OR OLD.working_directory IS NOT NEW.working_directory
          OR OLD.parent_session_id IS NOT NEW.parent_session_id
          OR OLD.claude_session_id IS NOT NEW.claude_session_id
          OR OLD.model IS NOT NEW.model
          OR OLD.system_prompt IS NOT NEW.system_prompt
          OR OLD.group_path IS NOT NEW.group_path
          OR OLD.agent_type IS NOT NEW.agent_type
          OR OLD.worktree_path IS NOT NEW.worktree_path
          OR OLD.branch_name IS NOT NEW.branch_name
          OR OLD.base_branch IS NOT NEW.base_branch
          OR (
            OLD.conductor_session_id IS NOT NEW.conductor_session_id
            AND NOT (
              OLD.session_role IN (
                'fleet_worker',
                'fleet_planner',
                'fleet_plan_reviewer',
                'fleet_task_reviewer',
                'fleet_task_fixer'
              )
              AND
              OLD.conductor_session_id IS NOT NULL
              AND NEW.conductor_session_id IS NULL
            )
          )
          OR OLD.worker_task IS NOT NEW.worker_task
          OR OLD.auto_approve IS NOT NEW.auto_approve
          OR OLD.approval_mode IS NOT NEW.approval_mode
          OR OLD.project_id IS NOT NEW.project_id
          OR OLD.worktree_paths IS NOT NEW.worktree_paths
          OR OLD.mcp_launch_args IS NOT NEW.mcp_launch_args
        )
      )
    BEGIN
      SELECT RAISE(ABORT, 'session launch profile is immutable');
    END;
  `);
}

/** Install/repair the session role/profile columns and both enforcing triggers
 * as one SQLite transaction. A failed validation or DDL statement leaves no
 * partially installed columns or trigger gap, and replay is idempotent. */
export function ensureSessionLaunchProfileSchema(db: Database.Database): void {
  if (db.inTransaction) {
    installSessionLaunchProfileSchema(db);
    return;
  }
  db.transaction(() => installSessionLaunchProfileSchema(db)).immediate();
}
