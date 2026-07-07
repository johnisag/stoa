// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement, type ReactNode } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { DesktopView } from "@/components/views/DesktopView";
import type { ViewProps } from "@/components/views/types";

vi.mock("@/components/SessionList", () => ({
  SessionList: () => null,
}));
vi.mock("@/components/NewSessionDialog", () => ({
  NewSessionDialog: () => null,
}));
vi.mock("@/components/NotificationSettings", () => ({
  NotificationSettings: () => null,
}));
vi.mock("@/components/DevServers/StartServerDialog", () => ({
  StartServerDialog: () => null,
}));
vi.mock("@/components/SidebarFooter", () => ({
  SidebarFooter: () => null,
}));
vi.mock("@/components/SidebarRail", () => ({
  SidebarRail: () => null,
}));
vi.mock("@/components/PaneLayout", () => ({
  PaneLayout: () => null,
}));
vi.mock("@/components/FleetBar/FleetBar", () => ({
  FleetBar: () => null,
}));
vi.mock("@/components/OnboardingChecklist", () => ({
  OnboardingChecklist: () => null,
}));
vi.mock("@/components/QuickSwitcher", () => ({
  QuickSwitcher: () => null,
}));
vi.mock("@/data/verdict-inbox/useAttentionCount", () => ({
  useAttentionCount: () => 0,
}));
vi.mock("@/stores/fileOpen", () => ({
  fileOpenActions: { requestOpen: vi.fn() },
}));
vi.mock("@/components/nav/fleet-nav", async () => {
  const React = await import("react");
  return {
    CountBadge: () => null,
    fleetNavEntry: (id: string) => ({
      icon: () => null,
      id,
      label: id,
    }),
    NavIconButton: () => null,
  };
});
vi.mock("@/components/ui/tooltip", async () => {
  const React = await import("react");
  const PassThrough = ({ children }: { children: ReactNode }) =>
    React.createElement(React.Fragment, null, children);

  return {
    Tooltip: PassThrough,
    TooltipContent: () => null,
    TooltipTrigger: PassThrough,
  };
});
vi.mock("@/components/ui/dropdown-menu", async () => {
  const React = await import("react");
  const PassThrough = ({ children }: { children: ReactNode }) =>
    React.createElement(React.Fragment, null, children);

  return {
    DropdownMenu: PassThrough,
    DropdownMenuContent: () => null,
    DropdownMenuItem: PassThrough,
    DropdownMenuTrigger: PassThrough,
  };
});

const STORAGE_KEY = "stoa:desktop-sidebar-width";

function viewProps(): ViewProps {
  return {
    sessions: [],
    projects: [],
    sessionStatuses: {},
    sidebarOpen: true,
    setSidebarOpen: vi.fn(),
    activeSession: undefined,
    focusedActiveTab: null,
    copiedSessionId: false,
    setCopiedSessionId: vi.fn(),
    showNewSessionDialog: false,
    setShowNewSessionDialog: vi.fn(),
    newSessionProjectId: null,
    newSessionPromptSeed: null,
    showNotificationSettings: false,
    setShowNotificationSettings: vi.fn(),
    showQuickSwitcher: false,
    setShowQuickSwitcher: vi.fn(),
    onOpenDispatch: vi.fn(),
    onOpenAnalytics: vi.fn(),
    onOpenWorkflows: vi.fn(),
    onOpenVerdictInbox: vi.fn(),
    onOpenFleetBoard: vi.fn(),
    onOpenLiveWall: vi.fn(),
    onOpenAgentMonitor: vi.fn(),
    onOpenActivity: vi.fn(),
    onOpenAsk: vi.fn(),
    onShowShortcuts: vi.fn(),
    onShowGuide: vi.fn(),
    onShowNotes: vi.fn(),
    onShowCommands: vi.fn(),
    onShowSharing: vi.fn(),
    notificationSettings: {} as ViewProps["notificationSettings"],
    permissionGranted: false,
    updateSettings: vi.fn(),
    requestPermission: vi.fn(async () => false),
    attachToSession: vi.fn(),
    openSessionInNewTab: vi.fn(),
    handleNewSessionInProject: vi.fn(),
    handleOpenTerminal: vi.fn(),
    handleSessionCreated: vi.fn(async () => {}),
    handleCreateProject: vi.fn(async () => null),
    handleStartDevServer: vi.fn(),
    handleCreateDevServer: vi.fn(async () => {}),
    startDevServerProject: null,
    setStartDevServerProjectId: vi.fn(),
    renderPane: () => null,
  };
}

