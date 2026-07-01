"use client";

/**
 * Activity view — the raw, time-ordered audit-event timeline (#10). A pane TAB
 * (like a session, not a dialog) over the on-box ledger: filter by time window and
 * category, page through the newest events, and export the filtered set as CSV/JSON.
 * Insight (AnalyticsView) summarizes the same ledger; this shows the individual rows.
 */

import { useState } from "react";
import { History, RefreshCw, HelpCircle, X, Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SegmentedTabs } from "@/components/ui/segmented-tabs";
import type { SessionEventType } from "@/lib/db/types";
import { AUDIT_EXPORT_MAX, AUDIT_LIMIT_MAX } from "@/lib/audit/query";
import {
  useFleetAuditQuery,
  auditExportUrl,
  type AuditFilters,
} from "@/data/audit/queries";
import { ActivityHelp } from "./ActivityHelp";

const DAY = 86_400_000;
const PAGE = 200;
const MAX_IN_VIEW = AUDIT_LIMIT_MAX; // the route clamps a page to this; beyond it, export

const WINDOWS = [
  { key: "1d", label: "24h", days: 1 },
  { key: "7d", label: "7d", days: 7 },
  { key: "30d", label: "30d", days: 30 },
  { key: "all", label: "All", days: null },
] as const;

type CategoryKey = "all" | "lifecycle" | "input" | "commands" | "workflows";

// These groups map to the raw SessionEventType kinds. Keep them in sync with
// lib/audit/query.ts AUDIT_EVENT_TYPES: a new event kind added there won't appear in
// any category here except "All" (which sends no type filter) until it's added below.
const CATEGORIES: {
  key: CategoryKey;
  label: string;
  types?: SessionEventType[];
}[] = [
  { key: "all", label: "All" },
  {
    key: "lifecycle",
    label: "Lifecycle",
    types: ["session_create", "session_kill", "session_rename"],
  },
  {
    key: "input",
    label: "Input",
    types: ["input_text", "input_paste", "input_enter", "input_escape"],
  },
  {
    key: "commands",
    label: "Commands",
    types: [
      "command_proposed",
      "command_executed",
      "command_rejected",
      "command_failed",
    ],
  },
  {
    key: "workflows",
    label: "Workflows",
    types: ["workflow_proposed", "workflow_rejected", "workflow_failed"],
  },
];

const EVENT_LABEL: Record<SessionEventType, string> = {
  session_create: "Session created",
  session_kill: "Session stopped",
  session_rename: "Renamed",
  input_text: "Typed",
  input_paste: "Pasted",
  input_enter: "Enter",
  input_escape: "Escape",
  command_proposed: "Command proposed",
  command_executed: "Command executed",
  command_rejected: "Command rejected",
  command_failed: "Command failed",
  workflow_proposed: "Workflow proposed",
  workflow_rejected: "Workflow rejected",
  workflow_failed: "Workflow failed",
};

function formatTime(ms: number): string {
  const d = new Date(ms);
  return Number.isFinite(d.getTime()) ? d.toLocaleString() : "";
}

function summarize(payload: string | null): string {
  if (!payload) return "";
  return payload.length > 120 ? `${payload.slice(0, 120)}…` : payload;
}

