"use client";

import { Fragment } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatChord, isMacPlatform } from "@/lib/keybindings";

interface Shortcut {
  chord: string;
  description: string;
}

const BUILDER_SHORTCUTS: Shortcut[] = [
  { chord: "mod+z", description: "Undo the last edit" },
  { chord: "mod+shift+z", description: "Redo an undone edit" },
  { chord: "mod+a", description: "Select all items" },
  { chord: "mod+d", description: "Duplicate the selected step(s)" },
  { chord: "Delete", description: "Delete selected item(s)" },
  { chord: "Escape", description: "Clear selection" },
  { chord: "mod+shift+l", description: "Show this shortcut legend" },
];

/** Canvas shortcut legend for the visual workflow builder. */
export function WorkflowsShortcuts({ onClose }: { onClose: () => void }) {
  const isMac = isMacPlatform();
  return (
    <div
      role="region"
      aria-label="Workflow builder shortcuts"
      className="flex flex-col gap-4 text-sm"
    >
      <div className="flex items-start justify-between gap-2">
        <h3 className="font-medium">Workflow builder shortcuts</h3>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Close shortcuts"
          onClick={onClose}
        >
          <X className="h-4 w-4" />
        </Button>
      </div>

      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-xs">
        {BUILDER_SHORTCUTS.map(({ chord, description }) => (
          <Fragment key={chord}>
            <dt className="text-foreground font-mono font-medium">
              {formatChord(chord, isMac)}
            </dt>
            <dd className="text-muted-foreground">{description}</dd>
          </Fragment>
        ))}
      </dl>

      <p className="text-muted-foreground text-xs leading-relaxed">
        Shortcuts are disabled while typing in a field. Mouse: click an item to
        edit it, Shift+click (or drag a lasso) to multi-select, drag a
        node&apos;s right-hand dot onto another to connect them, and click an
        edge to remove it. Touch: long-press a step for Duplicate, Copy id, and
        Delete, or a note for Delete. Edges can also be removed from the
        selected step&apos;s Depends on list.
      </p>
    </div>
  );
}
