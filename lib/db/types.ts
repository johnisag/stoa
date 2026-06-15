import type { AgentType } from "../providers";

export interface Session {
  id: string;
  name: string;
  tmux_name: string;
  created_at: string;
  updated_at: string;
  status: "idle" | "running" | "waiting" | "error";
  working_directory: string;
  parent_session_id: string | null;
  claude_session_id: string | null;
  model: string;
  system_prompt: string | null;
  group_path: string; // Deprecated - use project_id
  project_id: string | null;
  agent_type: AgentType;
  auto_approve: boolean;
  // Worktree fields (optional)
  worktree_path: string | null;
  branch_name: string | null;
  base_branch: string | null;
  dev_server_port: number | null;
  /** Multi-repo workspace session: JSON array of the child worktree paths this
   * session created (one per picked sub-repo). NULL/absent for ordinary sessions.
   * Optional so existing Session fixtures/builders don't all need the new column. */
  worktree_paths?: string | null;
  // PR tracking
  pr_url: string | null;
  pr_number: number | null;
  pr_status: "open" | "merged" | "closed" | null;
  // Orchestration fields
  conductor_session_id: string | null;
  worker_task: string | null;
  worker_status: "pending" | "running" | "completed" | "failed" | null;
  // Conductor launch args: extra argv tokens replayed at every spawn to wire the
  // stoa MCP server into a provider with no on-disk config (Codex's
  // `-c mcp_servers.stoa.*`). NULL for non-conductors and file-configured
  // providers (Claude's .mcp.json). JSON-encoded string[].
  mcp_launch_args: string | null;
}

export interface Group {
  path: string;
  name: string;
  expanded: boolean;
  sort_order: number;
  created_at: string;
}

export interface Project {
  id: string;
  name: string;
  working_directory: string;
  agent_type: AgentType;
  default_model: string;
  initial_prompt: string | null;
  expanded: boolean;
  sort_order: number;
  is_uncategorized: boolean;
  created_at: string;
  updated_at: string;
}

/** A saved visual-builder workflow. `builder_doc` is the JSON-serialized BuilderDoc
 * (spec + canvas positions) — parsed by the service layer into a typed doc. */
export interface SavedWorkflowRow {
  id: string;
  name: string;
  builder_doc: string;
  history: string;
  created_at: string;
  updated_at: string;
}

export interface ProjectDevServer {
  id: string;
  project_id: string;
  name: string;
  type: DevServerType;
  command: string;
  port: number | null;
  port_env_var: string | null;
  sort_order: number;
}

export interface ProjectRepository {
  id: string;
  project_id: string;
  name: string;
  path: string;
  is_primary: boolean;
  sort_order: number;
}

export interface Message {
  id: number;
  session_id: string;
  role: "user" | "assistant";
  content: string; // JSON array
  timestamp: string;
  duration_ms: number | null;
}

export interface ToolCall {
  id: number;
  message_id: number;
  session_id: string;
  tool_name: string;
  tool_input: string; // JSON
  tool_result: string | null; // JSON
  status: "pending" | "running" | "completed" | "error";
  timestamp: string;
}

export type DevServerType = "node" | "docker";
export type DevServerStatus = "stopped" | "starting" | "running" | "failed";

export interface DevServer {
  id: string;
  project_id: string;
  type: DevServerType;
  name: string;
  command: string;
  status: DevServerStatus;
  pid: number | null;
  container_id: string | null;
  ports: string; // JSON array of port numbers
  working_directory: string;
  created_at: string;
  updated_at: string;
}

/**
 * One row in the append-only audit / event ledger. Independent of the sessions
 * row (no FK) so the trail outlives a deleted session — the Windows-safety moat
 * ("what did the agent run") AND the raw substrate for analytics.
 */
export interface SessionEvent {
  id: number;
  /** Backend session key (e.g. "claude-<uuid>"), not sessions.id. */
  session_key: string;
  event_type: SessionEventType;
  /** JSON-encoded structured detail, or null for payload-less events. */
  payload: string | null;
  /** Epoch millis. */
  created_at: number;
}

/**
 * Recorded event kinds. Lifecycle + input/control at the SessionBackend seam
 * (web-server side). Deliberately omits raw pty output (daemon-side, high
 * volume — the rendered-screen capture already serves that need).
 */
export type SessionEventType =
  | "session_create"
  | "session_kill"
  | "session_rename"
  | "input_text"
  | "input_paste"
  | "input_enter"
  | "input_escape"
  // Command Stoa (chatbox actions) lifecycle — written under a synthetic
  // session_key, so analytics (which joins events to real sessions) ignores them
  // while the append-only audit trail keeps them. See lib/command/audit.ts.
  | "command_proposed"
  | "command_executed"
  | "command_rejected"
  | "command_failed"
  // Assisted workflow generator (generation-only) — a design was produced,
  // rejected by the validator, or the spawn/run failed. Same synthetic key.
  | "workflow_proposed"
  | "workflow_rejected"
  | "workflow_failed";
