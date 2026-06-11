"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { UnifiedDiff, type OnCommentLine } from "./UnifiedDiff";
import {
  parseDiff,
  getDiffFileName,
  splitUnifiedDiff,
} from "@/lib/diff-parser";
import { getViewedFiles, toggleFileViewed } from "@/lib/diff-viewed";

/**
 * Render a multi-file unified diff as one collapsible UnifiedDiff per file
 * (parseDiff/UnifiedDiff are single-file, so split first). Collapses by default
 * past a handful of files to keep the DOM + mobile manageable. Shared by the
 * session diff review and the snapshot timeline.
 *
 * Pass `sessionId` to enable per-file "viewed" ticks: tick a file off in a big
 * change and it dims + collapses, with the set persisted in localStorage keyed
 * by (session + path) so it survives a reload.
 */
export function DiffFileList({
  diff,
  emptyLabel = "No changes.",
  onCommentLine,
  sessionId,
}: {
  diff: string;
  emptyLabel?: string;
  /** Opt-in: makes each diff line commentable (only the live-session review). */
  onCommentLine?: OnCommentLine;
  /** Opt-in: enables persisted per-file "viewed" ticks scoped to this session. */
  sessionId?: string;
}) {
  const files = useMemo(() => {
    if (!diff) return [];
    return splitUnifiedDiff(diff).map((chunk) => {
      const parsed = parseDiff(chunk);
      return { parsed, fileName: getDiffFileName(parsed) };
    });
  }, [diff]);

  // Viewed set is loaded in an effect (not initial state) to stay SSR-safe —
  // localStorage doesn't exist on the server. Empty until hydrated.
  const [viewed, setViewed] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    if (!sessionId || typeof window === "undefined") return;
    setViewed(getViewedFiles(window.localStorage, sessionId));
  }, [sessionId]);

  const toggleViewed = useCallback(
    (path: string) => {
      if (!sessionId || typeof window === "undefined") return;
      setViewed(toggleFileViewed(window.localStorage, sessionId, path));
    },
    [sessionId]
  );

  if (files.length === 0) {
    return (
      <div className="text-muted-foreground py-8 text-center text-sm">
        {emptyLabel}
      </div>
    );
  }

  const expanded = files.length <= 5;
  const viewedCount = sessionId
    ? files.filter((f) => viewed.has(f.fileName)).length
    : 0;

  return (
    <div className="space-y-2">
      {sessionId && files.length > 1 && (
        <div className="text-muted-foreground px-1 text-xs">
          {viewedCount} of {files.length} viewed
        </div>
      )}
      {files.map((f, i) => (
        <UnifiedDiff
          // Include +/- in the key so navigating to a different diff with a
          // same-named file at the same index remounts (no expand-state bleed).
          key={`${f.fileName}-${i}-${f.parsed.additions}-${f.parsed.deletions}`}
          diff={f.parsed}
          fileName={f.fileName}
          expanded={expanded}
          onCommentLine={onCommentLine}
          viewed={sessionId ? viewed.has(f.fileName) : undefined}
          onToggleViewed={
            sessionId ? () => toggleViewed(f.fileName) : undefined
          }
        />
      ))}
    </div>
  );
}
