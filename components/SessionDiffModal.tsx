"use client";

import { useMemo, useState } from "react";
import { X, Loader2, GitCompare, Send } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { DiffFileList } from "@/components/DiffViewer/DiffFileList";
import { diffStats } from "@/lib/diff-parser";
import { formatReviewComment } from "@/lib/diff-comment";
import { useSessionDiff } from "@/hooks/useSessionDiff";

interface CommentDraft {
  file: string;
  line: number | null;
  content: string;
}

/**
 * Full-screen "what the agent changed" review for one session. Tap a line's
 * comment icon to send a review note straight to the agent's next turn (the
 * missing half of the review loop — feedback in, not just read-out).
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
  const [draft, setDraft] = useState<CommentDraft | null>(null);
  const [comment, setComment] = useState("");
  const [sending, setSending] = useState(false);

  const sendComment = async () => {
    if (sending || !draft || !comment.trim()) return; // guard key-repeat double-send
    setSending(true);
    try {
      const res = await fetch(`/api/sessions/${sessionId}/send-keys`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: formatReviewComment(
            draft.file,
            draft.line,
            draft.content,
            comment
          ),
          pressEnter: true,
        }),
      });
      if (!res.ok) {
        // The route's raw message is backend jargon ("Tmux session not running")
        // and wrong on Windows (pty) — show a neutral one for the common case.
        const d = await res.json().catch(() => ({}));
        throw new Error(
          res.status === 400
            ? "This session's agent isn't running"
            : d.error || "Couldn't reach the session"
        );
      }
      toast.success("Sent to the agent");
      setDraft(null);
      setComment("");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSending(false);
    }
  };

  const cancelDraft = () => {
    setDraft(null);
    setComment("");
  };

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
          <p className="text-muted-foreground truncate text-xs">{subtitle}</p>
          {stats.files > 0 && (
            <p className="text-muted-foreground/80 truncate text-xs">
              Tap a line&apos;s icon to send the agent a note.
            </p>
          )}
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
            sessionId={sessionId}
            emptyLabel={
              data?.supported === false
                ? "This session isn't in a git repository."
                : "No changes yet."
            }
            // Retarget the draft to the tapped line but KEEP any in-progress text
            // (the icons sit in thumb-scroll territory on a phone). Text is cleared
            // only on send/cancel.
            onCommentLine={(file, line, content) =>
              setDraft({ file, line, content })
            }
          />
        )}
      </div>

      {/* Review-note composer: routes a line comment to the agent's next turn. */}
      {draft && (
        <div className="border-border bg-background/95 safe-area-bottom border-t p-3 backdrop-blur-sm">
          <div className="mx-auto max-w-3xl space-y-2">
            <div className="text-muted-foreground text-xs">
              Note on{" "}
              <span className="text-foreground font-mono">{draft.file}</span>
              {draft.line ? ` · line ${draft.line}` : ""}
            </div>
            {draft.content.trim() && (
              <pre className="bg-muted/50 text-muted-foreground truncate rounded px-2 py-1 font-mono text-xs">
                {draft.content.trim()}
              </pre>
            )}
            <Textarea
              autoFocus
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder="Tell the agent what to change here…"
              className="min-h-[60px]"
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                  e.preventDefault();
                  sendComment();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  cancelDraft();
                }
              }}
            />
            <div className="flex items-center justify-end gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={cancelDraft}
                disabled={sending}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={sendComment}
                disabled={sending || !comment.trim()}
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