function triggerDownload(url: string) {
  const a = document.createElement("a");
  a.href = url;
  a.download = "";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export function ActivityView({ onClose }: { onClose?: () => void }) {
  const [windowKey, setWindowKey] = useState<string>("7d");
  const [category, setCategory] = useState<CategoryKey>("all");
  const [limit, setLimit] = useState(PAGE);
  const [showHelp, setShowHelp] = useState(false);

  const win = WINDOWS.find((w) => w.key === windowKey) ?? WINDOWS[1];
  const cat = CATEGORIES.find((c) => c.key === category) ?? CATEGORIES[0];
  const since = win.days != null ? Date.now() - win.days * DAY : undefined;

  const filters: AuditFilters = { types: cat.types, since, limit };
  const { data, isLoading, isError, refetch, isFetching } = useFleetAuditQuery(
    filters,
    true
  );
  const events = data?.events ?? [];
  const total = data?.total ?? 0;

  // Resetting the page size on a filter change avoids carrying a large limit across
  // a narrower filter (which would fetch more rows than the new view needs).
  const resetPaging = () => setLimit(PAGE);

  return (
    <div className="bg-background flex h-full min-h-0 w-full flex-col overflow-hidden">
      <div className="flex items-center justify-between gap-2 px-4 pt-2">
        <span className="flex min-w-0 items-center gap-2">
          <History className="h-4 w-4 flex-shrink-0" />
          <span className="text-sm font-medium">Activity</span>
          <span className="text-muted-foreground truncate text-xs">
            {total} event{total === 1 ? "" : "s"}
          </span>
        </span>
        <span className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            aria-label="Export as CSV"
            title="Export the filtered trail as CSV"
            disabled={total === 0}
            onClick={() => triggerDownload(auditExportUrl(filters, "csv"))}
          >
            <Download className="h-4 w-4" />
            CSV
          </Button>
          <Button
            variant="ghost"
            size="sm"
            aria-label="Export as JSON"
            title="Export the filtered trail as JSON"
            disabled={total === 0}
            onClick={() => triggerDownload(auditExportUrl(filters, "json"))}
          >
            JSON
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Refresh activity"
            title="Refresh"
            onClick={() => refetch()}
          >
            <RefreshCw
              className={isFetching ? "h-4 w-4 animate-spin" : "h-4 w-4"}
            />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={showHelp ? "Hide help" : "How Activity works"}
            title="How Activity works"
            onClick={() => setShowHelp((v) => !v)}
          >
            <HelpCircle className="h-4 w-4" />
          </Button>
          {onClose && (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Close Activity"
              title="Close Activity"
              onClick={onClose}
            >
              <X className="h-4 w-4" />
            </Button>
          )}
        </span>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 px-4 pb-2">
        <SegmentedTabs
          ariaLabel="Event category"
          value={category}
          onChange={(k: CategoryKey) => {
            setCategory(k);
            resetPaging();
          }}
          tabs={CATEGORIES.map((c) => ({ key: c.key, label: c.label }))}
        />
        <div className="flex items-center gap-1">
          {WINDOWS.map((w) => (
            <Button
              key={w.key}
              size="sm"
              variant={w.key === windowKey ? "secondary" : "ghost"}
              onClick={() => {
                setWindowKey(w.key);
                resetPaging();
              }}
            >
              {w.label}
            </Button>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-4 pb-4">
        {showHelp ? (
          <ActivityHelp onClose={() => setShowHelp(false)} />
        ) : isError ? (
          <p className="text-muted-foreground py-8 text-center text-sm">
            Couldn&apos;t load activity.
          </p>
        ) : isLoading ? (
          <p className="text-muted-foreground py-8 text-center text-sm">
            Loading…
          </p>
        ) : events.length === 0 ? (
          <p className="text-muted-foreground py-8 text-center text-sm">
            No events in this window.
          </p>
        ) : (
          <table className="w-full border-collapse text-xs">
            <thead className="bg-background text-muted-foreground sticky top-0 text-left">
              <tr>
                <th className="py-1 pr-3 font-medium">Time</th>
                <th className="py-1 pr-3 font-medium">Session</th>
                <th className="py-1 pr-3 font-medium">Event</th>
                <th className="py-1 font-medium">Detail</th>
              </tr>
            </thead>
            <tbody>
              {events.map((e) => (
                <tr key={e.id} className="border-border/50 border-t align-top">
                  <td
                    className="text-muted-foreground py-1 pr-3 whitespace-nowrap"
                    title={new Date(e.created_at).toISOString()}
                  >
                    {formatTime(e.created_at)}
                  </td>
                  <td
                    className="max-w-[12rem] truncate py-1 pr-3"
                    title={e.session_name ?? e.session_key}
                  >
                    {e.session_name ?? e.session_key}
                  </td>
                  <td className="py-1 pr-3 whitespace-nowrap">
                    {EVENT_LABEL[e.event_type] ?? e.event_type}
                  </td>
                  <td className="text-muted-foreground py-1 font-mono break-all">
                    {summarize(e.payload)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {!showHelp && events.length < total && limit < MAX_IN_VIEW && (
          <div className="pt-3 text-center">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setLimit((l) => Math.min(l + PAGE, MAX_IN_VIEW))}
            >
              Load more ({events.length} of {total})
            </Button>
          </div>
        )}
        {!showHelp && events.length >= MAX_IN_VIEW && total > MAX_IN_VIEW && (
          <p className="text-muted-foreground pt-3 text-center text-xs">
            Showing the newest {MAX_IN_VIEW} — export{" "}
            {total > AUDIT_EXPORT_MAX
              ? `the newest ${AUDIT_EXPORT_MAX.toLocaleString()}`
              : `all ${total.toLocaleString()}`}
            .
          </p>
        )}
      </div>
    </div>
  );
}
