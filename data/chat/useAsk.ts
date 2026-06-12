import { useMutation } from "@tanstack/react-query";
import type { ChatProvider } from "@/lib/chat-settings";

/** One turn in the Ask-Stoa conversation. */
export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

/** The request body POSTed to /api/ask (matches the backend contract). */
export interface AskInput {
  question: string;
  history: ChatMessage[];
  provider: ChatProvider;
  /** Catalog model for the provider (e.g. "opus"); the route validates it. */
  model: string;
}

/**
 * Ask the fleet a natural-language question. POSTs to the read-only /api/ask
 * route, which routes the question (plus prior turns for context) to the chosen
 * agent and returns its answer. Never auto-retries — a question is cheap to
 * resend by hand, and a stuck retry would spin a CLI again.
 */
export function useAsk() {
  return useMutation({
    retry: 0,
    mutationFn: async (input: AskInput): Promise<string> => {
      const res = await fetch("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Failed to get an answer");
      return data.answer as string;
    },
  });
}
