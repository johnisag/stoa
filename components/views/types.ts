import type { Session } from "@/lib/db";
import type { ProjectWithDevServers } from "@/lib/projects";
import type { NotificationSettings } from "@/lib/notifications";
import type { TabData } from "@/lib/panes";
import type { RateLimitState } from "@/lib/rate-limit";

export interface SessionStatus {
  sessionName: string;
  status: "idle" | "running" | "waiting" | "error" | "dead";
  lastLine?: string;
  claudeSessionId?: string | null;
  /** Provider rate-limit state (null/absent when not limited). */
  rateLimit?: RateLimitState | null;
  /** True when an ACTUAL prompt is on screen (vs a finished turn that also reads
   * "waiting") — drives the "needs input" vs "ready" notification, not buttons. */
  hasPrompt?: boolean;
  /** #19 verify badge: the last turn-boundary verify verdict for this session
   * (running/pass/fail/error), when it ran, and a short failing-output head. */
  verifyStatus?: string | null;
  verifyRanAt?: string | null;
  verifyOutput?: string | null;
  /** #21 budget badge: stage vs the session's budget cap + parked flag. */
  budgetStage?: string;
  budgetParked?: boolean;
}

export interface ViewProps {
  sessions: Session[];
  projects: ProjectWithDevServers[];
  sessionStatuses: Record<string, SessionStatus>;
  sidebarOpen: boolean;
  setSidebarOpen: (open: boolean) => void;
  activeSession: Session | undefined;
  focusedActiveTab: TabData | null;
  copiedSessionId: boolean;
  setCopiedSessionId: (copied: boolean) => void;

  // Dialogs
  showNewSessionDialog: boolean;
  setShowNewSessionDialog: (show: boolean) => void;
  newSessionProjectId: string | null;
  /** #17: shared-text prompt seeded into the New Session dialog (share target). */
  newSessionPromptSeed: string | null;
  showNotificationSettings: boolean;
  setShowNotificationSettings: (show: boolean) => void;
  showQuickSwitcher: boolean;
  setShowQuickSwitcher: (show: boolean) => void;
  /** Open Dispatch as a pane tab (it's a window now, not a dialog). */
  onOpenDispatch: () => void;
  /** Open Insight/Analytics as a pane tab (it's a window now, not a dialog). */
  onOpenAnalytics: () => void;
  onOpenWorkflows: () => void;
  /** Open the Verdict Inbox as a pane tab (it's a window now, not a dialog). */
  onOpenVerdictInbox: () => void;
  /** Open the Fleet Board as a pane tab (it's a window now, not a dialog). */
  onOpenFleetBoard: () => void;
  /** Open the Live Wall (read-only grid of agent terminals) as a pane tab. */
  onOpenLiveWall: () => void;
  /** Open the Agent Monitor (per-session telemetry) as a pane tab. */
  onOpenAgentMonitor: () => void;
  /** Open Activity (the raw audit-event timeline) as a pane tab. */
  onOpenActivity: () => void;
  /** Open Ask Stoa (the chatbox) as a pane tab (it's a window now, not a dialog). */
  onOpenAsk: () => void;
  onShowShortcuts: () => void;
  onShowGuide: () => void;
  /** Open the Notes / shared knowledge base dialog. */
  onShowNotes: () => void;
  /** Open the Commands dialog (author native per-provider slash commands). */
  onShowCommands: () => void;

  // Notification settings
  notificationSettings: NotificationSettings;
  permissionGranted: boolean;
  updateSettings: (settings: Partial<NotificationSettings>) => void;
  requestPermission: () => Promise<boolean>;

  // Handlers
  attachToSession: (session: Session) => void;
  openSessionInNewTab: (session: Session) => void;
  handleNewSessionInProject: (projectId: string) => void;
  handleOpenTerminal: (projectId: string) => void;
  handleSessionCreated: (sessionId: string) => Promise<void>;
  handleCreateProject: (
    name: string,
    workingDirectory: string,
    agentType?: string
  ) => Promise<string | null>;

  // Dev server (for StartServerDialog)
  handleStartDevServer: (projectId: string) => void;
  handleCreateDevServer: (opts: {
    projectId: string;
    type: "node" | "docker";
    name: string;
    command: string;
    workingDirectory: string;
    ports?: number[];
  }) => Promise<void>;
  startDevServerProject: ProjectWithDevServers | null;
  setStartDevServerProjectId: (id: string | null) => void;

  // Pane
  renderPane: (paneId: string) => React.ReactNode;
}
