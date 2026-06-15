import { describe, it, expect } from "vitest";
import {
  DEFAULT_WORKFLOWS_VIEW_STATE,
  workflowsViewKey,
  coerceWorkflowsViewState,
  loadWorkflowsViewState,
  saveWorkflowsViewState,
  clearWorkflowsViewState,
  type WorkflowsViewState,
} from "@/lib/workflows-view-state";

// A tiny in-memory Storage so the pure persistence helpers can be exercised on
// every OS without a DOM/localStorage.
function fakeStorage() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => {
      map.set(k, v);
    },
    removeItem: (k: string) => {
      map.delete(k);
    },
  };
}

describe("workflows-view-state", () => {
  it("keys by tab id under the stoa-workflows-view namespace", () => {
    expect(workflowsViewKey("tab-123")).toBe("stoa-workflows-view:tab-123");
  });

  it("loads defaults when nothing is stored", () => {
    const store = fakeStorage();
    expect(loadWorkflowsViewState("tab-1", store)).toEqual(
      DEFAULT_WORKFLOWS_VIEW_STATE
    );
  });

  it("returns defaults (no throw, no read) without a tab id", () => {
    const store = fakeStorage();
    expect(loadWorkflowsViewState(undefined, store)).toEqual(
      DEFAULT_WORKFLOWS_VIEW_STATE
    );
    // No tab id → nothing persisted.
    saveWorkflowsViewState(undefined, DEFAULT_WORKFLOWS_VIEW_STATE, store);
    expect(store.map.size).toBe(0);
  });

  it("round-trips a saved state", () => {
    const store = fakeStorage();
    const state: WorkflowsViewState = {
      tab: "runs",
      pickedTemplate: "bug-hunt",
      openRunId: "run-abc",
      showHelp: false,
    };
    saveWorkflowsViewState("tab-7", state, store);
    expect(loadWorkflowsViewState("tab-7", store)).toEqual(state);
  });

  it("isolates state per tab id", () => {
    const store = fakeStorage();
    saveWorkflowsViewState(
      "tab-A",
      { tab: "build", pickedTemplate: null, openRunId: null, showHelp: true },
      store
    );
    saveWorkflowsViewState(
      "tab-B",
      {
        tab: "examples",
        pickedTemplate: null,
        openRunId: null,
        showHelp: false,
      },
      store
    );
    expect(loadWorkflowsViewState("tab-A", store).tab).toBe("build");
    expect(loadWorkflowsViewState("tab-B", store).tab).toBe("examples");
  });

  it("coerces an unknown tab to the default tab", () => {
    expect(coerceWorkflowsViewState({ tab: "evil", showHelp: true }).tab).toBe(
      "templates"
    );
  });

  it("coerces wrong-typed fields to safe defaults", () => {
    const out = coerceWorkflowsViewState({
      tab: "runs",
      pickedTemplate: 42,
      openRunId: { not: "a string" },
      showHelp: "yes",
    });
    expect(out).toEqual({
      tab: "runs",
      pickedTemplate: null,
      openRunId: null,
      showHelp: false, // only the literal `true` enables help
    });
  });

  it("treats non-object blobs as defaults", () => {
    expect(coerceWorkflowsViewState(null)).toEqual(
      DEFAULT_WORKFLOWS_VIEW_STATE
    );
    expect(coerceWorkflowsViewState("nope")).toEqual(
      DEFAULT_WORKFLOWS_VIEW_STATE
    );
    expect(coerceWorkflowsViewState(123)).toEqual(DEFAULT_WORKFLOWS_VIEW_STATE);
  });

  it("falls back to defaults on corrupt JSON instead of throwing", () => {
    const store = fakeStorage();
    store.setItem(workflowsViewKey("tab-x"), "{not valid json");
    expect(loadWorkflowsViewState("tab-x", store)).toEqual(
      DEFAULT_WORKFLOWS_VIEW_STATE
    );
  });

  it("clears a tab's persisted state", () => {
    const store = fakeStorage();
    saveWorkflowsViewState(
      "tab-9",
      { tab: "custom", pickedTemplate: null, openRunId: null, showHelp: false },
      store
    );
    expect(store.map.size).toBe(1);
    clearWorkflowsViewState("tab-9", store);
    expect(store.map.size).toBe(0);
    // Loading after a clear yields defaults.
    expect(loadWorkflowsViewState("tab-9", store)).toEqual(
      DEFAULT_WORKFLOWS_VIEW_STATE
    );
  });

  it("clear is a no-op without a tab id", () => {
    const store = fakeStorage();
    store.setItem("unrelated", "keep me");
    clearWorkflowsViewState(undefined, store);
    expect(store.map.get("unrelated")).toBe("keep me");
  });

  it("survives a storage that throws (private mode) by returning defaults", () => {
    const throwing = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
      removeItem: () => {
        throw new Error("denied");
      },
    };
    expect(loadWorkflowsViewState("tab-1", throwing)).toEqual(
      DEFAULT_WORKFLOWS_VIEW_STATE
    );
    // Save/clear must not throw either.
    expect(() =>
      saveWorkflowsViewState("tab-1", DEFAULT_WORKFLOWS_VIEW_STATE, throwing)
    ).not.toThrow();
    expect(() => clearWorkflowsViewState("tab-1", throwing)).not.toThrow();
  });
});
