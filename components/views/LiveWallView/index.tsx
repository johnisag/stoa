"use client";

/**
 * Live-wall view (#7) — a read-only grid of the fleet's live agent terminals, the
 * iconic "control plane" wall. Each cell is an observer MiniTerminal over Stoa's
 * EXISTING per-session WebSocket stream (no iframes, no polling — amux's wall
 * self-embedded iframes that 5×-amplified its load; we reuse the live streams we
 * already have). Click a cell's header to open that session in the pane.
 *
 * Observer streaming is the native pty backend's capability (the same gate the
 * worker mini-preview uses), so on the legacy tmux backend (macOS/Linux default)
 * the wall shows a short "switch to the pty backend" notice instead of empty cells.
 */

import { LayoutGrid, X } from "lucide-react";
import { useTheme } from "next-themes";
import { Button } from "@/components/ui/button";
import { MiniTerminal } from "@/components/MiniTerminal";
import { useBackendType } from "@/hooks/useBackendType";
import {
  liveWallSessions,
  liveWallColumns,
  LIVE_WALL_MAX_CELLS,
} from "@/lib/live-wall";
import { cn } from "@/lib/utils";
import type { Session } from "@/lib/db";

const STATUS_DOT: Record<Session["status"], string> = {
  running: "bg-blue-500",
  waiting: "bg-amber-500",
  error: "bg-red-500",
  idle: "bg-muted-foreground/50",
};

export function LiveWallView({
  sessions,
  onOpenSession,
  onClose,
}: {
  sessions: Session[];
  onOpenSession?: (sessionId: string) => void;
  onClose?: () => void;
}) {
  const { theme: currentTheme, resolvedTheme } = useTheme();
  const terminalTheme =
    (currentTheme === "system" ? resolvedTheme : currentTheme) || "dark";

  // Observer streaming is pty-only. The shared hook caches the probe + self-heals
  // a transient failure (null only while loading), so the grid never gets wedged
  // showing the tmux notice on a blip.
  const backend = useBackendType();

  // Trim to the cell cap (each cell opens an observer WebSocket). Surfaced as a
  // "+N more" note so it's never a silent truncation.
  const all = liveWallSessions(sessions);
  const wall = all.slice(0, LIVE_WALL_MAX_CELLS);
  const hidden = all.length - wall.length;
  const columns = liveWallColumns(wall.length);

  return (
    <div className="bg-background flex h-full min-h-0 w-full flex-col overflow-hidden">
      <div className="flex items-center justify-between gap-2 px-4 py-2">
        <span className="flex min-w-0 items-center gap-2">
          <LayoutGrid className="h-4 w-4 flex-shrink-0" />
          <span className="text-sm font-medium">Live wall</span>
          <span className="text-muted-foreground truncate text-xs">
            {wall.length} {wall.length === 1 ? "session" : "sessions"}
            {hidden > 0 ? ` (+${hidden} more)` : ""}
          </span>
        </span>
        {onClose && (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Close live wall"
            title="Close live wall"
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </Button>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {backend === null ? (
          // Probe in flight — render nothing rather than a flash of header-only
          // cells (the terminals only mount once we know it's the pty backend).
          <div className="text-muted-foreground mt-10 text-center text-sm">
            Loading…
          </div>
        ) : backend === "tmux" ? (
          <div className="text-muted-foreground mx-auto mt-10 max-w-sm text-center text-sm">
            The live wall streams over Stoa&apos;s native <code>pty</code>{" "}
            backend. You&apos;re on the legacy <code>tmux</code> backend
            (macOS/Linux default) — restart Stoa with{" "}
            <code>STOA_BACKEND=pty</code> to use the wall.
          </div>
        ) : wall.length === 0 ? (
          <div className="text-muted-foreground mx-auto mt-10 max-w-sm text-center text-sm">
            No live sessions to show. Start an agent and its terminal appears
            here.
          </div>
        ) : (
          <div
            className="grid gap-2"
            style={{
              gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
            }}
          >
            {wall.map((s) => (
              <div
                key={s.id}
                className="border-border/40 bg-card/40 flex flex-col overflow-hidden rounded-lg border"
              >
                <button
                  type="button"
                  onClick={() => onOpenSession?.(s.id)}
                  title={`Open ${s.name}`}
                  className="hover:bg-accent/50 flex items-center gap-2 px-2 py-1.5 text-left transition-colors"
                >
                  <span
                    className={cn(
                      "h-2 w-2 flex-shrink-0 rounded-full",
                      STATUS_DOT[s.status]
                    )}
                    aria-hidden="true"
                  />
                  <span className="min-w-0 flex-1 truncate text-xs font-medium">
                    {s.name}
                  </span>
                  <span className="text-muted-foreground flex-shrink-0 text-[10px] uppercase">
                    {s.agent_type}
                  </span>
                </button>
                {/* Observer terminal — only meaningful on the pty backend (the
                    tmux branch above replaces the whole grid). MiniTerminal is a
                    read-only attach, so it never disturbs the live viewer. */}
                {backend === "pty" && s.tmux_name && (
                  <MiniTerminal attachKey={s.tmux_name} theme={terminalTheme} />
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
