import { AGENT_OPTIONS } from "@/components/NewSessionDialog/NewSessionDialog.types";

// Which agent provider answers "Ask Stoa" questions. Persisted in localStorage so
// the choice sticks across reloads — mirrors the AGENT_TYPE_KEY pattern in
// components/NewSessionDialog (load-on-mount / write-on-change).
export const CHAT_PROVIDER_KEY = "stoa:chatProvider";

// The agents that can answer an Ask-Stoa question. Must stay in sync with
// ASK_PROVIDERS in lib/ask.ts (kept separate so this client module doesn't pull
// the server-only lib/ask into the browser bundle). Phase 1 = claude + codex;
// hermes is deferred until its one-shot mode is verified (see lib/ask.ts).
export type ChatProvider = "claude" | "codex";

const CHAT_PROVIDERS: readonly ChatProvider[] = ["claude", "codex"];

/** The default provider when nothing is stored (or a stale/invalid value is). */
export const DEFAULT_CHAT_PROVIDER: ChatProvider = "claude";

function isChatProvider(value: string | null): value is ChatProvider {
  return value != null && (CHAT_PROVIDERS as readonly string[]).includes(value);
}

/**
 * Read the persisted Ask-Stoa provider. SSR-guarded (localStorage doesn't exist
 * on the server) and validated against the known set, falling back to the
 * default for a missing or stale value.
 */
export function loadChatProvider(): ChatProvider {
  if (typeof window === "undefined") return DEFAULT_CHAT_PROVIDER;
  const saved = window.localStorage.getItem(CHAT_PROVIDER_KEY);
  return isChatProvider(saved) ? saved : DEFAULT_CHAT_PROVIDER;
}

/** Persist the Ask-Stoa provider choice. No-op on the server. */
export function saveChatProvider(provider: ChatProvider): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(CHAT_PROVIDER_KEY, provider);
}

/**
 * The picker options for the chat provider — reuses AGENT_OPTIONS' labels and
 * descriptions, narrowed to the providers Ask Stoa can use (the underlying list
 * already excludes "shell").
 */
export const CHAT_PROVIDER_OPTIONS = AGENT_OPTIONS.filter(
  (
    option
  ): option is { value: ChatProvider; label: string; description: string } =>
    isChatProvider(option.value)
);
