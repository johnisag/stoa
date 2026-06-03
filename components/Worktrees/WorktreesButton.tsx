"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { GitBranch, Trash2, Loader2, AlertTriangle } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useConfirm } from "@/components/ConfirmProvider";

interface WorktreeRow {
  path: string;
  branch: string;
  projectId: string;
  projectName: string;
  attached: boolean;
  sessionId: string | null;
  sessionName: string | null;
  dirty: boolean;
  ahead: number;
  behind: number;
}

const baseName = (p: string) => p.split(/[/\\]/).filter(Boolean).pop() || p;

function WorktreeRowItem({
  wt,
  onReclaim,
  reclaiming,
}: {
  wt: WorktreeRow;
  onReclaim: (wt: WorktreeRow) => void;
  reclaiming: boolean;
}) {
  return (
    <div className="border-border flex items-center gap-3 rounded-md border px-3 py-2">
      <GitBranch className="text-muted-foreground h-4 w-4 flex-shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{wt.branch}</span>
          {wt.dirty && (
            <span
              className="inline-flex items-center gap-0.5 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-500"
              title="Uncommitted changes"
            >
              <AlertTriangle className="h-3 w-3" /> dirty
            </span>
          )}
          {(wt.ahead > 0 || wt.behind > 0) && (
            <span className="text-muted-foreground text-[10px]">
              {wt.ahead > 0 && `↑${wt.ahead}`}
              {wt.behind > 0 && ` ↓${wt.behind}`}
            </span>
          )}
        </div>
        <div className="text-muted-foreground truncate text-xs">
          {baseName(wt.path)}
          {wt.attached ? (
            <span className="text-primary"> · in use: {wt.sessionName}</span>
          ) : (
            <span className="text-amber-500/80"> · orphan</span>
          )}
        </div>
      </div>
      {!wt.attached && (
        <button
          type="button"
          onClick={() => onReclaim(wt)}
          disabled={reclaiming}
          className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive flex items-center gap-1 rounded px-2 py-1 text-xs transition-colors disabled:opacity-50"
          title="Remove worktree + delete branch"
        >
          {reclaiming ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Trash2 className="h-3.5 w-3.5" />
          )}
          Reclaim
        </button>
      )}
    </div>
  );
}

function WorktreesModal({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const confirm = useConfirm();
  const queryClient = useQueryClient();

  const { data, isLoading, isError } = useQuery({
    queryKey: ["worktrees"],
    queryFn: async (): Promise<{ worktrees: WorktreeRow[] }> => {
      const res = await fetch("/api/worktrees");
      if (!res.ok) throw new Error("Failed to load worktrees");
      return res.json();
    },
    enabled: open, // only hit git when the panel is open
  });

  const reclaim = useMutation({
    mutationFn: async (path: string) => {
      const res = await fetch("/api/worktrees", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || "Failed to reclaim worktree");
      return d;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["worktrees"] });
    },
  });

  const onReclaim = async (wt: WorktreeRow) => {
    const ok = await confirm({
      title: `Reclaim ${wt.branch}?`,
      description: (
        <>
          Removes the worktree at <code>{wt.path}</code> and deletes its branch{" "}
          <code>{wt.branch}</code>.
          {wt.dirty && (
            <span className="mt-1 block font-medium text-amber-500">
              ⚠ This worktree has uncommitted changes — they will be lost.
            </span>
          )}
          <span className="text-muted-foreground mt-1 block">
            This can&apos;t be undone.
          </span>
        </>
      ),
    });
    if (ok) reclaim.mutate(wt.path);
  };

  const worktrees = data?.worktrees ?? [];
  const orphans = worktrees.filter((w) => !w.attached).length;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[80vh] overflow-hidden sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Worktrees</DialogTitle>
          <DialogDescription>
            Git worktrees Stoa created. Orphans (no session) can be reclaimed to
            free disk + branches.
            {worktrees.length > 0 &&
              ` ${worktrees.length} total, ${orphans} orphaned.`}
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[60vh] space-y-2 overflow-y-auto pr-1">
          {isLoading && (
            <div className="text-muted-foreground flex items-center gap-2 py-6 text-sm">
              <Loader2 className="h-4 w-4 animate-spin" /> Scanning worktrees…
            </div>
          )}
          {isError && (
            <p className="py-6 text-sm text-red-500">
              Failed to load worktrees.
            </p>
          )}
          {!isLoading && !isError && worktrees.length === 0 && (
            <p className="text-muted-foreground py-6 text-sm">
              No worktrees yet. Create one from New Session → “Use a git
              worktree”.
            </p>
          )}
          {reclaim.isError && (
            <p className="text-sm text-red-500">
              {(reclaim.error as Error)?.message}
            </p>
          )}
          {worktrees.map((wt) => (
            <WorktreeRowItem
              key={wt.path}
              wt={wt}
              onReclaim={onReclaim}
              reclaiming={reclaim.isPending && reclaim.variables === wt.path}
            />
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Sidebar entry for the worktree reclaim panel. Self-contained (button + modal +
 * data + confirm) so it drops into the footer with no prop threading.
 */
export function WorktreesButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={() => setOpen(true)}
            aria-label="Worktrees"
            className="text-muted-foreground hover:text-foreground hover:bg-accent rounded p-1 transition-colors"
          >
            <GitBranch className="h-4 w-4" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="top">
          <p>Worktrees</p>
        </TooltipContent>
      </Tooltip>
      <WorktreesModal open={open} onOpenChange={setOpen} />
    </>
  );
}
