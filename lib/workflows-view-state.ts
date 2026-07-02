// Per-tab persistence for the Workflows pane view.
//
// A workflows tab is a first-class pane tab (like a terminal session), so it
// should survive a reload the way a session does: a session tab re-attaches to
// its live backend, a workflows tab restores which sub-tab / picked template /
// open run it was showing. This module is the pure, framework-free core (the
// React glue lives in WorkflowsView); it is unit-tested directly.
//
// State is keyed by the stable pane TabData.id so each open workflows tab keeps
// its own view independently (two panes can each show a different run).

export type WorkflowsTab =
  "templates" | "build" | "custom" | "examples" | "runs";

// NOTE: the transient help overlay (showHelp) is deliberately NOT persisted —
// restoring a full-screen help panel on every reload is jarring, and help is a
// momentary affordance, not a durable view. It stays local to the component.
export interface WorkflowsViewState {
  tab: WorkflowsTab;
  pickedTemplate: string | null;
  openRunId: string | null;
}

const VALID_TABS: readonly WorkflowsTab[] = [
  "templates",
  "build",
  "custom",
  "examples",
  "runs",
];

export const DEFAULT_WORKFLOWS_VIEW_STATE: WorkflowsViewState = {
  tab: "templates",
  pickedTemplate: null,
  openRunId: null,
};

const KEY_PREFIX = "stoa-workflows-view:";

/** localStorage key for a given pane tab id. */
export function workflowsViewKey(tabId: string): string {
  return `${KEY_PREFIX}${tabId}`;
}

/**
 * Coerce an arbitrary parsed blob into a known-good state. localStorage is
 * untrusted (an older schema, a hand-edit, or a different app version could
 * have written it), so every field is validated and anything unexpected falls
 * back to its default rather than flowing into the UI.
 */
export function coerceWorkflowsViewState(raw: unknown): WorkflowsViewState {
  if (!raw || typeof raw !== "object") {
    return { ...DEFAULT_WORKFLOWS_VIEW_STATE };
  }
  const o = raw as Record<string, unknown>;
  return {
    tab: VALID_TABS.includes(o.tab as WorkflowsTab)
      ? (o.tab as WorkflowsTab)
      : DEFAULT_WORKFLOWS_VIEW_STATE.tab,
    pickedTemplate:
      typeof o.pickedTemplate === "string" ? o.pickedTemplate : null,
    openRunId: typeof o.openRunId === "string" ? o.openRunId : null,
  };
}

// A minimal Storage shape so the pure functions can be tested with a fake and
// stay decoupled from the DOM. window.localStorage satisfies this.
type WebStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function defaultStorage(): WebStorage | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    // Accessing localStorage can throw (e.g. some privacy modes) — treat as
    // "no storage" so the UI still works, just without persistence.
    return null;
  }
}

/**
 * Load the persisted view state for a tab. Returns defaults when there is no
 * tab id, no storage, nothing stored, or the stored value is unparseable —
 * never throws.
 */
export function loadWorkflowsViewState(
  tabId: string | undefined,
  storage: WebStorage | null = defaultStorage()
): WorkflowsViewState {
  if (!tabId || !storage) return { ...DEFAULT_WORKFLOWS_VIEW_STATE };
  try {
    const raw = storage.getItem(workflowsViewKey(tabId));
    if (!raw) return { ...DEFAULT_WORKFLOWS_VIEW_STATE };
    return coerceWorkflowsViewState(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_WORKFLOWS_VIEW_STATE };
  }
}

/** Persist the view state for a tab. No-ops without a tab id or storage. */
export function saveWorkflowsViewState(
  tabId: string | undefined,
  state: WorkflowsViewState,
  storage: WebStorage | null = defaultStorage()
): void {
  if (!tabId || !storage) return;
  try {
    storage.setItem(workflowsViewKey(tabId), JSON.stringify(state));
  } catch {
    // Quota exceeded / private mode — losing persistence is acceptable.
  }
}

/**
 * Drop a tab's persisted state. Called when a tab closes so closed workflows
 * tabs don't accumulate stale keys in localStorage forever (tab ids are unique
 * per creation). Harmless on a non-workflows tab id (removeItem is a no-op).
 */
export function clearWorkflowsViewState(
  tabId: string | undefined,
  storage: WebStorage | null = defaultStorage()
): void {
  if (!tabId || !storage) return;
  try {
    storage.removeItem(workflowsViewKey(tabId));
  } catch {
    // ignore
  }
}
