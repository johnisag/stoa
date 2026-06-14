"use client";

import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { toast } from "sonner";
import {
  Check,
  Copy,
  Download,
  FileJson,
  FolderOpen,
  Loader2,
  Play,
  Plus,
  Save,
  Trash2,
  Upload,
  Wand2,
} from "lucide-react";
import {
  addStep,
  connect,
  disconnect,
  docFromImportedJson,
  docFromSpec,
  docToSpec,
  moveNode,
  relayout,
  removeStep,
  renameStep,
  serializeBuilderDoc,
  setDependsOn,
  updateStep,
  CANVAS,
  type BuilderDoc,
} from "@/lib/pipeline/builder-model";
import { validateSpec } from "@/lib/pipeline/engine";
import { useStartRun } from "@/data/pipelines/queries";
import {
  useSavedWorkflows,
  useCreateSavedWorkflow,
  useUpdateSavedWorkflow,
  useDeleteSavedWorkflow,
} from "@/data/saved-workflows/queries";
import { AGENT_OPTIONS } from "@/components/NewSessionDialog/NewSessionDialog.types";
import type { AgentType } from "@/lib/providers";
import { useConfirm } from "@/components/ConfirmProvider";
import { cn } from "@/lib/utils";
import { PipelineCanvas } from "./PipelineCanvas";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { Session } from "@/lib/db";

const EMPTY_DOC: BuilderDoc = {
  name: "My workflow",
  workingDirectory: "~/my-project",
  nodes: [],
};

// A wired 2-node DAG so a first-time user lands on something runnable to edit,
// rather than a blank canvas — mirrors the Custom tab's "Load example" (same spec).
const EXAMPLE_DOC: BuilderDoc = docFromSpec({
  name: "My workflow",
  workingDirectory: "~/my-project",
  steps: [
    {
      id: "research",
      agent: "claude",
      task: "Investigate the auth flow and write your findings to the output file.",
    },
    {
      id: "implement",
      agent: "claude",
      task: "Using these findings:\n{{steps.research.output}}\nimplement the fix.",
      dependsOn: ["research"],
      exitCriteria: "The change MUST pass the test suite. Open a PR when done.",
    },
  ],
});

/**
 * Visual workflow builder (Phase 3): compose a pipeline by dragging nodes on a
 * canvas and editing the selected step in a form, instead of hand-writing JSON.
 * Dependencies are wired by dragging a node's output port onto another (or via the
 * edit-panel checklist), and an edge is removed by tapping it. The "Saved" menu
 * saves/reloads named workflows (canvas positions included), tidies the layout
 * (re-snap to the topological columns), and imports/exports a workflow as a JSON
 * file; an amber dot flags unsaved changes. The doc is the single source of truth;
 * it projects to the SAME PipelineSpec the Custom editor produces and rides the
 * same validateSpec + run path — no new run backend.
 */
