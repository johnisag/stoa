"use client";

import { useMemo } from "react";
import { X, Loader2, GitCompare } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DiffFileList } from "@/components/DiffViewer/DiffFileList";
import { diffStats } from "@/lib/diff-parser";
import { useSessionDiff } from "@/hooks/useSessionDiff";

/**
 * Full-screen "what the agent changed" review for one session. Read-only —
 * Stage 1 of review & rewind.
 */
export function SessionDiffModal({
  sessionId,
  name,
  onClose,
}: {
  sessionId: string;
  name: string;
  onClose: () => void;
}) {
  const { data, isLoading, isError } = useSessionDiff(sessionId, true);
  const stats = useMemo(() => diffStats(data?.diff ?? ""), [data?.diff]);

  const subtitle =
    data?.supported === false
      ? "Not a git repository"
      : stats.files === 0
        ? "No changes"
        : `${stats.files} file${stats.files === 1 ? "" : "s"} · +${stats.additions} −${stats.deletions}${
            data?.baseRef ? ` vs ${data.baseRef}` : ""
          }`;

  return (
    <div
      className="bg-background fixed inset-0 z-50 flex flex-col"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="border-border bg-background/95 flex items-center gap-2 border-b p-3 backdrop-blur-sm">
        <GitCompare className="text-muted-foreground h-4 w-4 flex-shrink-0" />
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-medium">Changes · {name}</h3>
          <p className="text-muted-foreground text-xs">{subtitle}</p>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onClose}
          className="h-9 w-9"
          aria-label="Close diff"
        >
          <X className="h-5 w-5" />
        </Button>
      </div>

      <div className="flex-1 overflow-auto p-3">
        {isLoading ? (
          <div className="text-muted-foreground flex h-full items-center justify-center gap-2 text-sm">
            <Loader2 className="h-4 w-4 animate-spin" /> Computing diff…
          </div>
        ) : isError ? (
          <div className="text-muted-foreground flex h-full items-center justify-center text-sm">
            Couldn&apos;t load the diff.
          </div>
        ) : (
          <DiffFileList
            diff={data?.diff ?? ""}
            emptyLabel={
              data?.supported === false
                ? "This session isn't in a git repository."
                : "No changes yet."
            }
          />
        )}
      </div>
    </div>
  );
}
