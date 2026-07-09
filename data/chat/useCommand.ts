import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ChatProvider } from "@/lib/chat-settings";
import { sessionKeys } from "@/data/sessions/keys";
import type { BuilderDoc } from "@/lib/pipeline/builder-model";
import type {
  SessionSummary,
  PlanStep,
  StepResult,
} from "@/lib/command/actions";
import type { StepProgress } from "@/components/views/ChatView/PlanCard";

/** One turn in the chat conversation, as replayed to the backend as history. */
export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

/** The validated params of a create_session proposal (mirrors the server's
 * CreateSessionParams — the wire contract for /api/command). */
export interface CreateSessionCommandParams {
  projectId: string;
  agentType: string;
  model?: string;
  name?: string;
  initialPrompt?: string;
}

/** Params for dispatch_issue. */
export interface DispatchIssueCommandParams {
  repoId: string;
  title: string;
  body?: string;
}

/** Params for open_view. */
export interface OpenViewCommandParams {
  view:
    | "analytics"
    | "dispatch"
    | "verdict-inbox"
    | "fleet-board"
    | "fleet-management";
}

/** Params for list_sessions. */
export interface ListSessionsCommandParams {
  status?: "running" | "idle" | "waiting";
}

/** Union of all supported action params (discriminated by the action field). */
export type CommandParams =
  | CreateSessionCommandParams
  | DispatchIssueCommandParams
  | OpenViewCommandParams
  | ListSessionsCommandParams;

/** A confirmed-pending proposal returned by /api/command/propose. */
export type CommandProposal =
  | {
      action: "create_session";
      params: CreateSessionCommandParams;
      summary: string;
      project: { id: string; name: string };
    }
  | {
      action: "dispatch_issue";
      params: DispatchIssueCommandParams;
      summary: string;
      project: { id: string; name: string };
    }
  | {
      action: "open_view";
      params: OpenViewCommandParams;
      summary: string;
      project: { id: string; name: string };
    }
  | {
      action: "list_sessions";
      params: ListSessionsCommandParams;
      summary: string;
      project: { id: string; name: string };
    };

/** The /api/command/propose envelope: the agent either answered, proposed, or
 * returned a multi-step plan. */
export type ProposeReply =
  | { kind: "answer"; text: string }
  | ({ kind: "proposal" } & CommandProposal)
  | {
      kind: "plan";
      name: string;
      steps: PlanStep[];
      projectNames: Record<string, string>;
    };

export interface ProposeInput {
  message: string;
  history: ChatMessage[];
  provider: ChatProvider;
  model: string;
}

/**
 * Ask the assistant to either answer or propose an action. POSTs to
 * /api/command/propose, which runs the selected agent and returns an answer or a
 * VALIDATED proposal (a confirm card). Never executes anything — the user must
 * confirm a proposal via useExecuteCommand. No auto-retry (a stuck retry would
 * respawn a CLI; the message is cheap to resend).
 */
export function useProposeCommand() {
  return useMutation({
    retry: 0,
    mutationFn: async (input: ProposeInput): Promise<ProposeReply> => {
      const res = await fetch("/api/command/propose", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok)
        throw new Error(data.error || "Failed to reach the assistant");
      return data as ProposeReply;
    },
  });
}

export interface GenerateWorkflowInput {
  summary: string;
  projectId: string;
  provider?: "claude" | "codex";
  /** A getModelOptions(provider) token, or omitted for the agent's default. */
  model?: string;
}

/** The /api/command/generate-workflow envelope: the designer either returned a
 * laid-out draft workflow, or answered in prose (a clarifying question / a reason
 * the design couldn't be produced). Generation-only — nothing has run. */
export type GenerateWorkflowReply =
  | { kind: "answer"; text: string }
  | {
      kind: "workflow";
      doc: BuilderDoc;
      project: { id: string; name: string };
    };

/**
 * Ask an agent to DESIGN a workflow from a one-line goal. POSTs to
 * /api/command/generate-workflow, which runs the agent one-shot and returns a
 * VALIDATED draft BuilderDoc (or a prose answer). NEVER runs anything — the
 * caller loads the draft into the canvas for review. No auto-retry (a stuck retry
 * would respawn a CLI; the summary is cheap to resend).
 */
export function useGenerateWorkflow() {
  return useMutation({
    retry: 0,
    mutationFn: async (
      input: GenerateWorkflowInput
    ): Promise<GenerateWorkflowReply> => {
      const res = await fetch("/api/command/generate-workflow", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok)
        throw new Error(data.error || "Failed to generate the workflow");
      return data as GenerateWorkflowReply;
    },
  });
}

export type { SessionSummary, StepProgress, StepResult };

export type ExecuteResult =
  | {
      ok: true;
      sessionId: string;
      name: string;
      initialPrompt?: string;
      project: { id: string; name: string };
    }
  | { ok: true; dispatchId: string; title: string; repoSlug: string }
  | { ok: true; clientAction: "open_view"; view: string }
  | { ok: true; sessions: SessionSummary[]; total: number };

export interface ExecuteInput {
  action: "create_session" | "dispatch_issue" | "open_view" | "list_sessions";
  params: CommandParams;
}

/** Wire body for executing a confirmed plan. */
export interface ExecutePlanInput {
  kind: "plan";
  name: string;
  steps: PlanStep[];
}

/** Wire response from POST /api/command/execute when kind:"plan". */
export interface ExecutePlanResult {
  ok: true;
  results: StepResult[];
}

/**
 * Run a confirmed proposal. POSTs to /api/command/execute, which RE-VALIDATES the
 * action server-side and creates the session via the typed sessions API. On
 * success the sessions list is invalidated so the new session appears immediately.
 */
export function useExecuteCommand() {
  const queryClient = useQueryClient();
  return useMutation({
    retry: 0,
    mutationFn: async (input: ExecuteInput): Promise<ExecuteResult> => {
      const res = await fetch("/api/command/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Failed to run the action");
      return data as ExecuteResult;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: sessionKeys.list() });
    },
  });
}

/**
 * The ChatView's local message model. A turn is the user's text, an assistant
 * answer (markdown), an assistant PROPOSAL (a confirm card with its lifecycle
 * status), an assistant PLAN (a multi-step confirm card), or the RESULT of an
 * executed action. `user` + `answer` turns and SUCCESSFUL results are replayed
 * to the backend as history (pending proposals/plans and failed results are not).
 */
export type ChatItem =
  | { role: "user"; content: string }
  | { role: "assistant"; kind: "answer"; content: string }
  | {
      role: "assistant";
      kind: "proposal";
      proposal: CommandProposal;
      status: "pending" | "executing" | "confirmed" | "cancelled";
    }
  | {
      role: "assistant";
      kind: "plan";
      name: string;
      steps: PlanStep[];
      projectNames: Record<string, string>;
      status: "pending" | "executing" | "confirmed" | "cancelled";
      /** Populated during and after execution. */
      progress?: StepProgress[];
    }
  | { role: "assistant"; kind: "result"; ok: boolean; content: string };

/**
 * Run a confirmed plan. POSTs to /api/command/execute with { kind:"plan", ... },
 * which re-validates and executes steps sequentially server-side. On success the
 * sessions list is invalidated (plan steps may create sessions). No auto-retry.
 */
export function useExecutePlan() {
  const queryClient = useQueryClient();
  return useMutation({
    retry: 0,
    mutationFn: async (input: ExecutePlanInput): Promise<ExecutePlanResult> => {
      const res = await fetch("/api/command/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Failed to execute the plan");
      return data as ExecutePlanResult;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: sessionKeys.list() });
    },
  });
}
