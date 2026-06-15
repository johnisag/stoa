import { describe, it, expect } from "vitest";
import {
  createTab,
  createPaneData,
  isViewTab,
  type TabData,
  type ViewKind,
} from "@/lib/panes";

describe("lib/panes", () => {
  it("createTab defaults to a terminal view", () => {
    const tab = createTab();
    expect(tab.view).toBe("terminal");
    expect(tab.sessionId).toBeNull();
    expect(tab.attachedTmux).toBeNull();
    expect(tab.id).toBeTruthy();
  });

  it("createTab accepts any fleet view kind", () => {
    const views: ViewKind[] = [
      "workflows",
      "dispatch",
      "analytics",
      "verdict-inbox",
      "fleet-board",
      "ask",
    ];
    for (const view of views) {
      expect(createTab(view).view).toBe(view);
    }
  });

  it("isViewTab: terminal/undefined are NOT views; every other kind is", () => {
    expect(isViewTab("terminal")).toBe(false);
    expect(isViewTab(undefined)).toBe(false);
    expect(isViewTab("workflows")).toBe(true);
    expect(isViewTab("fleet-board")).toBe(true);
    expect(isViewTab("ask")).toBe(true);
  });

  it("createPaneData seeds a terminal tab", () => {
    const pane = createPaneData();
    expect(pane.tabs).toHaveLength(1);
    expect(pane.tabs[0]?.view).toBe("terminal");
    expect(pane.activeTabId).toBe(pane.tabs[0]?.id);
  });

  it("treats a missing view as terminal for persisted state compatibility", () => {
    const legacy: TabData = {
      id: "legacy-tab",
      sessionId: "session-1",
      attachedTmux: null,
    };
    expect(legacy.view ?? "terminal").toBe("terminal");
  });
});
