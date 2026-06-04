"use client";

import { useState } from "react";
import { X, ChevronLeft, History, Camera, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DiffFileList } from "@/components/DiffViewer/DiffFileList";
import {
  useSessionSnapshots,
  useCreateCheckpoint,
  useSnapshotDiff,
} from "@/hooks/useSessionSnapshots";

function ago(iso: string): string {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/**
 * Per-turn snapshot timeline for a session: browse the working-tree snapshots
 * captured at each turn boundary (opt-in via STOA_SNAPSHOTS) or on demand via
 * "Checkpoint now", and view the diff each one introduced. Read-only — restore/
 * rewind is a later stage.
 */
export function SnapshotTimeline({
  sessionId,
  name,
  onClose,
}: {
  sessionId: string;
  name: string;
  onClose: () => void;
}) {
  const { data: snapshots, isLoading } = useSessionSnapshots(sessionId, true);
  const checkpoint = useCreateCheckpoint(sessionId);
  const [selectedSeq, setSelectedSeq] = useState<number | null>(null);
  const { data: diff, isLoading: diffLoading } = useSnapshotDiff(
    sessionId,
    selectedSeq
  );

  // Newest first for display.
  const rows = (snapshots ?? []).slice().reverse();
  const selected = rows.find((s) => s.seq === selectedSeq) ?? null;

  return (
    <div
      className="bg-background fixed inset-0 z-50 flex flex-col"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="border-border bg-background/95 flex items-center gap-2 border-b p-3 backdrop-blur-sm">
        {selected ? (
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => setSelectedSeq(null)}
            className="h-9 w-9"
            aria-label="Back to timeline"
          >
            <ChevronLeft className="h-5 w-5" />
          </Button>
        ) : (
          <History className="text-muted-foreground h-4 w-4 flex-shrink-0" />
        )}
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-medium">
            {selected ? `Turn ${selected.seq}` : `Turn history · ${name}`}
          </h3>
          <p className="text-muted-foreground truncate text-xs">
            {selected
              ? selected.summary
              : `${rows.length} snapshot${rows.length === 1 ? "" : "s"}`}
          </p>
        </div>
        {!selected && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => checkpoint.mutate()}
            disabled={checkpoint.isPending}
            className="h-9"
          >
            {checkpoint.isPending ? (
              <Loader2 className="mr-1 h-4 w-4 animate-spin" />
            ) : (
              <Camera className="mr-1 h-4 w-4" />
            )}
            Checkpoint
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onClose}
          className="h-9 w-9"
          aria-label="Close history"
        >
          <X className="h-5 w-5" />
        </Button>
      </div>

      <div className="flex-1 overflow-auto p-3">
        {selected ? (
          diffLoading ? (
            <div className="text-muted-foreground flex h-full items-center justify-center gap-2 text-sm">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading diff…
            </div>
          ) : (
            <DiffFileList
              diff={diff ?? ""}
              emptyLabel="No file changes in this turn."
            />
          )
        ) : isLoading ? (
          <div className="text-muted-foreground flex h-full items-center justify-center gap-2 text-sm">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </div>
        ) : rows.length === 0 ? (
          <div className="text-muted-foreground mx-auto max-w-sm py-10 text-center text-sm">
            No snapshots yet. Tap{" "}
            <span className="font-medium">Checkpoint</span> to capture the
            working tree now, or set{" "}
            <code className="text-xs">STOA_SNAPSHOTS=1</code> to snapshot
            automatically at each turn.
          </div>
        ) : (
          <ul className="space-y-1">
            {rows.map((s) => (
              <li key={s.seq}>
                <button
                  onClick={() => setSelectedSeq(s.seq)}
                  className="hover:bg-accent/50 flex min-h-[44px] w-full items-center gap-3 rounded-md px-3 py-2 text-left transition-colors"
                >
                  <span className="text-muted-foreground w-12 flex-shrink-0 text-xs tabular-nums">
                    #{s.seq}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm">
                    {s.summary || "checkpoint"}
                  </span>
                  {s.date && (
                    <span className="text-muted-foreground flex-shrink-0 text-[10px]">
                      {ago(s.date)}
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
