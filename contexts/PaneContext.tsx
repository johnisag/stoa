"use client";

import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  useMemo,
  type ReactNode,
} from "react";
import {
  type PaneState,
  type PaneData,
  type TabData,
  type ViewKind,
  createInitialPaneState,
  createPaneData,
  createTab,
  splitPane,
  closePane,
  countPanes,
  savePaneState,
  loadPaneState,
  MAX_PANES,
} from "@/lib/panes";
import { clearWorkflowsViewState } from "@/lib/workflows-view-state";
import { useViewport } from "@/hooks/useViewport";

interface PaneContextValue {
  state: PaneState;
  focusedPaneId: string;
  canSplit: boolean;
  canClose: boolean;
  isMobile: boolean;
  focusPane: (paneId: string) => void;
  splitHorizontal: (paneId: string) => void;
  splitVertical: (paneId: string) => void;
  close: (paneId: string) => void;
  // Tab management
  addTab: (paneId: string, view?: TabData["view"]) => void;
  closeTab: (paneId: string, tabId: string) => void;
  switchTab: (paneId: string, tabId: string) => void;
  /** Open a fleet VIEW (workflows/fleet-board/…) as a pane tab — focusing the
   * existing one if this pane already has it, else creating it. */
  addViewTab: (paneId: string, view: ViewKind) => void;
  addWorkflowsTab: (paneId: string) => void;
  /** Open a Best-of-N run as a dedicated pane tab. Creates a new tab each time
   * (a run id is unique, so there is no dedupe risk). */
  addBonRunTab: (paneId: string, runId: string) => void;
  // Session management (operates on active tab)
  attachSession: (paneId: string, sessionId: string, tmuxName: string) => void;
  detachSession: (paneId: string) => void;
  // Detach tabs whose session no longer exists (e.g. after deletion)
  reconcileSessions: (validSessionIds: Set<string>) => void;
  getPaneData: (paneId: string) => PaneData;
  getActiveTab: (paneId: string) => TabData | null;
}

const PaneContext = createContext<PaneContextValue | null>(null);

// Default pane data for migration from old format
const defaultPaneData: PaneData = createPaneData();