function renderDesktopView() {
  return render(createElement(DesktopView, viewProps()));
}

function mockDesktopWidth(width: number) {
  return vi
    .spyOn(HTMLElement.prototype, "getBoundingClientRect")
    .mockImplementation(
      () =>
        ({
          bottom: 0,
          height: 0,
          left: 0,
          right: width,
          top: 0,
          width,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        }) as DOMRect
    );
}

describe("DesktopView sessions sidebar resize", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    window.localStorage.clear();
  });

  it("hydrates stored width, exposes the clamped max, and persists bare keyboard resizing", async () => {
    mockDesktopWidth(900);
    window.localStorage.setItem(STORAGE_KEY, "360");

    renderDesktopView();
    const separator = screen.getByRole("separator", {
      name: /resize sessions sidebar/i,
    });

    await waitFor(() =>
      expect(separator.getAttribute("aria-valuenow")).toBe("360")
    );
    expect(separator.getAttribute("aria-valuemax")).toBe("372");

    fireEvent.keyDown(separator, { key: "ArrowLeft" });

    await waitFor(() =>
      expect(separator.getAttribute("aria-valuenow")).toBe("344")
    );
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("344");

    fireEvent.keyDown(separator, { ctrlKey: true, key: "ArrowRight" });

    expect(separator.getAttribute("aria-valuenow")).toBe("344");
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("344");
  });

  it("lets keyboard users grow the hidden preferred width beyond a narrow clamp", async () => {
    mockDesktopWidth(800);
    window.localStorage.setItem(STORAGE_KEY, "360");

    renderDesktopView();
    const separator = screen.getByRole("separator", {
      name: /resize sessions sidebar/i,
    });

    await waitFor(() =>
      expect(separator.getAttribute("aria-valuenow")).toBe("272")
    );
    expect(separator.getAttribute("aria-valuemax")).toBe("272");

    fireEvent.keyDown(separator, { key: "ArrowRight" });
    fireEvent.keyDown(separator, { key: "ArrowRight" });

    expect(separator.getAttribute("aria-valuenow")).toBe("272");
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("392");
  });

  it("focuses the separator on pointer down and persists drag delta on cleanup", async () => {
    mockDesktopWidth(1000);
    window.localStorage.setItem(STORAGE_KEY, "300");

    renderDesktopView();
    const separator = screen.getByRole("separator", {
      name: /resize sessions sidebar/i,
    });

    await waitFor(() =>
      expect(separator.getAttribute("aria-valuenow")).toBe("300")
    );

    fireEvent.pointerDown(separator, {
      button: 0,
      clientX: 300,
      isPrimary: true,
      pointerId: 7,
    });
    expect(document.activeElement).toBe(separator);

    fireEvent.pointerMove(document, {
      buttons: 1,
      clientX: 350,
      pointerId: 7,
    });

    await waitFor(() =>
      expect(separator.getAttribute("aria-valuenow")).toBe("350")
    );

    fireEvent.pointerUp(document, { pointerId: 7 });
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("350");
    expect(document.body.style.cursor).toBe("");
    expect(document.body.style.userSelect).toBe("");
  });

  it("ends mouse chording drags when the primary button is released", async () => {
    mockDesktopWidth(1000);
    window.localStorage.setItem(STORAGE_KEY, "300");

    renderDesktopView();
    const separator = screen.getByRole("separator", {
      name: /resize sessions sidebar/i,
    });

    await waitFor(() =>
      expect(separator.getAttribute("aria-valuenow")).toBe("300")
    );

    fireEvent.pointerDown(separator, {
      button: 0,
      clientX: 300,
      isPrimary: true,
      pointerId: 7,
    });
    expect(document.body.style.cursor).toBe("col-resize");

    fireEvent.mouseUp(document, { button: 0 });

    await waitFor(() => expect(document.body.style.cursor).toBe(""));

    fireEvent.pointerMove(document, {
      buttons: 2,
      clientX: 380,
      pointerId: 7,
    });
    expect(separator.getAttribute("aria-valuenow")).toBe("300");
  });
});
