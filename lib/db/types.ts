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
  /** A native fork inherits its parent's transcript; this is the parent's
   * cumulative usage AT FORK TIME (JSON TokenUsage), netted out by the cost path so
   * only the fork's own spend counts. NULL for non-forks. Optional so existing
   * Session fixtures/builders don't all need it. (migration 44) */
  fork_cost_baseline?: string | null;
  /** #19 verify badge (migration 47): the last turn-boundary verify verdict
   * (running/pass/fail/error), its bounded failing-step output tail, and when it
   * ran. Turn-scoped — cleared when a new turn starts. Optional for fixtures. */
  verify_status?: string | null;
  verify_output?: string | null;
  verify_ran_at?: string | null;
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
  /** #19 (migration 47): the project's verify command for the turn-boundary
   *  verify badge (Stoa no-shell grammar). NULL = badge disabled. */
  verify_command?: string | null;
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

/** A row in the fleet-wide agent-accessible key→value memory (agent_memory). */
export interface AgentMemoryRow {
  key: string;
  value: string;
  created_at: string;
  updated_at: string;
}

/** A note in the shared knowledge base (notes). `pinned` is a SQLite 0/1. */
export interface NoteRow {
  id: string;
  title: string;
  content: string;
  pinned: number;
  created_at: string;
  updated_at: string;
}

/** A scheduled prompt (schedules). `recurrence` is NULL for a one-shot; `enabled`
 * is a SQLite 0/1; `next_run_at`/`last_run_at` are ISO strings. */
export interface ScheduleRow {
  id: string;
  name: string;
  session_id: string;
  prompt: string;
  recurrence: string | null;
  next_run_at: string;
  last_run_at: string | null;
  enabled: number;
  created_at: string;
  updated_at: string;
}

/** A 1:1 inter-agent channel message (channel_messages). `pair_key` is the
 * order-independent thread id; `delivered_at`/`read_at` are NULL until set. */
export interface ChannelMessageRow {
  id: string;
  pair_key: string;
  from_session_id: string;
  to_session_id: string;
  body: string;
  created_at: string;
  /** Set when the opt-in turn-boundary push injected it into the terminal. */
  delivered_at: string | null;
  /** Set when the recipient consumed it (a pull, or the opt-in push). */
  read_at: string | null;
}

/**
 * A persisted token/cost sample (#15). One row per (session_key, day) holding the
 * session's cumulative usage as last sampled that UTC day. `cost_usd` is null when
 * the model is unpriced. Written best-effort (cost badge / opt-in sampler tick).
 */
export interface SessionCostRow {
  session_key: string;
  day: string;
  session_id: string;
  agent_type: string;
  model: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost_usd: number | null;
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

/** #14b: a per-project startup command run on new-session boot (safe argv exec). */
export interface ProjectStartupCommand {
  id: string;
  project_id: string;
  name: string;
  command: string;
  sort_order: number;
  created_at: string;
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

export interface BestOfNRun {
  id: string;
  task: string;
  base_branch: string;
  n: number;
  status: "running" | "done" | "failed";
  winner_session_id: string | null;
  project_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface BestOfNCandidate {
  id: string;
  run_id: string;
  session_id: string | null;
  worktree_path: string | null;
  branch_name: string | null;
  candidate_index: number;
  diff: string | null;
  is_winner: number; // 0 | 1
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
