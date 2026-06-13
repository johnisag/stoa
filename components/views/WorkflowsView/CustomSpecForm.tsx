"use client";

import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Loader2, Play, FileJson } from "lucide-react";
import { parsePipelineSpec } from "@/lib/pipeline/engine";
import { useStartRun } from "@/data/pipelines/queries";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { Session } from "@/lib/db";

// A friendly starting point: a 2-step DAG showing ids, agents, tasks, a dependency,
// and how a downstream step reads an upstream step's output. workingDirectory is an
// obvious placeholder — the author swaps in a real repo path before running.
const EXAMPLE_SPEC = `{
  "name": "My workflow",
  "workingDirectory": "~/my-project",
  "steps": [
    {
      "id": "research",
      "agent": "claude",
      "task": "Investigate the auth flow and write your findings to the output file."
    },
    {
      "id": "implement",
      "agent": "claude",
      "task": "Using these findings:\\n{{steps.research.output}}\\nimplement the fix.",
      "dependsOn": ["research"],
      "exitCriteria": "The change MUST pass the test suite. Open a PR when done."
    }
  ]
}`;

/**
 * Author + run a custom pipeline by hand (Phase 0 of the workflow builder): paste
 * or edit a PipelineSpec JSON, get instant validation (the SAME pure validateSpec
 * the server enforces), pick a conductor session, and run. No new model or backend
 * — it rides the existing /api/pipelines run path the templates use.
 */
export function CustomSpecForm({
  sessions,
  defaultConductorId,
  onStarted,
}: {
  sessions: Session[];
  defaultConductorId?: string;
  onStarted: (runId: string) => void;
}) {
  const start = useStartRun();
  // The draft is in-memory only for P0 (discarded on dialog close, like ParamForm's
  // fields) — persisting it (sessionStorage) is a P1 follow-up.
  const [text, setText] = useState("");
  const [conductorId, setConductorId] = useState<string>(
    defaultConductorId && sessions.some((s) => s.id === defaultConductorId)
      ? defaultConductorId
      : (sessions[0]?.id ?? "")
  );

  // Live validation on every keystroke — pure, no network. Empty text shows no
  // errors yet (a blank editor isn't "wrong", just not ready).
  const { spec, errors } = useMemo(() => {
    if (!text.trim()) return { spec: null, errors: [] };
    return parsePipelineSpec(text);
  }, [text]);

  const canStart = !!spec && !!conductorId && !start.isPending;

  async function handleStart() {
    if (!spec || !conductorId) return;
    try {
      const run = await start.mutateAsync({
        spec,
        conductorSessionId: conductorId,
      });
      toast.success(`Started “${spec.name}”`);
      onStarted(run.id);
    } catch (e) {
      toast.error(
        e instanceof Error ? e.message : "Failed to start the pipeline"
      );
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-medium">Custom workflow</h3>
          <p className="text-muted-foreground text-xs leading-relaxed">
            Author a pipeline by hand — a DAG of steps, each a task on an agent,
            wired with <code className="text-foreground">dependsOn</code>. Steps
            with no path between them run in parallel.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setText(EXAMPLE_SPEC)}
        >
          <FileJson className="mr-1.5 h-3.5 w-3.5" /> Load example
        </Button>
      </div>

      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        spellCheck={false}
        placeholder="Paste a PipelineSpec JSON, or tap “Load example”…"
        className="bg-muted/30 focus-visible:ring-ring min-h-[220px] w-full resize-y rounded-md border p-3 font-mono text-xs leading-relaxed outline-none focus-visible:ring-2"
      />

      {/* Validation feedback — green when ready, the full error list otherwise. */}
      {text.trim() &&
        (spec ? (
          <p className="text-xs font-medium text-emerald-600 dark:text-emerald-400">
            ✓ Valid — {spec.steps.length} step
            {spec.steps.length === 1 ? "" : "s"}.
          </p>
        ) : (
          <ul className="flex flex-col gap-1 rounded-md bg-red-500/10 p-2.5 text-xs text-red-600 dark:text-red-400">
            {errors.map((e, i) => (
              <li key={i}>
                {e.stepId ? (
                  <span className="font-medium">{e.stepId}: </span>
                ) : null}
                {e.message}
              </li>
            ))}
          </ul>
        ))}

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted-foreground text-xs">
          Conductor session <span className="text-red-500">*</span>
        </span>
        {sessions.length === 0 ? (
          <span className="text-muted-foreground rounded-md border border-dashed px-3 py-2 text-xs">
            No sessions yet — start a session first; the pipeline spawns its
            workers from it.
          </span>
        ) : (
          <>
            <Select value={conductorId} onValueChange={setConductorId}>
              <SelectTrigger>
                <SelectValue placeholder="Pick a session" />
              </SelectTrigger>
              <SelectContent>
                {sessions.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <span className="text-muted-foreground text-[11px]">
              An existing Stoa session the pipeline spawns its workers from.
            </span>
          </>
        )}
      </label>

      <p className="text-muted-foreground rounded-md bg-amber-500/10 px-3 py-2 text-xs leading-relaxed">
        Any step that writes code runs in its own throwaway git worktree off the
        base branch, so it never touches your checkout.
      </p>

      <Button
        onClick={handleStart}
        disabled={!canStart}
        className="w-full sm:w-auto sm:self-start"
      >
        {start.isPending ? (
          <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
        ) : (
          <Play className="mr-1.5 h-4 w-4" />
        )}
        Start pipeline
      </Button>
    </div>
  );
}
