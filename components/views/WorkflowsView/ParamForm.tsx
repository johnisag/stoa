"use client";

import { useState } from "react";
import { toast } from "sonner";
import { ArrowLeft, Loader2, Play } from "lucide-react";
import { getPipelineTemplate } from "@/lib/pipeline/templates";
import { useStartRun } from "@/data/pipelines/queries";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { Session } from "@/lib/db";

/**
 * Fill a picked template's params + choose the conductor session, then start the
 * run. The conductor is an existing Stoa session — the pipeline spawns its
 * workers through it (the POST /api/pipelines contract requires it). Defaults to
 * the active session when there is one.
 */
export function ParamForm({
  templateId,
  sessions,
  defaultConductorId,
  onBack,
  onStarted,
}: {
  templateId: string;
  sessions: Session[];
  defaultConductorId?: string;
  onBack: () => void;
  onStarted: (runId: string) => void;
}) {
  const template = getPipelineTemplate(templateId);
  const start = useStartRun();

  const [values, setValues] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    template?.params.forEach((p) => {
      if (p.default) init[p.name] = p.default;
    });
    return init;
  });
  const [conductorId, setConductorId] = useState<string>(
    defaultConductorId && sessions.some((s) => s.id === defaultConductorId)
      ? defaultConductorId
      : (sessions[0]?.id ?? "")
  );

  if (!template) {
    return (
      <div className="text-muted-foreground py-10 text-center text-sm">
        Unknown template.
      </div>
    );
  }

  const missingRequired = template.params.some(
    (p) => p.required && !values[p.name]?.trim()
  );
  const canStart = !!conductorId && !missingRequired && !start.isPending;

  async function handleStart() {
    if (!template || !conductorId) return;
    try {
      const spec = template.buildSpec(values);
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
      <button
        type="button"
        onClick={onBack}
        className="text-muted-foreground hover:text-foreground inline-flex w-fit items-center gap-1 text-xs"
      >
        <ArrowLeft className="h-3.5 w-3.5" /> All templates
      </button>

      <div>
        <h3 className="text-sm font-medium">{template.name}</h3>
        <p className="text-muted-foreground text-xs leading-relaxed">
          {template.description}
        </p>
      </div>

      <div className="flex flex-col gap-3">
        {template.params.map((p) => (
          <label key={p.name} className="flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground text-xs">
              {p.label}
              {p.required && <span className="text-red-500"> *</span>}
            </span>
            <Input
              value={values[p.name] ?? ""}
              placeholder={p.placeholder}
              onChange={(e) =>
                setValues((v) => ({ ...v, [p.name]: e.target.value }))
              }
            />
          </label>
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
      </div>

      {template.mutates && (
        <p className="text-muted-foreground rounded-md bg-amber-500/10 px-3 py-2 text-xs leading-relaxed">
          This pipeline writes code — each step runs in its own throwaway git
          worktree off the base branch, so it never touches your checkout.
        </p>
      )}

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