export function WorkflowBuilder({
  sessions,
  defaultConductorId,
  onStarted,
}: {
  sessions: Session[];
  defaultConductorId?: string;
  onStarted: (runId: string) => void;
}) {
  const start = useStartRun();
  const [doc, setDoc] = useState<BuilderDoc>(EMPTY_DOC);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Bring the edit panel into view when a node is selected — on a phone it sits
  // below a tall canvas, so tapping a node would otherwise open a form off-screen.
  const editRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (selectedId) editRef.current?.scrollIntoView({ block: "nearest" });
  }, [selectedId]);
  const [conductorId, setConductorId] = useState<string>(
    defaultConductorId && sessions.some((s) => s.id === defaultConductorId)
      ? defaultConductorId
      : (sessions[0]?.id ?? "")
  );
  // The saved-store id of the workflow currently loaded (null = an unsaved draft).
  // Drives Save-overwrites-vs-creates and which row a Delete removes.
  const [savedId, setSavedId] = useState<string | null>(null);
  // Serialized doc at the last save/load/new — current doc differing from it means
  // there are unsaved changes (the trigger shows a dot). Baseline = the empty doc.
  const [savedSnapshot, setSavedSnapshot] = useState<string>(() =>
    serializeBuilderDoc(EMPTY_DOC)
  );
  // Hidden <input type=file> for Import JSON, clicked from the menu item.
  const fileRef = useRef<HTMLInputElement>(null);

  const savedList = useSavedWorkflows();
  const createWf = useCreateSavedWorkflow();
  const updateWf = useUpdateSavedWorkflow();
  const deleteWf = useDeleteSavedWorkflow();
  const confirm = useConfirm();

  const spec = useMemo(() => docToSpec(doc), [doc]);
  const { valid, errors } = useMemo(() => validateSpec(spec), [spec]);
  const selected = doc.nodes.find((n) => n.step.id === selectedId) ?? null;
  const canStart = valid && !!conductorId && !start.isPending;
  // Unsaved-changes signal: the current doc differs from the last save/load.
  const dirty = useMemo(
    () => doc.nodes.length > 0 && serializeBuilderDoc(doc) !== savedSnapshot,
    [doc, savedSnapshot]
  );

  function handleAdd() {
    // Cascade new nodes so they don't stack on top of each other; the user drags
    // them where they want.
    const i = doc.nodes.length;
    const x = CANVAS.PAD + (i % 4) * (CANVAS.NODE_W + 24);
    const y = CANVAS.PAD + Math.floor(i / 4) * (CANVAS.NODE_H + 40);
    const next = addStep(doc, x, y);
    setDoc(next);
    setSelectedId(next.nodes[next.nodes.length - 1].step.id);
  }

  function loadDoc(next: BuilderDoc, savedWorkflowId: string | null) {
    setDoc(next);
    setSelectedId(null);
    setSavedId(savedWorkflowId);
    setSavedSnapshot(serializeBuilderDoc(next)); // freshly loaded = no unsaved changes
  }

  // Returns false (after a toast) if the canvas isn't ready to save, so the menu
  // item can stay enabled and TEACH why — a disabled item gives a phone tap no
  // feedback at all.
  function saveGuard(): string | null {
    const name = doc.name.trim();
    if (doc.nodes.length === 0) {
      toast.error("Add a step first.");
      return null;
    }
    if (!name) {
      toast.error(
        "Give the workflow a name first (the “Workflow name” field)."
      );
      return null;
    }
    return name;
  }

  async function handleSave() {
    const name = saveGuard();
    if (!name) return;
    try {
      if (savedId) {
        await updateWf.mutateAsync({ id: savedId, name, doc });
      } else {
        const created = await createWf.mutateAsync({ name, doc });
        setSavedId(created.id);
      }
      setSavedSnapshot(serializeBuilderDoc(doc)); // now persisted = no unsaved changes
      toast.success(`Saved “${name}”`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to save");
    }
  }

  // Always creates a new row (forking a loaded workflow) — so renaming + Save
  // doesn't silently overwrite the original under its old id.
  async function handleSaveCopy() {
    const name = saveGuard();
    if (!name) return;
    try {
      const created = await createWf.mutateAsync({ name, doc });
      setSavedId(created.id);
      setSavedSnapshot(serializeBuilderDoc(doc));
      toast.success(`Saved a copy as “${name}”`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to save");
    }
  }

  function handleTidy() {
    if (doc.nodes.length === 0) return;
    setDoc((d) => relayout(d));
    toast.success("Tidied the layout");
  }

  // Download the workflow as JSON (the BuilderDoc — positions included, so it
  // re-imports into the canvas exactly; it also imports as a bare spec elsewhere).
  function handleExport() {
    if (doc.nodes.length === 0) {
      toast.error("Add a step first — nothing to export yet.");
      return;
    }
    const safe = (doc.name || "workflow").replace(/[^a-z0-9._-]+/gi, "-");
    const blob = new Blob([JSON.stringify(doc, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${safe}.stoa-workflow.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success(`Exported ${safe}.stoa-workflow.json`);
  }

  function handleImportFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // let the same file be picked again
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const next = docFromImportedJson(String(reader.result ?? ""));
      if (!next) {
        toast.error("That file isn’t a valid workflow JSON.");
        return;
      }
      loadDoc(next, null); // imported = a fresh unsaved draft
      toast.success("Imported workflow");
    };
    reader.onerror = () => toast.error("Couldn’t read that file.");
    reader.readAsText(file);
  }

  async function handleDeleteSaved() {
    if (!savedId) return;
    const target = savedList.data?.find((w) => w.id === savedId);
    if (
      !(await confirm({
        title: "Delete this saved workflow?",
        description: `“${target?.name ?? doc.name}” will be removed. This can't be undone.`,
      }))
    ) {
      return;
    }
    try {
      await deleteWf.mutateAsync(savedId);
      toast.success("Deleted saved workflow");
      setSavedId(null);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to delete");
    }
  }

  function patch(id: string, p: Parameters<typeof updateStep>[2]) {
    setDoc((d) => updateStep(d, id, p));
  }

  function commitRename(oldId: string, raw: string) {
    const newId = raw.trim();
    if (!newId || newId === oldId) return;
    const next = renameStep(doc, oldId, newId);
    if (next === doc) {
      toast.error(`Step id “${newId}” is already taken`);
      return;
    }
    setDoc(next);
    setSelectedId(newId);
  }

  function handleDelete(id: string) {
    setDoc((d) => removeStep(d, id));
    setSelectedId(null);
  }

  async function handleStart() {
    if (!valid || !conductorId) return;
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
          <h3 className="text-sm font-medium">Visual builder</h3>
          <p className="text-muted-foreground text-xs leading-relaxed">
            Drag the boxes to arrange your DAG; tap one to edit it. Drag a box’s
            dot onto another box to connect them. Steps with no path between
            them run in parallel.
          </p>
        </div>
        <div className="flex flex-shrink-0 items-center gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button type="button" variant="outline" size="sm">
                <FolderOpen className="mr-1.5 h-3.5 w-3.5" /> Saved
                {dirty && (
                  <span
                    className="ml-1 inline-block h-2 w-2 rounded-full bg-amber-500"
                    title="Unsaved changes"
                    aria-label="Unsaved changes"
                  />
                )}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              className="max-h-80 w-56 overflow-y-auto"
            >
              {/* Save stays ENABLED even when not ready — handleSave's toast then
                  teaches why (a disabled item gives a phone tap no feedback). */}
              <DropdownMenuItem
                onSelect={handleSave}
                disabled={createWf.isPending || updateWf.isPending}
              >
                <Save className="mr-2 h-3.5 w-3.5" />
                {savedId ? "Save" : "Save as new"}
              </DropdownMenuItem>
              {savedId && (
                <DropdownMenuItem
                  onSelect={handleSaveCopy}
                  disabled={createWf.isPending}
                >
                  <Copy className="mr-2 h-3.5 w-3.5" /> Save a copy
                </DropdownMenuItem>
              )}
              {savedId && (
                <DropdownMenuItem
                  onSelect={handleDeleteSaved}
                  className="text-red-600 dark:text-red-400"
                >
                  <Trash2 className="mr-2 h-3.5 w-3.5" /> Delete current
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={handleTidy}
                disabled={doc.nodes.length === 0}
              >
                <Wand2 className="mr-2 h-3.5 w-3.5" /> Tidy layout
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => loadDoc(EMPTY_DOC, null)}>
                <Plus className="mr-2 h-3.5 w-3.5" /> New workflow
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => loadDoc(EXAMPLE_DOC, null)}>
                <FileJson className="mr-2 h-3.5 w-3.5" /> Load example
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => fileRef.current?.click()}>
                <Upload className="mr-2 h-3.5 w-3.5" /> Import workflow…
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={handleExport}
                disabled={doc.nodes.length === 0}
              >
                <Download className="mr-2 h-3.5 w-3.5" /> Export workflow
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>Saved workflows</DropdownMenuLabel>
              {savedList.data && savedList.data.length > 0 ? (
                savedList.data.map((wf) => (
                  <DropdownMenuItem
                    key={wf.id}
                    onSelect={() => loadDoc(wf.doc, wf.id)}
                    className="flex items-center gap-2"
                  >
                    <Check
                      className={cn(
                        "h-3.5 w-3.5 flex-shrink-0",
                        wf.id === savedId ? "opacity-100" : "opacity-0"
                      )}
                    />
                    <span className="min-w-0 flex-1 truncate">{wf.name}</span>
                    <span className="text-muted-foreground flex-shrink-0 text-[10px]">
                      {wf.doc.nodes.length} step
                      {wf.doc.nodes.length === 1 ? "" : "s"}
                    </span>
                  </DropdownMenuItem>
                ))
              ) : (
                <DropdownMenuItem disabled>
                  No saved workflows yet
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={handleImportFile}
          />
          <Button type="button" variant="outline" size="sm" onClick={handleAdd}>
            <Plus className="mr-1.5 h-3.5 w-3.5" /> Add step
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground text-xs">Workflow name</span>
          <Input
            value={doc.name}
            onChange={(e) => setDoc((d) => ({ ...d, name: e.target.value }))}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground text-xs">
            Working directory
          </span>
          <Input
            value={doc.workingDirectory}
            onChange={(e) =>
              setDoc((d) => ({ ...d, workingDirectory: e.target.value }))
            }
          />
        </label>
      </div>

      {doc.nodes.length === 0 ? (
        <div className="text-muted-foreground rounded-md border border-dashed px-3 py-8 text-center text-xs">
          No steps yet — tap <span className="font-medium">Add step</span> to
          drop your first node.
        </div>
      ) : (
        <PipelineCanvas
          doc={doc}
          selectedId={selectedId}
          onSelectNode={setSelectedId}
          onMoveNode={(id, x, y) => setDoc((d) => moveNode(d, id, x, y))}
          onConnect={(from, to) => setDoc((d) => connect(d, from, to))}
          onDisconnect={(from, to) => setDoc((d) => disconnect(d, from, to))}
        />
      )}

      {/* Edit panel for the selected node. */}
      {selected && (
        <div
          ref={editRef}
          className="bg-card flex flex-col gap-3 rounded-md border p-3"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm font-medium">Edit step</span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="text-red-600 hover:text-red-600 dark:text-red-400"
              onClick={() => handleDelete(selected.step.id)}
            >
              <Trash2 className="mr-1.5 h-3.5 w-3.5" /> Delete
            </Button>
          </div>

          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-muted-foreground text-xs">
                Step id <span className="text-red-500">*</span>
              </span>
              <Input
                key={selected.step.id}
                defaultValue={selected.step.id}
                spellCheck={false}
                // Commit on blur (so we don't rename on every keystroke) — and on
                // Enter, which blurs, so a phone user who taps straight to Start
                // doesn't lose the edit.
                onKeyDown={(e) => {
                  if (e.key === "Enter") e.currentTarget.blur();
                }}
                onBlur={(e) => commitRename(selected.step.id, e.target.value)}
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-muted-foreground text-xs">
                Name (optional)
              </span>
              <Input
                value={selected.step.name ?? ""}
                onChange={(e) =>
                  patch(selected.step.id, {
                    name: e.target.value || undefined,
                  })
                }
              />
            </label>
          </div>

          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground text-xs">Agent</span>
            <Select
              value={selected.step.agent}
              onValueChange={(v) =>
                patch(selected.step.id, { agent: v as AgentType })
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {AGENT_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    <span className="font-medium">{o.label}</span>
                    <span className="text-muted-foreground ml-2 text-xs">
                      {o.description}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>

          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground text-xs">
              Task <span className="text-red-500">*</span>
            </span>
            <Textarea
              value={selected.step.task}
              spellCheck={false}
              placeholder="What this agent should do. Reference an upstream step's output with {{steps.<id>.output}}."
              onChange={(e) =>
                patch(selected.step.id, { task: e.target.value })
              }
              className="min-h-[80px]"
            />
          </label>

          {/* dependsOn — a checklist of the other step ids (the house multi-select
              idiom; the same edges you can draw by dragging a node's port). */}
          {doc.nodes.length > 1 && (
            <div className="flex flex-col gap-1 text-sm">
              <span className="text-muted-foreground text-xs">Depends on</span>
              <div className="flex flex-col gap-1 rounded-md border p-2">
                {doc.nodes
                  .filter((n) => n.step.id !== selected.step.id)
                  .map((n) => {
                    const checked =
                      selected.step.dependsOn?.includes(n.step.id) ?? false;
                    return (
                      <label
                        key={n.step.id}
                        className="flex cursor-pointer items-center gap-2 text-xs"
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={(e) => {
                            const cur = selected.step.dependsOn ?? [];
                            const next = e.target.checked
                              ? [...cur, n.step.id]
                              : cur.filter((d) => d !== n.step.id);
                            setDoc((d) =>
                              setDependsOn(d, selected.step.id, next)
                            );
                          }}
                        />
                        {n.step.name || n.step.id}
                      </label>
                    );
                  })}
              </div>
            </div>
          )}

          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground text-xs">
              Exit criteria (optional)
            </span>
            <Textarea
              value={selected.step.exitCriteria ?? ""}
              spellCheck={false}
              placeholder="Unbreakable rules the step must satisfy, e.g. “must pass tests; open a PR”."
              onChange={(e) =>
                patch(selected.step.id, {
                  exitCriteria: e.target.value || undefined,
                })
              }
              className="min-h-[60px]"
            />
          </label>

          <label className="flex items-center justify-between gap-2 text-sm">
            <span className="flex flex-col">
              <span className="text-xs font-medium">Shared worktree</span>
              <span className="text-muted-foreground text-[11px]">
                Reuse one checkout for all shared steps (runs them serially).
              </span>
            </span>
            <Switch
              checked={selected.step.worktreePolicy === "shared"}
              onCheckedChange={(c) =>
                patch(selected.step.id, {
                  worktreePolicy: c ? "shared" : undefined,
                })
              }
            />
          </label>
        </div>
      )}

      {/* Validation — green when runnable, the full error list otherwise. */}
      {doc.nodes.length > 0 &&
        (valid ? (
          <p className="text-xs font-medium text-emerald-600 dark:text-emerald-400">
            ✓ Valid — {doc.nodes.length} step
            {doc.nodes.length === 1 ? "" : "s"}.
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
