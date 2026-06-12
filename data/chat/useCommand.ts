import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ChatProvider } from "@/lib/chat-settings";
import { sessionKeys } from "@/data/sessions/keys";

/** One turn in the chat conversation, as replayed to the backend as history. */
export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

/** The validated params of a create_session proposal (mirrors the server's
 * CreateSessionParams — the wire contract for /api/command). */
export interface CommandParams {
  projectId: string;
  agentType: string;
  model?: string;
  name?: string;
}

/** A confirmed-pending proposal returned by /api/command/propose. */
export interface CommandProposal {
  action: "create_session";
  params: CommandParams;
  summary: string;
  project: { id: string; name: string };
}

/** The /api/command/propose envelope: the agent either answered or proposed. */
export type ProposeReply =
  | { kind: "answer"; text: string }
  | ({ kind: "proposal" } & CommandProposal);

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

export interface ExecuteResult {
  ok: true;
  sessionId: string;
  name: string;
  project: { id: string; name: string };
}

export interface ExecuteInput {
  action: "create_session";
  params: CommandParams;
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
 * status), or the RESULT of an executed action. `user` + `answer` turns and
 * SUCCESSFUL results are replayed to the backend as history (pending proposals
 * and failed results are not).
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
  | { role: "assistant"; kind: "result"; ok: boolean; content: string };
