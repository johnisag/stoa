export interface SessionStatus {
  sessionName: string;
  status: "idle" | "running" | "waiting" | "error" | "dead";
  lastLine?: string;
  hasPrompt?: boolean;
  /** #19 verify badge: last turn-boundary verdict + short failing-output head. */
  verifyStatus?: string | null;
  verifyOutput?: string | null;
}

export interface SessionListProps {
  activeSessionId?: string;
  sessionStatuses?: Record<string, SessionStatus>;
  onSelect: (sessionId: string) => void;
  onOpenInTab?: (sessionId: string) => void;
  onNewSessionInProject?: (projectId: string) => void;
  onOpenTerminal?: (projectId: string) => void;
  onStartDevServer?: (projectId: string) => void;
  onCreateDevServer?: (opts: {
    projectId: string;
    type: "node" | "docker";
    name: string;
    command: string;
    workingDirectory: string;
    ports?: number[];
  }) => Promise<void>;
}
