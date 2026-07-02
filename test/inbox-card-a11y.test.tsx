// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createElement, type ReactNode } from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ConfirmProvider } from "@/components/ConfirmProvider";
import { InboxCard } from "@/components/views/VerdictInboxView/InboxCard";
import type { InboxItem } from "@/lib/verdict-inbox";

function createWrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(
      QueryClientProvider,
      { client },
      createElement(ConfirmProvider, null, children)
    );
  };
}

const baseItem: InboxItem = {
  type: "dispatch",
  id: "disp-1",
  sessionId: null,
  repoId: "repo-1",
  prNumber: 42,
  prUrl: "https://github.com/owner/repo/pull/42",
  title: "Fix the thing",
  subtitle: "owner/repo",
  branch: "fix/the-thing",
  reviewDecision: null,
  state: "pr_open",
  reviewGate: true,
  verifyStatus: null,
  verifyOutput: null,
  verifyGate: false,
  judgeStatus: null,
  judgeOutput: null,
  judgeGate: false,
  fixRounds: 0,
  autoMerge: false,
  updatedAt: new Date().toISOString(),
};

describe("InboxCard accessibility", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ json: async () => [] }) as Response)
    );
  });

  it("exposes aria-expanded and aria-controls on the expand button", () => {
    render(createElement(InboxCard, { item: baseItem }), {
      wrapper: createWrapper(),
    });

    const button = screen.getByRole("button", { name: /Fix the thing/ });
    expect(button.getAttribute("aria-expanded")).toBe("false");
    const controls = button.getAttribute("aria-controls");
    expect(controls).toBeTruthy();

    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");

    const panel = document.getElementById(controls!);
    expect(panel).toBeTruthy();
  });
});
