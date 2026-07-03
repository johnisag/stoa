"use client";

import { X, Monitor, Send, Smartphone } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * In-panel primer for the live preview. Toggled by the header "?" — mirrors the
 * repo's *Help convention (ChatHelp / DispatchHelp / WorkflowsHelp). Explains the
 * non-obvious bits: it embeds the session's own dev server, the device selector
 * is width-only, and the composer sends a STRUCTURED note (page URL + your text)
 * straight into the agent's terminal (Cmd/Ctrl+Enter to send, Esc to clear).
 */
export function PreviewHelp({ onClose }: { onClose: () => void }) {
  return (
    <div
      role="region"
      aria-label="How the live preview works"
      className="mx-auto max-w-2xl space-y-5 py-4 text-sm"
    >
      <div className="flex items-start justify-between gap-2">
        <h3 className="text-base font-semibold">How the live preview works</h3>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Close help"
          onClick={onClose}
        >
          <X className="h-4 w-4" />
        </Button>
      </div>

      <p className="text-muted-foreground leading-relaxed">
        This embeds the session&apos;s running dev server in a frame so you can
        see the app your agent is building. The URL in the header is the
        project&apos;s configured dev-server port on localhost — start that
        server for the session if the frame shows a connection error, then hit
        Reload.
      </p>

      <section className="space-y-2">
        <h4 className="text-foreground flex items-center gap-2 font-medium">
          <Smartphone className="h-4 w-4" aria-hidden="true" /> Check it at a
          device width
        </h4>
        <p className="text-muted-foreground text-xs leading-relaxed">
          The Phone / Tablet / Desktop / Full buttons only change the
          frame&apos;s <span className="text-foreground">width</span> so you can
          eyeball responsive layout — they don&apos;t emulate a real device.
        </p>
      </section>

      <section className="space-y-2">
        <h4 className="text-foreground flex items-center gap-2 font-medium">
          <Send className="h-4 w-4" aria-hidden="true" /> Send a note to the
          agent
        </h4>
        <p className="text-muted-foreground text-xs leading-relaxed">
          Describe what to change in the composer and Send — it becomes a
          structured message (the page URL plus your note) typed straight into
          the agent&apos;s terminal, the same channel a diff-review note uses.{" "}
          <span className="text-foreground">Cmd/Ctrl+Enter</span> sends ·{" "}
          <span className="text-foreground">Esc</span> clears.
        </p>
      </section>

      <section className="bg-muted/30 space-y-1.5 rounded-lg p-3">
        <h4 className="text-foreground flex items-center gap-2 font-medium">
          <Monitor className="h-4 w-4" aria-hidden="true" /> Click-to-comment is
          coming
        </h4>
        <p className="text-muted-foreground text-xs leading-relaxed">
          Clicking an element to attach a note needs the preview to be served
          from Stoa&apos;s own origin (a dev-server proxy), which isn&apos;t
          wired yet — for now, describe the element in your note. The frame is
          sandboxed and only your own worktree&apos;s app runs inside it.
        </p>
      </section>
    </div>
  );
}
