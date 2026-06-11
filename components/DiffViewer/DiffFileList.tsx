"use client";

import { useMemo } from "react";
import { UnifiedDiff, type OnCommentLine } from "./UnifiedDiff";
import {
  parseDiff,
  getDiffFileName,
  splitUnifiedDiff,
} from "@/lib/diff-parser";

/**
 * Render a multi-file unified diff as one collapsible UnifiedDiff per file
 * (parseDiff/UnifiedDiff are single-file, so split first). Collapses by default
 * past a handful of files to keep the DOM + mobile manageable. Shared by the
 * session diff review and the snapshot timeline.
 */
export function DiffFileList({
  diff,
  emptyLabel = "No changes.",
  onCommentLine,
}: {
  diff: string;
  emptyLabel?: string;
  /** Opt-in: makes each diff line commentable (only the live-session review). */
  onCommentLine?: OnCommentLine;
}) {
  const files = useMemo(() => {
    if (!diff) return [];
    return splitUnifiedDiff(diff).map((chunk) => {
      const parsed = parseDiff(chunk);
      return { parsed, fileName: getDiffFileName(parsed) };
    });
  }, [diff]);

  if (files.length === 0) {
    return (
      <div className="text-muted-foreground py-8 text-center text-sm">
        {emptyLabel}
      </div>
    );
  }

  const expanded = files.length <= 5;
  return (
    <div className="space-y-2">
      {files.map((f, i) => (
        <UnifiedDiff
          // Include +/- in the key so navigating to a different diff with a
          // same-named file at the same index remounts (no expand-state bleed).
          key={`${f.fileName}-${i}-${f.parsed.additions}-${f.parsed.deletions}`}
          diff={f.parsed}
          fileName={f.fileName}
          expanded={expanded}
          onCommentLine={onCommentLine}
        />
      ))}
    </div>
  );
}
