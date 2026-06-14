import { describe, it, expect } from "vitest";
import { createTab, createPaneData, type TabData } from "@/lib/panes";

describe("lib/panes", () => {
  it("createTab defaults to a terminal view", () => {
    const tab = createTab();
    expect(tab.view).toBe("terminal");
    expect(tab.sessionId).toBeNull();
    expect(tab.attachedTmux).toBeNull();
    expect(tab.id).toBeTruthy();
  });

  it("createTab accepts a workflows view", () => {
    const tab = createTab("workflows");
    expect(tab.view).toBe("workflows");
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