export function PaneProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<PaneState>(createInitialPaneState);
  const [hydrated, setHydrated] = useState(false);
  const { isMobile } = useViewport();

  // Load from localStorage after hydration
  useEffect(() => {
    const saved = loadPaneState();
    if (saved) {
      // Migrate old pane data format if needed
      const migratedPanes: Record<string, PaneData> = {};
      for (const [paneId, paneData] of Object.entries(saved.panes)) {
        if ("tabs" in paneData && Array.isArray(paneData.tabs)) {
          // New format
          migratedPanes[paneId] = paneData as PaneData;
        } else {
          // Old format - migrate to new
          const oldData = paneData as {
            sessionId?: string | null;
            attachedTmux?: string | null;
          };
          const tab = createTab();
          tab.sessionId = oldData.sessionId || null;
          tab.attachedTmux = oldData.attachedTmux || null;
          migratedPanes[paneId] = {
            tabs: [tab],
            activeTabId: tab.id,
          };
        }
      }
      setState({ ...saved, panes: migratedPanes });
    }
    setHydrated(true);
  }, []);

  // Persist state changes to localStorage (only after hydration)
  useEffect(() => {
    if (hydrated) {
      savePaneState(state);
    }
  }, [state, hydrated]);

  const focusPane = useCallback((paneId: string) => {
    // Bail when already focused — otherwise every click rebuilds the state
    // object and re-renders all PaneContext consumers for no change.
    setState((prev) =>
      prev.focusedPaneId === paneId ? prev : { ...prev, focusedPaneId: paneId }
    );
  }, []);

  const splitHorizontal = useCallback((paneId: string) => {
    setState((prev) => {
      const newState = splitPane(prev, paneId, "horizontal");
      return newState || prev;
    });
  }, []);

  const splitVertical = useCallback((paneId: string) => {
    setState((prev) => {
      const newState = splitPane(prev, paneId, "vertical");
      return newState || prev;
    });
  }, []);

  const close = useCallback((paneId: string) => {
    setState((prev) => {
      const newState = closePane(prev, paneId);
      return newState || prev;
    });
  }, []);

  // Tab management
  const addTab = useCallback((paneId: string, view?: TabData["view"]) => {
    setState((prev) => {
      const pane = prev.panes[paneId];
      if (!pane) return prev;
      const newTab = createTab(view);
      return {
        ...prev,
        panes: {
          ...prev.panes,
          [paneId]: {
            ...pane,
            tabs: [...pane.tabs, newTab],
            activeTabId: newTab.id,
          },
        },
      };
    });
  }, []);

  // Open a fleet view as a pane tab. At most one tab of a given view per pane:
  // if it already exists, just focus it; else append + activate a new one. (The
  // workflows-as-a-tab dedupe, generalized to every view.)
  const addViewTab = useCallback((paneId: string, view: ViewKind) => {
    setState((prev) => {
      const pane = prev.panes[paneId];
      if (!pane) return prev;
      const existing = pane.tabs.find((t) => t.view === view);
      if (existing) {
        return {
          ...prev,
          panes: {
            ...prev.panes,
            [paneId]: { ...pane, activeTabId: existing.id },
          },
        };
      }
      const newTab = createTab(view);
      return {
        ...prev,
        panes: {
          ...prev.panes,
          [paneId]: {
            ...pane,
            tabs: [...pane.tabs, newTab],
            activeTabId: newTab.id,
          },
        },
      };
    });
  }, []);

  // Back-compat shim: the workflows tab is just a view tab.
  const addWorkflowsTab = useCallback(
    (paneId: string) => addViewTab(paneId, "workflows"),
    [addViewTab]
  );

  // Open a Best-of-N run as a pane tab. A run id is unique so we always create
  // a fresh tab (no dedupe). The runId is stored in tab.bonRunId.
  const addBonRunTab = useCallback((paneId: string, runId: string) => {
    setState((prev) => {
      const pane = prev.panes[paneId];
      if (!pane) return prev;
      const newTab = createTab("best-of-n");
      newTab.bonRunId = runId;
      return {
        ...prev,
        panes: {
          ...prev.panes,
          [paneId]: {
            ...pane,
            tabs: [...pane.tabs, newTab],
            activeTabId: newTab.id,
          },
        },
      };
    });
  }, []);

  const closeTab = useCallback((paneId: string, tabId: string) => {
    setState((prev) => {
      const pane = prev.panes[paneId];
      if (!pane || pane.tabs.length <= 1) return prev; // Keep at least one tab

      const newTabs = pane.tabs.filter((t) => t.id !== tabId);
      const newActiveTabId =
        pane.activeTabId === tabId ? newTabs[0].id : pane.activeTabId;

      // The tab is really closing — drop any persisted Workflows view state so
      // closed tabs don't accumulate stale localStorage keys (no-op for a
      // terminal tab id; removeItem is idempotent under StrictMode re-invoke).
      clearWorkflowsViewState(tabId);

      return {
        ...prev,
        panes: {
          ...prev.panes,
          [paneId]: {
            ...pane,
            tabs: newTabs,
            activeTabId: newActiveTabId,
          },
        },
      };
    });
  }, []);

  const switchTab = useCallback((paneId: string, tabId: string) => {
    setState((prev) => {
      const pane = prev.panes[paneId];
      if (!pane) return prev;
      return {
        ...prev,
        panes: {
          ...prev.panes,
          [paneId]: {
            ...pane,
            activeTabId: tabId,
          },
        },
      };
    });
  }, []);

  // Attach session to active tab
  const attachSession = useCallback(
    (paneId: string, sessionId: string, tmuxName: string) => {
      setState((prev) => {
        const pane = prev.panes[paneId];
        if (!pane) return prev;

        const newTabs = pane.tabs.map((tab) =>
          tab.id === pane.activeTabId
            ? { ...tab, sessionId, attachedTmux: tmuxName }
            : tab
        );

        return {
          ...prev,
          panes: {
            ...prev.panes,
            [paneId]: { ...pane, tabs: newTabs },
          },
        };
      });
    },
    []
  );

  // Detach session from active tab
  const detachSession = useCallback((paneId: string) => {
    setState((prev) => {
      const pane = prev.panes[paneId];
      if (!pane) return prev;

      const newTabs = pane.tabs.map((tab) =>
        tab.id === pane.activeTabId
          ? { ...tab, sessionId: null, attachedTmux: null }
          : tab
      );

      return {
        ...prev,
        panes: {
          ...prev.panes,
          [paneId]: { ...pane, tabs: newTabs },
        },
      };
    });
  }, []);

  // Detach any tab still pointing at a session that no longer exists, so a
  // deleted session can't leave a live orphan pane attached to it (under the
  // Tier-2 daemon the pty may outlive the DB row). Tabs are reset to empty, not
  // removed, so the pane falls back to its empty "no session" state.
  const reconcileSessions = useCallback((validSessionIds: Set<string>) => {
    setState((prev) => {
      let changed = false;
      const panes: Record<string, PaneData> = {};
      for (const [paneId, pane] of Object.entries(prev.panes)) {
        let paneChanged = false;
        const tabs = pane.tabs.map((tab) => {
          if (tab.sessionId && !validSessionIds.has(tab.sessionId)) {
            paneChanged = true;
            return { ...tab, sessionId: null, attachedTmux: null };
          }
          return tab;
        });
        panes[paneId] = paneChanged ? { ...pane, tabs } : pane;
        if (paneChanged) changed = true;
      }
      return changed ? { ...prev, panes } : prev;
    });
  }, []);

  const getPaneData = useCallback(
    (paneId: string): PaneData => {
      return state.panes[paneId] ? state.panes[paneId] : { ...defaultPaneData };
    },
    [state.panes]
  );

  const getActiveTab = useCallback(
    (paneId: string): TabData | null => {
      const pane = state.panes[paneId];
      if (!pane) return null;
      return pane.tabs.find((t) => t.id === pane.activeTabId) || null;
    },
    [state.panes]
  );

  // On mobile: disable splits (single pane only)
  const canSplit = !isMobile && countPanes(state.layout) < MAX_PANES;
  const canClose = !isMobile && countPanes(state.layout) > 1;

  // Memoize the context value so a re-render of PaneProvider that ISN'T a pane
  // state change doesn't mint a fresh value and re-render every usePanes()
  // consumer (panes/terminals). The useViewport resize listener fires one such
  // render on every resize event, and hydration flips two more at mount — those
  // are what this absorbs. NOTE: a selection click DOES change `state`, so it
  // still fans out to consumers; decoupling that needs memoized Terminal/Pane
  // props (a follow-up), not this memo. Identity changes only when pane state
  // (or isMobile) changes; the callbacks are useCallback-stable and
  // getPaneData/getActiveTab track state.panes (covered by the `state` dep).
  const value = useMemo<PaneContextValue>(
    () => ({
      state,
      focusedPaneId: state.focusedPaneId,
      canSplit,
      canClose,
      isMobile,
      focusPane,
      splitHorizontal,
      splitVertical,
      close,
      addTab,
      closeTab,
      switchTab,
      addViewTab,
      addWorkflowsTab,
      addBonRunTab,
      attachSession,
      detachSession,
      reconcileSessions,
      getPaneData,
      getActiveTab,
    }),
    [
      state,
      canSplit,
      canClose,
      isMobile,
      focusPane,
      splitHorizontal,
      splitVertical,
      close,
      addTab,
      closeTab,
      switchTab,
      addViewTab,
      addWorkflowsTab,
      addBonRunTab,
      attachSession,
      detachSession,
      reconcileSessions,
      getPaneData,
      getActiveTab,
    ]
  );

  return <PaneContext.Provider value={value}>{children}</PaneContext.Provider>;
}

export function usePanes() {
  const context = useContext(PaneContext);
  if (!context) {
    throw new Error("usePanes must be used within a PaneProvider");
  }
  return context;
}
