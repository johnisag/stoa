"use client";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { formatChord, isMacPlatform, type Keybinding } from "@/lib/keybindings";

interface ShortcutsHelpProps {
  bindings: Keybinding[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Keyboard-shortcut cheatsheet. Renders straight from the keybinding list (the
 * single source of truth), so it can never drift from what's actually wired.
 * Each chord is shown with platform glyphs (⌘/⌥/⇧ on macOS, Ctrl/Alt/Shift else).
 */
export function ShortcutsHelp({
  bindings,
  open,
  onOpenChange,
}: ShortcutsHelpProps) {
  const isMac = isMacPlatform();
  const rows = bindings.filter((b) => b.description);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-0.5 py-1">
          {rows.map((b) => (
            <div
              key={`${b.action}-${b.chord}`}
              className="flex items-center justify-between gap-4 rounded-md px-2 py-1.5 text-sm"
            >
              <span className="text-muted-foreground">{b.description}</span>
              <kbd className="bg-muted rounded px-2 py-0.5 font-mono text-xs whitespace-nowrap">
                {formatChord(b.chord, isMac)}
              </kbd>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
