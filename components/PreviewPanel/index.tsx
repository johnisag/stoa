"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  X,
  Loader2,
  MousePointerClick,
  Send,
  Monitor,
  RefreshCw,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import {
  formatPreviewComment,
  normalizeLocator,
  describeLocator,
  type PreviewLocator,
} from "@/lib/diff-comment";
import {
  DEVICE_PRESETS,
  buildPickerScript,
  canInjectPicker,
  parsePickerMessage,
} from "@/lib/preview-picker";

/**
 * Embedded live app preview with click-to-comment (#28).
 *
 * Renders an iframe over a running worktree dev-server URL with a device-width
 * selector and an element-picker overlay. Picking an element captures a STRUCTURED
 * locator (tag + nearest id/data-testid + text + short DOM path) — never a
 * screenshot — which, together with the user's note, becomes a structured message
 * sent to the worker via the SAME send-keys path the diff review note uses
 * (lib/diff-comment.ts → /api/sessions/[id]/send-keys). No new transport.
 *
 * CROSS-ORIGIN LIMITATION: a browser will not let this parent page read or script
 * a cross-origin iframe, so the picker only works for a SAME-ORIGIN dev server
 * (canInjectPicker). For a cross-origin preview it degrades to a manual note — the
 * composer stays available; only the click-to-capture affordance is disabled.
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
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [deviceId, setDeviceId] = useState("full");
  const [picking, setPicking] = useState(false);
  const [locator, setLocator] = useState<PreviewLocator | null>(null);
  const [note, setNote] = useState("");
  const [sending, setSending] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  const device = useMemo(
    () => DEVICE_PRESETS.find((d) => d.id === deviceId) ?? DEVICE_PRESETS[3],
    [deviceId]
  );

  // Same-origin is a hard requirement for injecting/reading the framed document.
  // Compute once against the parent's own origin (never user input on that side).
  const canInject = useMemo(() => {
    if (typeof window === "undefined") return false;
    return canInjectPicker(previewUrl, window.location.origin);
  }, [previewUrl]);

  // Receive the captured locator from the injected picker script. Validate the
  // envelope + origin, then normalize every (untrusted DOM-derived) field before
  // it can reach the keystroke channel.
  useEffect(() => {
    function onMessage(e: MessageEvent) {
      if (typeof window === "undefined") return;
      if (e.origin !== window.location.origin) return; // same-origin only
      const msg = parsePickerMessage(e.data);
      if (!msg) return;
      setLocator(normalizeLocator(msg.locator));
      setPicking(false);
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  // Toggle the picker: inject (or stop) the picker script inside the same-origin
  // iframe. Wrapped in try/catch because contentWindow access throws for a
  // cross-origin document even when the URL looked same-origin (redirects).
  const togglePicker = () => {
    if (!canInject) return;
    const next = !picking;
    setPicking(next);
    const frame = iframeRef.current;
    try {
      const win = frame?.contentWindow;
      if (!win) return;
      if (next) {
        const script = win.document.createElement("script");
        script.textContent = buildPickerScript(window.location.origin);
        win.document.body.appendChild(script);
        script.remove();
      } else {
        const stopper = (
          win as unknown as { __stoaPicker?: { stop: () => void } }
        ).__stoaPicker;
        stopper?.stop();
      }
    } catch {
      // Cross-origin after a redirect — the picker can't run here.
      setPicking(false);
      toast.error("Element picker needs a same-origin dev server");
    }
  };

  const sendComment = async () => {
    if (sending || !note.trim()) return; // guard double-send
    // Cross-origin / no-pick fallback: a minimal manual locator so the message
    // still carries the page URL and a normalized shape (the note describes the
    // element by hand). normalizeLocator supplies the "element" tag fallback.
    const effectiveLocator: PreviewLocator =
      locator ?? normalizeLocator({ url: previewUrl });
    setSending(true);
    try {
      const text = formatPreviewComment({ locator: effectiveLocator, note });
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
      setLocator(null);
      setNote("");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSending(false);
    }
  };

  const clearDraft = () => {
    setLocator(null);
    setNote("");
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
          variant={picking ? "default" : "ghost"}
          size="sm"
          onClick={togglePicker}
          disabled={!canInject}
          title={
            canInject
              ? "Click an element in the preview to attach a note"
              : "Element picker needs a same-origin dev server"
          }
        >
          <MousePointerClick className="h-4 w-4" />
          {picking ? "Picking…" : "Pick element"}
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
            ref={iframeRef}
            src={previewUrl}
            title="Live preview"
            className="h-full w-full border-0"
            // Allow the framed app to run + navigate its own origin. Same-origin is
            // required for the picker; allow-scripts for the app itself.
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
          />
        </div>
      </div>

      {/* Cross-origin hint (manual-note fallback) */}
      {!canInject && (
        <div className="border-border text-muted-foreground border-t px-3 py-1.5 text-xs">
          Element picker is unavailable for a cross-origin preview — describe
          the element in the note below and send it manually.
        </div>
      )}

      {/* Note composer — appears once an element is picked (or always, for the
          cross-origin manual path once the user starts a note). */}
      {(locator || !canInject) && (
        <div className="border-border bg-background/95 safe-area-bottom border-t p-3 backdrop-blur-sm">
          <div className="mx-auto max-w-3xl space-y-2">
            {locator ? (
              <div className="text-muted-foreground text-xs">
                Note on{" "}
                <span className="text-foreground font-mono">
                  {describeLocator(locator)}
                </span>
                {locator.domPath ? (
                  <span className="text-muted-foreground/70 ml-1 font-mono">
                    · {locator.domPath}
                  </span>
                ) : null}
              </div>
            ) : (
              <div className="text-muted-foreground text-xs">
                Manual note (no element picked)
              </div>
            )}
            <Textarea
              autoFocus
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={
                locator
                  ? "Tell the agent what to change about this element…"
                  : "Describe the element and what to change…"
              }
              className="min-h-[60px]"
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                  e.preventDefault();
                  sendComment();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  clearDraft();
                }
              }}
            />
            <div className="flex items-center justify-end gap-2">
              {locator && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={clearDraft}
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
      )}
    </div>
  );
}
