// @vitest-environment jsdom
import { createElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/data/verdict-inbox/queries", () => ({
  fetchInbox: vi.fn(async () => [
    {
      type: "dispatch",
      id: "review-me",
      state: "pr_open",
      reviewGate: true,
      reviewDecision: "CHANGES_REQUESTED",
    },
  ]),
}));

vi.mock("@/data/mcp-elicitations/queries", () => ({
  ELICITATIONS_KEY: ["mcp-elicitations"],
  fetchElicitations: vi.fn(async () => [{ id: "question" }]),
}));

vi.mock("@/data/fleet/queries", () => ({
  fetchFleetRuns: vi.fn(async () => [
    { id: "noisy-run", attentionCount: 4 },
    { id: "quiet-run", attentionCount: 0 },
  ]),
}));

import { useAttentionCount } from "@/data/verdict-inbox/useAttentionCount";

describe("Fleet nav attention count", () => {
  afterEach(cleanup);

  it("counts one card per Fleet run while preserving inbox and elicitation items", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client }, children);
    const { result } = renderHook(() => useAttentionCount(), { wrapper });

    await waitFor(() => expect(result.current).toBe(3));
    client.clear();
  });
});
