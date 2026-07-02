"use client";

import { X } from "lucide-react";
import { Button } from "@/components/ui/button";

/** In-app help panel explaining the Best-of-N feature. */
export function BestOfNHelp({ onClose }: { onClose: () => void }) {
  return (
    <div
      role="region"
      aria-label="How Best of N works"
      className="flex flex-col gap-4 text-sm"
    >
      <div className="flex items-start justify-between gap-2">
        <h3 className="font-medium">How Best of N works</h3>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Close help"
          onClick={onClose}
        >
          <X className="h-4 w-4" />
        </Button>
      </div>

      <ol className="text-muted-foreground flex flex-col gap-3 leading-relaxed">
        <li>
          <span className="text-foreground font-medium">
            1. N parallel attempts.
          </span>{" "}
          Two or three Claude agents each tackle the same task independently in
          their own git worktree on a unique branch. They run concurrently — no
          one waits for another.
        </li>
        <li>
          <span className="text-foreground font-medium">
            2. Compare the diffs.
          </span>{" "}
          Once all agents finish, this view shows each candidate&apos;s git diff
          — files changed, lines added, lines removed. Switch between candidates
          with the tabs. Read the diffs to see which approach you prefer.
        </li>
        <li>
          <span className="text-foreground font-medium">3. Pick a winner.</span>{" "}
          Tap{" "}
          <span className="text-foreground font-medium">Pick this winner</span>{" "}
          on the candidate you want to keep. The other agents&apos; sessions and
          worktrees are cleaned up automatically. The winning session stays open
          so you can commit, push, or continue iterating in its terminal.
        </li>
        <li>
          <span className="text-foreground font-medium">
            4. Cancel anytime.
          </span>{" "}
          Use the Cancel button in the header to stop all agents and clean up
          all worktrees before a winner is picked.
        </li>
      </ol>

      <p className="text-muted-foreground text-xs leading-relaxed">
        Best of N is best used for self-contained tasks where the quality of the
        output is hard to predict in advance — bug fixes, refactors, or new
        features where multiple valid approaches exist. Diffs are captured once
        the agents finish; if an agent&apos;s diff is empty it may still be
        working or may have produced no file changes.
      </p>
    </div>
  );
}
