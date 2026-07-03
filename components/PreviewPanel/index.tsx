"use client";

import { useMemo, useState } from "react";
import { X, Loader2, Send, Monitor, RefreshCw, HelpCircle } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import {
  formatPreviewComment,
  normalizeLocator,
  type PreviewLocator,
} from "@/lib/diff-comment";
import { DEVICE_PRESETS } from "@/lib/preview";
import { PreviewHelp } from "./PreviewHelp";

/**
 * Embedded live app preview (#28).
 *
 * Renders an iframe over a running worktree dev-server URL with a device-width
 * selector, and a composer that sends a STRUCTURED note (the page URL + the
 * user's text) to the worker via the SAME send-keys path the diff-review note
 * uses (lib/diff-comment.ts → /api/sessions/[id]/send-keys). No new transport.
 *
 * DEFERRED — click-to-comment element picker: capturing a clicked element needs
 * the framed dev server to be SAME-ORIGIN with Stoa (a browser won't let this
 * parent read/script a cross-origin frame), which is never true when the dev
 * server runs on its own port. That path awaits a same-origin dev-server proxy
 * (tracked as a separate roadmap item); for now the note is described by hand.
 */
export function PreviewPanel({
  sessionId,
  name,
  previewUrl,
  onClose,
}: {
  sessionId: string;
  name: string;
  previewUrl: string;
  onClose: () => void;
}) {
  const [deviceId, setDeviceId] = useState("full");
  const [note, setNote] = useState("");
  const [sending, setSending] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [showHelp, setShowHelp] = useState(false);

  const device = useMemo(
    () => DEVICE_PRESETS.find((d) => d.id === deviceId) ?? DEVICE_PRESETS[3],
    [deviceId]
  );

  const sendComment = async () => {
    if (sending || !note.trim()) return; // guard double-send
    // A minimal manual locator carries the page URL + a normalized shape; the
    // note describes the element by hand. normalizeLocator supplies the
    // "element" tag fallback and strips control bytes before the keystroke path.
    const locator: PreviewLocator = normalizeLocator({ url: previewUrl });
    setSending(true);
    try {
      const text = formatPreviewComment({ locator, note });
      const res = await fetch(`/api/sessions/${sessionId}/send-keys`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, pressEnter: true }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(
          res.status === 400
            ? "This session's agent isn't running"
            : d.error || "Couldn't reach the session"
        );
      }
      toast.success("Sent to the agent");
      setNote("");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSending(false);
    }
  };

  return (
    <div
      className="bg-background fixed inset-0 z-50 flex flex-col"
      onClick={(e) => e.stopPropagation()}
    >
      {/* Header + toolbar */}
      <div className="border-border bg-background/95 flex flex-wrap items-center gap-2 border-b p-3 backdrop-blur-sm">
        <Monitor className="text-muted-foreground h-4 w-4 flex-shrink-0" />
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-medium">Preview · {name}</h3>
          <p className="text-muted-foreground truncate font-mono text-xs">
            {previewUrl}
          </p>
        </div>

        {/* Device-width selector */}
        <div className="bg-muted/40 flex items-center gap-0.5 rounded-md p-0.5">
          {DEVICE_PRESETS.map((d) => (
            <button
              key={d.id}
              onClick={() => setDeviceId(d.id)}
              className={cn(
                "rounded px-2 py-1 text-xs font-medium transition-colors",
                deviceId === d.id
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              {d.label}
            </button>
          ))}
        </div>

        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => setReloadKey((k) => k + 1)}
          className="h-9 w-9"
          aria-label="Reload preview"
          title="Reload preview"
        >
          <RefreshCw className="h-4 w-4" />
        </Button>

        <Button
          variant={showHelp ? "default" : "ghost"}
          size="icon-sm"
          onClick={() => setShowHelp((v) => !v)}
          className="h-9 w-9"
          aria-label="How the live preview works"
          title="How the live preview works"
        >
          <HelpCircle className="h-4 w-4" />
        </Button>

        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onClose}
          className="h-9 w-9"
          aria-label="Close preview"
        >
          <X className="h-5 w-5" />
        </Button>
      </div>

      {showHelp ? (
        <div className="flex-1 overflow-auto px-4">
          <PreviewHelp onClose={() => setShowHelp(false)} />
        </div>
      ) : (
        <>
          {/* Iframe stage */}
          <div className="bg-muted/20 flex flex-1 justify-center overflow-auto p-3">
            <div
              className="border-border bg-background h-full overflow-hidden rounded-md border shadow-sm"
              style={{
                width: device.width ? `${device.width}px` : "100%",
                maxWidth: "100%",
              }}
            >
              <iframe
                key={reloadKey}
                src={previewUrl}
                title="Live preview"
                className="h-full w-full border-0"
                // Run the framed app with its own origin (so it works normally),
                // but deny popups and modal dialogs so a misbehaving dev bundle
                // can't spawn windows or trap the operator. allow-forms keeps the
                // previewed app interactive.
                sandbox="allow-scripts allow-same-origin allow-forms"
              />
            </div>
          </div>

          {/* Note composer — always available (describe the element by hand). */}
          <div className="border-border bg-background/95 safe-area-bottom border-t p-3 backdrop-blur-sm">
            <div className="mx-auto max-w-3xl space-y-2">
              <div className="text-muted-foreground text-xs">
                Send a note to the agent about this page
              </div>
              <Textarea
                autoFocus
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Describe what to change (which element, and how)…"
                className="min-h-[60px]"
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                    e.preventDefault();
                    sendComment();
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    setNote("");
                  }
                }}
              />
              <div className="flex items-center justify-end gap-2">
                {note && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setNote("")}
                    disabled={sending}
                  >
                    Clear
                  </Button>
                )}
                <Button
                  size="sm"
                  onClick={sendComment}
                  disabled={sending || !note.trim()}
                >
                  {sending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Send className="h-4 w-4" />
                  )}
                  Send to agent
                </Button>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
