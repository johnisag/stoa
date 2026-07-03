"use client";

import { Terminal as TerminalIcon, ChevronRight, Bot } from "lucide-react";
import { cn } from "@/lib/utils";
import type { TerminalBlockKind } from "@/lib/terminal-blocks";

export interface CommandBlockHeaderState {
  /** 1-based position of the current block, for the "3 / 12" affordance. */
  index: number;
  /** Total blocks detected in the buffer. */
  total: number;
  /** Display label of the current block (already truncated). */
  label: string;
  /** How the block boundary was recognized (drives the icon). */
  kind: TerminalBlockKind;
}

interface CommandBlockHeaderProps {
  state: CommandBlockHeaderState | null;
  /** Hidden until the user first jumps, so it doesn't clutter a fresh terminal. */
  visible: boolean;
}

/**
 * Sticky "current command block" header (#53). A thin, non-interactive strip
 * pinned to the top of the terminal that names the block the viewport is scrolled
 * into — the Warp-style breadcrumb for prompt-boundary navigation. Purely
 * presentational: state is computed in the Terminal host from the pure parser
 * (lib/terminal-blocks) and passed in.
 */
export function CommandBlockHeader({
  state,
  visible,
}: CommandBlockHeaderProps) {
  if (!visible || !state) return null;
  const Icon =
    state.kind === "agent"
      ? Bot
      : state.kind === "shell"
        ? ChevronRight
        : TerminalIcon;
  return (
    // An in-flow strip (a flex sibling ABOVE the terminal, like the search bar),
    // NOT an absolute overlay: it reserves its own height so a jumped-to prompt
    // line lands just below it instead of hidden underneath. The container's
    // ResizeObserver refits xterm to the slightly shorter height.
    <div
      className={cn(
        "border-border/60 bg-background/85 text-muted-foreground pointer-events-none z-20 shrink-0",
        "flex items-center gap-1.5 border-b px-3 py-1 text-xs backdrop-blur-sm"
      )}
      aria-hidden="true"
    >
      <Icon className="h-3.5 w-3.5 shrink-0" />
      <span className="truncate font-mono">{state.label}</span>
      {state.total > 1 && (
        <span className="ml-auto shrink-0 tabular-nums opacity-70">
          {state.index} / {state.total}
        </span>
      )}
    </div>
  );
}
