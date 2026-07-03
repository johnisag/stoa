"use client";

import { useState } from "react";
import {
  X,
  ChevronLeft,
  History,
  Camera,
  Loader2,
  RotateCcw,
  Pencil,
  Send,
  GitFork,
  Tag,
  HelpCircle,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { DiffFileList } from "@/components/DiffViewer/DiffFileList";
import {
  useSessionSnapshots,
  useSessionCheckpoints,
  useCreateCheckpoint,
  useForkFromSnapshot,
  useSnapshotDiff,
  useRestoreSnapshot,
  type CheckpointView,
} from "@/hooks/useSessionSnapshots";
import { normalizeEditedPrompt } from "@/lib/snapshot-prompt";

function ago(iso: string): string {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

// Kind → badge styling. Kinds come from lib/checkpoints (manual/auto/safety/
// fork-origin); an unknown kind degrades to the neutral style.
const KIND_BADGE: Record<string, { label: string; className: string }> = {
  manual: { label: "checkpoint", className: "bg-primary/15 text-primary" },
  "fork-origin": {
    label: "forked",
    className: "bg-violet-500/15 text-violet-500 dark:text-violet-400",
  },
  safety: {
    label: "safety",
    className: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  },
  auto: { label: "auto", className: "bg-muted text-muted-foreground" },
};

function KindBadge({ kind }: { kind: string }) {
  const b = KIND_BADGE[kind] ?? {
    label: kind,
    className: "bg-muted text-muted-foreground",
  };
  return (
    <span
      className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${b.className}`}
    >
      {b.label}
    </span>
  );
}

/**
 * Per-turn snapshot timeline for a session, with a durable CHECKPOINT layer
 * (#44): browse the working-tree snapshots captured at each turn boundary
 * (opt-in via STOA_SNAPSHOTS) or on demand, pin durable labeled checkpoints,
 * view the diff each turn introduced, rewind to one, "Edit & re-run" from it,
 * or "Fork from here" into a new isolated session branched at that point.
 */
export function SnapshotTimeline({
  sessionId,
  name,
  status,
  onClose,
}: {
  sessionId: string;
  name: string;
  status?: string;
  onClose: () => void;
}) {
  // Rewinding the working tree under a live agent would clobber its in-flight
  // work — block it (the route enforces this too). Forking is always safe (it
  // touches a NEW worktree, never the live one).
  const isRunning = status === "running";
  const { data: snapshots, isLoading } = useSessionSnapshots(sessionId, true);
  const { data: checkpoints } = useSessionCheckpoints(sessionId, true);
  const checkpoint = useCreateCheckpoint(sessionId);
  const fork = useForkFromSnapshot(sessionId);
  const restore = useRestoreSnapshot(sessionId);
  const [selectedSeq, setSelectedSeq] = useState<number | null>(null);
  const [confirming, setConfirming] = useState(false);
  // "Rewind & re-run from here": an inline composer (opened empty). On submit we
  // rewind to this turn THEN send the typed prompt — so cancelling is free.
  const [editingPrompt, setEditingPrompt] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  // Inline composers for the two new actions (null = closed).
  const [labelDraft, setLabelDraft] = useState<string | null>(null);
  const [forkName, setForkName] = useState<string | null>(null);
  const [showHelp, setShowHelp] = useState(false);
  const { data: diff, isLoading: diffLoading } = useSnapshotDiff(
    sessionId,
    selectedSeq
  );

  // Newest first for display.
  const rows = (snapshots ?? []).slice().reverse();
  const selected = rows.find((s) => s.seq === selectedSeq) ?? null;

  // Live checkpoints keyed by the snapshot seq they pin (for row badges), plus
  // the expired ones (records whose snapshot was pruned) shown as a tail list.
  const liveCheckpoints = (checkpoints ?? []).filter((c) => !c.expired);
  const cpBySeq = new Map<number, CheckpointView>();
  for (const c of liveCheckpoints)
    if (!cpBySeq.has(c.seq)) cpBySeq.set(c.seq, c);
  const expiredCheckpoints = (checkpoints ?? []).filter((c) => c.expired);
  const selectedCp = selected ? cpBySeq.get(selected.seq) : undefined;

  const openTimeline = () => {
    setSelectedSeq(null);
    setConfirming(false);
    setEditingPrompt(null);
    setForkName(null);
  };

  const doRestore = (seq: number) => {
    restore.mutate(seq, {
      onSuccess: (r) => {
        setConfirming(false);
        openTimeline();
        toast.success(
          `Rewound to turn #${seq}` +
            (r.safetySeq ? ` · saved current as #${r.safetySeq}` : "")
        );
      },
      onError: (err) => toast.error(`Rewind failed: ${err.message}`),
    });
  };

  const saveCheckpoint = () => {
    const label = (labelDraft ?? "").trim();
    checkpoint.mutate(label, {
      onSuccess: (r) => {
        setLabelDraft(null);
        toast.success(
          r.created ? "Checkpoint saved" : "Nothing to checkpoint yet"
        );
      },
      onError: (err) => toast.error(`Checkpoint failed: ${err.message}`),
    });
  };

  const doFork = () => {
    if (!selected) return;
    fork.mutate(
      { seq: selected.seq, name: (forkName ?? "").trim() || undefined },
      {
        onSuccess: (r) => {
          setForkName(null);
          toast.success(
            `Forked to "${r.session.name}" — open it from the fleet`
          );
          onClose();
        },
        onError: (err) => toast.error(`Fork failed: ${err.message}`),
      }
    );
  };

  // Open the (empty) composer WITHOUT rewinding yet — so Cancel is free and a
  // dead session/failed restore never leaves a half-applied state. The rewind
  // happens on submit, paired with the send (see sendEditedPrompt).
  const startEditRerun = () => {
    setConfirming(false);
    setEditingPrompt("");
  };

  // Submit: rewind to this turn, THEN send the new prompt. The summary shown in
  // the header is the agent's last rendered line, not the user's prompt — so we
  // pre-fill empty and ask what to do from here, rather than seeding chrome.
  const sendEditedPrompt = async () => {
    const text = normalizeEditedPrompt(editingPrompt ?? "");
    if (sending || !text || !selected) return; // guard double-send / empty / no target
    setSending(true);
    try {
      // 1. Rewind the worktree to this turn (saves a safety snapshot of current).
      const r = await restore.mutateAsync(selected.seq);
      if (!r.restored) throw new Error("Couldn't rewind to this turn");
      if (r.safetySeq) toast.success(`Saved current as #${r.safetySeq}`);
      // 2. Send the new prompt — the backend wraps multi-line text in a bracketed
      // paste and submits with Enter, so we send raw normalized text.
      const res = await fetch(`/api/sessions/${sessionId}/send-keys`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, pressEnter: true }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(
          res.status === 400
            ? "Rewound, but this session's agent isn't running"
            : d.error || "Rewound, but couldn't reach the session"
        );
      }
      toast.success("Re-ran from this turn");
      setEditingPrompt(null);
      onClose();
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
      <div className="border-border bg-background/95 flex items-center gap-2 border-b p-3 backdrop-blur-sm">
        {selected ? (
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={openTimeline}
            className="h-9 w-9"
            aria-label="Back to timeline"
          >
            <ChevronLeft className="h-5 w-5" />
          </Button>
        ) : (
          <History className="text-muted-foreground h-4 w-4 flex-shrink-0" />
        )}
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-medium">
            {selected ? `Turn ${selected.seq}` : `Turn history · ${name}`}
          </h3>
          <p className="text-muted-foreground truncate text-xs">
            {selected
              ? selectedCp?.summary || selected.summary
              : `${rows.length} snapshot${rows.length === 1 ? "" : "s"}`}
          </p>
        </div>
        {!selected && (
          <>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => setShowHelp((v) => !v)}
              className="h-9 w-9"
              aria-label="What is this?"
              aria-pressed={showHelp}
            >
              <HelpCircle className="h-5 w-5" />
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                labelDraft === null ? setLabelDraft("") : saveCheckpoint()
              }
              disabled={checkpoint.isPending}
              className="h-9"
            >
              {checkpoint.isPending ? (
                <Loader2 className="mr-1 h-4 w-4 animate-spin" />
              ) : (
                <Camera className="mr-1 h-4 w-4" />
              )}
              Checkpoint
            </Button>
          </>
        )}
        {selected &&
          !confirming &&
          editingPrompt === null &&
          forkName === null && (
            <>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setForkName("")}
                disabled={fork.isPending}
                className="h-9"
              >
                {fork.isPending ? (
                  <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                ) : (
                  <GitFork className="mr-1 h-4 w-4" />
                )}
                Fork from here
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => startEditRerun()}
                disabled={restore.isPending || isRunning}
                title={
                  isRunning ? "Stop the agent to edit & re-run" : undefined
                }
                className="h-9"
              >
                {restore.isPending ? (
                  <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                ) : (
                  <Pencil className="mr-1 h-4 w-4" />
                )}
                Edit &amp; re-run
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setConfirming(true)}
                disabled={restore.isPending || isRunning}
                title={isRunning ? "Stop the agent to rewind" : undefined}
                className="h-9"
              >
                {restore.isPending ? (
                  <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                ) : (
                  <RotateCcw className="mr-1 h-4 w-4" />
                )}
                {isRunning ? "Running…" : "Restore"}
              </Button>
            </>
          )}
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onClose}
          className="h-9 w-9"
          aria-label="Close history"
        >
          <X className="h-5 w-5" />
        </Button>
      </div>

      {/* In-app help for the checkpoint/fork model. */}
      {!selected && showHelp && (
        <div className="border-border text-muted-foreground bg-muted/30 border-b px-3 py-2 text-xs">
          Each row is a working-tree{" "}
          <span className="font-medium">snapshot</span> from a turn.{" "}
          <span className="font-medium">Checkpoint</span> pins the current tree
          with a label so you can find it later.{" "}
          <span className="font-medium">Restore</span> rewinds this session to a
          turn (the current state is saved first).{" "}
          <span className="font-medium">Fork from here</span> spins up a new,
          isolated session in its own worktree branched at that point — the
          original is untouched. A checkpoint whose snapshot ages out of the
          last 20 is kept as an <span className="font-medium">expired</span>{" "}
          record.
        </div>
      )}

      {/* Inline label composer for a durable checkpoint. */}
      {!selected && labelDraft !== null && (
        <div className="border-border bg-primary/5 flex items-center gap-2 border-b px-3 py-2">
          <Tag className="text-muted-foreground h-4 w-4 flex-shrink-0" />
          <Input
            autoFocus
            value={labelDraft}
            onChange={(e) => setLabelDraft(e.target.value)}
            placeholder="Label this checkpoint (optional)…"
            maxLength={200}
            className="h-8 flex-1"
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                saveCheckpoint();
              } else if (e.key === "Escape") {
                e.preventDefault();
                setLabelDraft(null);
              }
            }}
          />
          <Button
            variant="ghost"
            size="sm"
            className="h-8"
            onClick={() => setLabelDraft(null)}
            disabled={checkpoint.isPending}
          >
            Cancel
          </Button>
          <Button
            size="sm"
            className="h-8"
            onClick={saveCheckpoint}
            disabled={checkpoint.isPending}
          >
            {checkpoint.isPending ? (
              <Loader2 className="mr-1 h-4 w-4 animate-spin" />
            ) : (
              <Camera className="mr-1 h-4 w-4" />
            )}
            Save
          </Button>
        </div>
      )}

      {selected && confirming && (
        <div className="border-border flex flex-wrap items-center gap-2 border-b bg-amber-500/10 px-3 py-2 text-xs">
          <span className="text-foreground flex-1">
            Rewind the working tree to turn #{selected.seq}? The current state
            is snapshotted first, so you can undo. New untracked files
            aren&apos;t removed.
          </span>
          <Button
            variant="ghost"
            size="sm"
            className="h-8"
            onClick={() => setConfirming(false)}
            disabled={restore.isPending}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            size="sm"
            className="h-8"
            onClick={() => doRestore(selected.seq)}
            disabled={restore.isPending}
          >
            {restore.isPending ? (
              <Loader2 className="mr-1 h-4 w-4 animate-spin" />
            ) : (
              <RotateCcw className="mr-1 h-4 w-4" />
            )}
            Rewind
          </Button>
        </div>
      )}

      <div className="flex-1 overflow-auto p-3">
        {selected ? (
          diffLoading ? (
            <div className="text-muted-foreground flex h-full items-center justify-center gap-2 text-sm">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading diff…
            </div>
          ) : (
            <DiffFileList
              diff={diff ?? ""}
              emptyLabel="No file changes in this turn."
            />
          )
        ) : isLoading ? (
          <div className="text-muted-foreground flex h-full items-center justify-center gap-2 text-sm">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </div>
        ) : rows.length === 0 ? (
          <div className="text-muted-foreground mx-auto max-w-sm py-10 text-center text-sm">
            No snapshots yet. Tap{" "}
            <span className="font-medium">Checkpoint</span> to capture the
            working tree now, or set{" "}
            <code className="text-xs">STOA_SNAPSHOTS=1</code> to snapshot
            automatically at each turn.
          </div>
        ) : (
          <>
            <ul className="space-y-1">
              {rows.map((s) => {
                const cp = cpBySeq.get(s.seq);
                return (
                  <li key={s.seq}>
                    <button
                      onClick={() => setSelectedSeq(s.seq)}
                      className="hover:bg-accent/50 flex min-h-[44px] w-full items-center gap-3 rounded-md px-3 py-2 text-left transition-colors"
                    >
                      <span className="text-muted-foreground w-12 flex-shrink-0 text-xs tabular-nums">
                        #{s.seq}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-sm">
                        {cp?.summary || s.summary || "checkpoint"}
                      </span>
                      {cp && <KindBadge kind={cp.kind} />}
                      {s.date && (
                        <span className="text-muted-foreground flex-shrink-0 text-[10px]">
                          {ago(s.date)}
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>

            {/* Expired checkpoints: durable records whose snapshot was pruned —
                no longer a rewind/fork target, kept for provenance. */}
            {expiredCheckpoints.length > 0 && (
              <div className="mt-4">
                <div className="text-muted-foreground mb-1 px-3 text-[10px] font-medium tracking-wide uppercase">
                  Expired checkpoints
                </div>
                <ul className="space-y-1 opacity-60">
                  {expiredCheckpoints.map((c) => (
                    <li
                      key={c.id}
                      className="flex min-h-[36px] items-center gap-3 rounded-md px-3 py-1.5"
                    >
                      <span className="text-muted-foreground w-12 flex-shrink-0 text-xs tabular-nums">
                        #{c.seq}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-sm">
                        {c.summary || "checkpoint"}
                      </span>
                      <span className="bg-muted text-muted-foreground rounded px-1.5 py-0.5 text-[10px] font-medium">
                        expired
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </div>

      {/* Fork composer. Creates a new isolated session from this turn — the
          current session and worktree are never touched, so Cancel is free. */}
      {selected && forkName !== null && (
        <div className="border-border bg-background/95 safe-area-bottom border-t p-3 backdrop-blur-sm">
          <div className="mx-auto max-w-3xl space-y-2">
            <div className="text-muted-foreground text-xs">
              Fork a new session from turn #{selected.seq} — it gets its own
              worktree branched at this point. Name it (optional):
            </div>
            <div className="flex items-center gap-2">
              <Input
                autoFocus
                value={forkName}
                onChange={(e) => setForkName(e.target.value)}
                placeholder={`${name} (fork @${selected.seq})`}
                className="h-9 flex-1"
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    doFork();
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    setForkName(null);
                  }
                }}
              />
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setForkName(null)}
                disabled={fork.isPending}
              >
                Cancel
              </Button>
              <Button size="sm" onClick={doFork} disabled={fork.isPending}>
                {fork.isPending ? (
                  <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                ) : (
                  <GitFork className="mr-1 h-4 w-4" />
                )}
                Fork
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Re-run composer. On submit we rewind the workspace to this turn THEN
          send this prompt — so Cancel here leaves the workspace untouched. */}
      {selected && editingPrompt !== null && (
        <div className="border-border bg-background/95 safe-area-bottom border-t p-3 backdrop-blur-sm">
          <div className="mx-auto max-w-3xl space-y-2">
            <div className="text-muted-foreground text-xs">
              Rewind to turn #{selected.seq} and re-run — what should the agent
              do from here?
            </div>
            <Textarea
              autoFocus
              value={editingPrompt}
              onChange={(e) => setEditingPrompt(e.target.value)}
              placeholder="Type the prompt to run from this point…"
              className="min-h-[80px]"
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                  e.preventDefault();
                  sendEditedPrompt();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  setEditingPrompt(null);
                }
              }}
            />
            <div className="flex items-center justify-end gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setEditingPrompt(null)}
                disabled={sending}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={sendEditedPrompt}
                disabled={sending || !normalizeEditedPrompt(editingPrompt)}
              >
                {sending ? (
                  <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                ) : (
                  <Send className="mr-1 h-4 w-4" />
                )}
                Re-run
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
