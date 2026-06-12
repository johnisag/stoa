// @vitest-environment jsdom
//
// jsdom gives this file a real, per-file-isolated window + localStorage, so the
// client-only persistence path runs for real without mutating the shared node
// global (which would corrupt sibling test files sharing the worker fork).
import { describe, it, expect, beforeEach } from "vitest";
import {
  defaultChatModel,
  loadChatModel,
  saveChatModel,
} from "@/lib/chat-settings";
import { getModelOptions } from "@/lib/model-catalog";

describe("chat-settings — model default + per-provider persistence", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("each provider's chatbox default is a real catalog value (sync guard)", () => {
    // Locks the CHAT_DEFAULT_MODEL ↔ getModelOptions invariant: a catalog rename
    // that stranded a default would otherwise pass tsc/build and only surface as a
    // blank Select trigger + the agent silently using its own default.
    for (const provider of ["claude", "codex"] as const) {
      const def = defaultChatModel(provider);
      expect(getModelOptions(provider).some((o) => o.value === def)).toBe(true);
    }
  });

  it("claude defaults to Opus — overrides the agent's own Sonnet default", () => {
    expect(defaultChatModel("claude")).toBe("opus");
  });

  it("loadChatModel returns the provider default when nothing is saved", () => {
    expect(loadChatModel("claude")).toBe("opus");
    expect(loadChatModel("codex")).toBe("gpt-5.4");
  });

  it("round-trips a saved model, ignoring a value not in the provider catalog", () => {
    saveChatModel("claude", "haiku");
    expect(loadChatModel("claude")).toBe("haiku");
    // A foreign/stale id (a Codex model under the Claude key) → the default.
    saveChatModel("claude", "gpt-5.4");
    expect(loadChatModel("claude")).toBe("opus");
  });

  it("persists per provider — each provider keeps its own model independently", () => {
    saveChatModel("claude", "haiku");
    saveChatModel("codex", "gpt-5.4-mini");
    // Neither write clobbers the other (the bug a shared key would reintroduce).
    expect(loadChatModel("claude")).toBe("haiku");
    expect(loadChatModel("codex")).toBe("gpt-5.4-mini");
  });
});
