// @vitest-environment jsdom
/**
 * useWorkflowPersistence — React hook tests.
 *
 * Locks the unsaved-changes signal and the load baseline that were extracted
 * verbatim from WorkflowBuilder: `dirty` is false at the empty baseline, true
 * once the committed frame diverges, and `loadDoc` resets the baseline (dirty →
 * false) while driving the injected reset + clearSelection callbacks. The saved-
 * workflows list query is stubbed via `fetch` so this runs on every OS with no
 * backend.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createElement, type ReactNode } from "react";
import { renderHook, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useWorkflowPersistence } from "@/hooks/useWorkflowPersistence";
import { docFromSpec, type BuilderDoc } from "@/lib/pipeline/builder-model";
import type { PipelineSpec, PipelineStep } from "@/lib/pipeline/types";

const EMPTY: BuilderDoc = docFromSpec({
  name: "wf",
  workingDirectory: "/repo",
  steps: [],
} as PipelineSpec);

function step(id: string): PipelineStep {
  return { id, agent: "claude", task: `do ${id}` };
}

function withNode(id: string): BuilderDoc {
  return docFromSpec({
    name: "wf",
    workingDirectory: "/repo",
    steps: [step(id)],
  } as PipelineSpec);
}

function createWrapper() {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client }, children);
  };
}

const confirmYes = vi.fn(async () => true);

function setup(opts: {
  doc: BuilderDoc;
  committedDoc: BuilderDoc;
  reset?: (d: BuilderDoc) => void;
  clearSelection?: () => void;
}) {
  const reset = opts.reset ?? vi.fn();
  const clearSelection = opts.clearSelection ?? vi.fn();
  const view = renderHook(
    (props: { doc: BuilderDoc; committedDoc: BuilderDoc }) =>
      useWorkflowPersistence({
        doc: props.doc,
        committedDoc: props.committedDoc,
        emptyDoc: EMPTY,
        reset,
        clearSelection,
        confirm: confirmYes,
      }),
    {
      wrapper: createWrapper(),
      initialProps: { doc: opts.doc, committedDoc: opts.committedDoc },
    }
  );
  return { ...view, reset, clearSelection };
}

describe("useWorkflowPersistence", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ workflows: [] }),
      }))
    );
  });

  it("is not dirty at the empty baseline", () => {
    const { result } = setup({ doc: EMPTY, committedDoc: EMPTY });
    expect(result.current.dirty).toBe(false);
    expect(result.current.savedId).toBeNull();
  });

  it("becomes dirty when the committed frame diverges from the baseline", () => {
    const changed = withNode("a");
    const { result } = setup({ doc: changed, committedDoc: changed });
    expect(result.current.dirty).toBe(true);
  });

  it("tracks the committed frame, not the live doc (drag safety)", () => {
    // Live doc differs, but the committed frame still equals the baseline →
    // NOT dirty (an in-flight drag must not flip the unsaved dot).
    const { result } = setup({ doc: withNode("a"), committedDoc: EMPTY });
    expect(result.current.dirty).toBe(false);
  });

  it("loadDoc resets the baseline (dirty→false) and drives reset + clearSelection", () => {
    const changed = withNode("a");
    const { result, rerender, reset, clearSelection } = setup({
      doc: changed,
      committedDoc: changed,
    });
    expect(result.current.dirty).toBe(true);

    const loaded = withNode("b");
    act(() => result.current.loadDoc(loaded, "saved-1"));

    expect(reset).toHaveBeenCalledWith(loaded);
    expect(clearSelection).toHaveBeenCalledTimes(1);
    expect(result.current.savedId).toBe("saved-1");

    // After a load, the freshly-loaded committed frame is the new baseline, so
    // it reads as clean.
    rerender({ doc: loaded, committedDoc: loaded });
    expect(result.current.dirty).toBe(false);
  });
});
