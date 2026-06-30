"use client";

/**
 * Agent Monitor (Tier-0 / M1) — a read-only "htop for your AI agents" fleet view,
 * inspired by graykode/abtop but native (no Rust binary). One row per session with
 * the telemetry Stoa already computes: status, model, context-window %, token usage,
 * cost, and branch. Data comes from the session roster (prop) + the existing
 * /api/sessions/cost estimate (useSessionCosts) — no new backend. The merge/sort
 * lives in the pure, unit-tested lib/agent-monitor.ts.
 *
 * Opens as its own pane tab (fleet-nav / ⌘K), mirroring the Live Wall.
 */

import { Gauge, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useSessionCosts } from "@/hooks/useSessionCosts";
import { buildMonitorRows, formatTokens } from "@/lib/agent-monitor";
import type { ContextTone } from "@/lib/context-window";
import { cn } from "@/lib/utils";
import type { Session } from "@/lib/db";

const STATUS_DOT: Record<string, string> = {
  running: "bg-blue-500",
  waiting: "bg-amber-500",
  error: "bg-red-500",
  idle: "bg-muted-foreground/50",
  dead: "bg-muted-foreground/30",
};

const TONE_BAR: Record<ContextTone, string> = {
  ok: "bg-muted-foreground/50",
  warn: "bg-amber-500",
  full: "bg-red-500",
};

export function AgentMonitorView({
  sessions,
  onOpenSession,
  onClose,
}: {
  sessions: Session[];
  onOpenSession?: (sessionId: string) => void;
  onClose?: () => void;
}) {
  // Reuse the existing cost/usage estimate (Claude transcripts today); a session
  // with no estimate shows zeroes + "—" via buildMonitorRows.
  const { data } = useSessionCosts();
  const rows = buildMonitorRows(sessions, data?.sessions ?? {});
  // Proactive Claude rate-limit window (M2): global, fail-closed (null until the
  // statusline hook is installed) — render nothing when absent.
  const win = data?.rateLimitWindow ?? null;

  return (
    <div className="bg-background flex h-full min-h-0 w-full flex-col overflow-hidden">
      <div className="flex items-center justify-between gap-2 px-4 py-2">
        <span className="flex min-w-0 items-center gap-2">
          <Gauge className="h-4 w-4 flex-shrink-0" />
          <span className="text-sm font-medium">Agent Monitor</span>
          <span className="text-muted-foreground truncate text-xs">
            {rows.length} {rows.length === 1 ? "session" : "sessions"}
          </span>
        </span>
        {win && (
          <span
            className="flex flex-shrink-0 items-center gap-1.5"
            title="Claude rate-limit window utilization (the binding 5h/7d quota)"
          >
            <span className="text-muted-foreground text-[10px] uppercase">
              quota
            </span>
            <span className="bg-muted h-1.5 w-16 overflow-hidden rounded-full">
              <span
                className={cn("block h-full", TONE_BAR[win.tone])}
                style={{ width: `${Math.round(win.pct * 100)}%` }}
                aria-hidden="true"
              />
            </span>
            <span className="text-muted-foreground text-[10px] tabular-nums">
              {Math.round(win.pct * 100)}%
            </span>
          </span>
        )}
        {onClose && (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Close agent monitor"
            title="Close agent monitor"
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </Button>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {rows.length === 0 ? (
          <div className="text-muted-foreground mx-auto mt-10 max-w-sm text-center text-sm">
            No sessions to monitor. Start an agent and its telemetry appears
            here.
          </div>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {rows.map((r) => (
              <li key={r.id}>
                <button
                  type="button"
                  onClick={() => onOpenSession?.(r.id)}
                  title={`Open ${r.name}`}
                  className="border-border/40 bg-card/40 hover:bg-accent/50 flex w-full items-center gap-3 rounded-lg border px-3 py-2 text-left transition-colors"
                >
                  {/* Identity */}
                  <span
                    className={cn(
                      "h-2 w-2 flex-shrink-0 rounded-full",
                      STATUS_DOT[r.status] ?? STATUS_DOT.idle
                    )}
                    aria-hidden="true"
                  />
                  <span className="flex min-w-0 flex-[2] flex-col">
                    <span className="truncate text-xs font-medium">
                      {r.name}
                    </span>
                    <span className="text-muted-foreground truncate text-[10px]">
                      {r.agentType}
                      {r.model ? ` · ${r.model}` : ""}
                      {r.branch ? ` · ${r.branch}` : ""}
                    </span>
                  </span>

                  {/* Context-window gauge */}
                  <span className="hidden min-w-0 flex-1 flex-col gap-0.5 sm:flex">
                    <span className="bg-muted h-1.5 w-full overflow-hidden rounded-full">
                      <span
                        className={cn("block h-full", TONE_BAR[r.contextTone])}
                        style={{ width: `${Math.round(r.contextPct * 100)}%` }}
                        aria-hidden="true"
                      />
                    </span>
                    <span className="text-muted-foreground text-[10px]">
                      ctx {Math.round(r.contextPct * 100)}%
                    </span>
                  </span>

                  {/* Tokens */}
                  <span className="text-muted-foreground flex-shrink-0 text-right text-[11px] tabular-nums">
                    {r.supported ? formatTokens(r.totalTokens) : "—"}
                    <span className="block text-[9px] uppercase">tok</span>
                  </span>

                  {/* Cost */}
                  <span className="flex-shrink-0 text-right text-[11px] tabular-nums">
                    {r.costUsd != null ? `$${r.costUsd.toFixed(2)}` : "—"}
                    <span className="text-muted-foreground block text-[9px] uppercase">
                      cost
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
