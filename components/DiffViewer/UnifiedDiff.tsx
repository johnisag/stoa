"use client";

import { useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Plus,
  Minus,
  MessageSquarePlus,
  Check,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { ParsedDiff, DiffHunk, DiffLine } from "@/lib/diff-parser";

/** Opt-in: comment on a diff line (file, line number, line content). When set,
 * each line gets a comment affordance; omitted = a plain read-only diff. */
export type OnCommentLine = (
  file: string,
  line: number | null,
  content: string
) => void;

interface UnifiedDiffProps {
  diff: ParsedDiff;
  fileName: string;
  expanded?: boolean;
  onToggle?: () => void;
  onCommentLine?: OnCommentLine;
  /** Opt-in (multi-file review): whether this file is marked "viewed". */
  viewed?: boolean;
  /** Opt-in: flip the "viewed" flag for this file. Adds the tick affordance. */
  onToggleViewed?: () => void;
}

export function UnifiedDiff({
  diff,
  fileName,
  expanded = true,
  onToggle,
  onCommentLine,
  viewed = false,
  onToggleViewed,
}: UnifiedDiffProps) {
  const [localExpanded, setLocalExpanded] = useState(expanded);
  // A viewed file collapses regardless of the local toggle so the list reads as
  // "ticked off". Clicking its header un-views it (see handleToggle), which
  // re-expands — so the header chevron is never a dead control.
  const isExpanded = (onToggle ? expanded : localExpanded) && !viewed;

  const handleToggle = () => {
    // Header click on a viewed file = un-view it (re-expands), not a hidden no-op.
    if (viewed && onToggleViewed) {
      onToggleViewed();
      return;
    }
    if (onToggle) {
      onToggle();
    } else {
      setLocalExpanded(!localExpanded);
    }
  };

  return (
    <div
      className={cn(
        "border-border overflow-hidden rounded-lg border transition-opacity",
        viewed && "opacity-50"
      )}
    >
      {/* File header */}
      <div className="bg-muted/50 flex items-center">
        <button
          onClick={handleToggle}
          className={cn(
            "flex min-w-0 flex-1 items-center gap-2 px-3 py-2.5 text-sm",
            "hover:bg-muted text-left transition-colors",
            "min-h-[44px]" // Mobile touch target
          )}
        >
          {isExpanded ? (
            <ChevronDown className="text-muted-foreground h-4 w-4 flex-shrink-0" />
          ) : (
            <ChevronRight className="text-muted-foreground h-4 w-4 flex-shrink-0" />
          )}

          <span className="flex-1 truncate font-mono text-xs">{fileName}</span>

          {/* Stats */}
          <span className="flex flex-shrink-0 items-center gap-2 text-xs">
            {diff.additions > 0 && (
              <span className="flex items-center gap-0.5 text-green-500">
                <Plus className="h-3 w-3" />
                {diff.additions}
              </span>
            )}
            {diff.deletions > 0 && (
              <span className="flex items-center gap-0.5 text-red-500">
                <Minus className="h-3 w-3" />
                {diff.deletions}
              </span>
            )}
          </span>
        </button>

        {/* "Viewed" tick (opt-in). Sits outside the collapse button so ticking
            a file off doesn't also toggle its expand state. */}
        {onToggleViewed && (
          <button
            type="button"
            onClick={onToggleViewed}
            role="checkbox"
            aria-checked={viewed}
            aria-label={viewed ? "Mark as not viewed" : "Mark as viewed"}
            title={viewed ? "Mark as not viewed" : "Mark as viewed"}
            // 44px tap target (mobile-first) around a 24px visual box.
            className="flex h-11 w-11 flex-shrink-0 items-center justify-center"
          >
            <span
              className={cn(
                "flex h-6 w-6 items-center justify-center rounded border transition-colors",
                viewed
                  ? "border-green-500 bg-green-500/20 text-green-500"
                  : "border-border text-muted-foreground/50 hover:border-muted-foreground/50 hover:text-muted-foreground"
              )}
            >
              <Check className={cn("h-4 w-4", !viewed && "opacity-0")} />
            </span>
          </button>
        )}
      </div>

      {/* Diff content */}
      {isExpanded && (
        <div className="overflow-x-auto">
          {diff.isBinary ? (
            <div className="text-muted-foreground px-4 py-8 text-center text-sm">
              Binary file not shown
            </div>
          ) : diff.hunks.length === 0 ? (
            <div className="text-muted-foreground px-4 py-8 text-center text-sm">
              No changes
            </div>
          ) : (
            <div className="font-mono text-xs">
              {diff.hunks.map((hunk, index) => (
                <Hunk
                  key={index}
                  hunk={hunk}
                  onComment={
                    onCommentLine
                      ? (line) => {
                          // Prefix the diff marker so a deletion reads "> - old"
                          // (the agent shouldn't hunt the current file for it).
                          const mark =
                            line.type === "addition"
                              ? "+ "
                              : line.type === "deletion"
                                ? "- "
                                : "";
                          onCommentLine(
                            fileName,
                            line.newLineNumber ?? line.oldLineNumber,
                            mark + line.content
                          );
                        }
                      : undefined
                  }
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

interface HunkProps {
  hunk: DiffHunk;
  onComment?: (line: DiffLine) => void;
}

function Hunk({ hunk, onComment }: HunkProps) {
  return (
    <div>
      {/* Hunk header */}
      <div className="border-border border-y bg-blue-500/10 px-3 py-1 text-xs text-blue-400">
        {hunk.header}
      </div>

      {/* Lines */}
      <table className="w-full border-collapse">
        <tbody>
          {hunk.lines.map((line, index) => (
            <DiffLineRow key={index} line={line} onComment={onComment} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

interface DiffLineRowProps {
  line: DiffLine;
  onComment?: (line: DiffLine) => void;
}

function DiffLineRow({ line, onComment }: DiffLineRowProps) {
  const bgColor = getLineBgColor(line.type);
  const textColor = getLineTextColor(line.type);

  // Skip header lines in the main content
  if (line.type === "header") {
    return null;
  }

  return (
    <tr className={cn("group hover:bg-muted/30", bgColor)}>
      {/* Comment affordance (opt-in) — faint always (mobile has no hover),
          brightens on hover/focus. Sends a review note to the agent. */}
      {onComment && (
        <td className="w-9 text-center align-middle select-none">
          <button
            type="button"
            onClick={() => onComment(line)}
            aria-label="Comment on this line"
            title="Send the agent a note about this line"
            // p-2 gives a ~30px touch target (mobile mandate) without growing the
            // row; group-hover brightens it from anywhere on the row (desktop).
            className="text-muted-foreground/40 group-hover:text-muted-foreground hover:text-foreground focus:text-foreground p-2 transition-colors"
          >
            <MessageSquarePlus className="h-3.5 w-3.5" />
          </button>
        </td>
      )}

      {/* Old line number */}
      <td className="text-muted-foreground border-border/50 w-12 border-r px-2 py-0.5 text-right tabular-nums select-none">
        {line.oldLineNumber || ""}
      </td>

      {/* New line number */}
      <td className="text-muted-foreground border-border/50 w-12 border-r px-2 py-0.5 text-right tabular-nums select-none">
        {line.newLineNumber || ""}
      </td>

      {/* Line marker */}
      <td className={cn("w-6 px-1 py-0.5 text-center select-none", textColor)}>
        {getLineMarker(line.type)}
      </td>

      {/* Content */}
      <td className={cn("px-2 py-0.5 whitespace-pre", textColor)}>
        {line.content || " "}
      </td>
    </tr>
  );
}

function getLineBgColor(type: DiffLine["type"]): string {
  switch (type) {
    case "addition":
      return "bg-green-500/10";
    case "deletion":
      return "bg-red-500/10";
    default:
      return "";
  }
}

function getLineTextColor(type: DiffLine["type"]): string {
  switch (type) {
    case "addition":
      return "text-green-400";
    case "deletion":
      return "text-red-400";
    default:
      return "text-foreground";
  }
}

function getLineMarker(type: DiffLine["type"]): string {
  switch (type) {
    case "addition":
      return "+";
    case "deletion":
      return "-";
    default:
      return "";
  }
}
