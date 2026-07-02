"use client";

import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { toast } from "sonner";
import { GitBranch, Layers, Loader2, Play, X } from "lucide-react";
import {
  connect,
  deleteNodes,
  disconnect,
  docFromImportedJson,
  docToSpec,
  insertOutputRef,
  outputRefToken,
  setProject,
  setWorktree,
  CANVAS,
  type BuilderDoc,
  type HistorySnapshot,
} from "@/lib/pipeline/builder-model";
import { WORKFLOW_SNIPPETS } from "@/lib/pipeline/snippets";
import { validateSpec } from "@/lib/pipeline/engine";
import { useStartRun } from "@/data/pipelines/queries";
import { useProjectsQuery } from "@/data/projects/queries";
import { useWorktrees } from "@/data/worktrees/queries";
import { useConfirm } from "@/components/ConfirmProvider";
import { copyText } from "@/lib/clipboard";
import { cn } from "@/lib/utils";
import { PipelineCanvas } from "./PipelineCanvas";
import { Minimap } from "./Minimap";
import { WorkflowsShortcuts } from "./WorkflowsShortcuts";
import { AgentsPanel } from "./SnippetsPanel";
import { WorkflowInspector } from "./WorkflowInspector";
import { WorkflowToolbar } from "./WorkflowToolbar";
import {
  EMPTY_DOC,
  EXAMPLE_DOC,
  worktreeLabel,
  availableWorktrees,
  type PastePreview,
} from "./builder-helpers";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { Session } from "@/lib/db";
import { useGlobalKeybindings } from "@/hooks/useGlobalKeybindings";
import { useCanvasSelection } from "@/hooks/useCanvasSelection";
import { useWorkflowDoc } from "@/hooks/useWorkflowDoc";
import { useWorkflowPersistence } from "@/hooks/useWorkflowPersistence";
import { CollapsibleSection } from "./WorkflowCollapsibleSection";
import { WorkflowDesignPanel } from "./WorkflowDesignPanel";
import type { Keybinding } from "@/lib/keybindings";

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
  const selection = useCanvasSelection();
  const {
    selectedIds,
    primaryId,
    clearSelection,
    handleSelectNode,
    setSelectedIds,
    setPrimaryId,
  } = selection;
  const docApi = useWorkflowDoc(EMPTY_DOC, selection, WORKFLOW_SNIPPETS);
  const {
    doc,
    committedDoc,
    setDoc,
    reset,
    canUndo,
    canRedo,
    handleUndo,
    handleRedo,
    handleDuplicate,
    handleMoveItems,
    handleMoveEnd,
    handleDeleteItem,
    handleAdd,
    handleAddNote,
    patchNote,
    patch,
    patchTransient,
    commit,
    commitRename,
    handleSnippetSelect,
    handleSnippetDrop,
    handleTidy,
  } = docApi;
  const { data: projects = [] } = useProjectsQuery();
  const { data: worktrees = [] } = useWorktrees();
  const selectedProject = projects.find((p) => p.id === doc.projectId);
  const canvasScrollRef = useRef<HTMLDivElement | null>(null);
  const editPanelRef = useRef<HTMLDivElement | null>(null);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState("");
  // The Task field's "insert an upstream step's output" affordance.
  const taskRef = useRef<HTMLTextAreaElement>(null);
  const [showRefMenu, setShowRefMenu] = useState(false);
  // Collapse the menu whenever the selected step changes.
  useEffect(() => setShowRefMenu(false), [primaryId]);
  // On narrow screens (< lg) the edit panel stacks below the canvas; scroll it
  // into view when a node or note is selected so the user doesn't have to hunt.
  useEffect(() => {
    if (!primaryId || !editPanelRef.current) return;
    if (window.innerWidth >= 1024) return; // lg breakpoint — side-by-side, no scroll needed
    editPanelRef.current.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [primaryId]);
  const [conductorId, setConductorId] = useState<string>(
    defaultConductorId && sessions.some((s) => s.id === defaultConductorId)
      ? defaultConductorId
      : (sessions[0]?.id ?? "")
  );
  // Hidden <input type=file> for Import JSON, clicked from the menu item.
  const fileRef = useRef<HTMLInputElement>(null);
  const confirm = useConfirm();

  const {
    savedId,
    savedList,
    currentSaved,
    dirty,
    createWf,
    updateWf,
    loadDoc,
    handleSave,
    handleSaveCopy,
    handleDeleteSaved,
  } = useWorkflowPersistence({
    doc,
    committedDoc,
    emptyDoc: EMPTY_DOC,
    reset,
    clearSelection,
    confirm,
  });

  const spec = useMemo(() => docToSpec(doc), [doc]);
  const { valid, errors } = useMemo(() => validateSpec(spec), [spec]);
  const errorIds = useMemo(
    () => new Set(errors.filter((e) => e.stepId).map((e) => e.stepId!)),
    [errors]
  );
  const primaryNode = useMemo(
    () => doc.nodes.find((n) => n.step.id === primaryId) ?? null,
    [doc, primaryId]
  );
  const primaryNote = useMemo(
    () => doc.notes.find((n) => n.id === primaryId) ?? null,
    [doc, primaryId]
  );
  const canStart = valid && !!conductorId && !start.isPending;

  async function loadSnapshot(snapshot: HistorySnapshot) {
    if (
      dirty &&
      !(await confirm({
        title: "Load earlier version?",
        description: "Unsaved changes in the current draft will be lost.",
      }))
    ) {
      return;
    }
    reset(snapshot.doc);
    clearSelection();
    toast.success("Loaded earlier version");
  }

  // "New workflow" / "Load example" replace the canvas — guard unsaved work the
  // same way loadSnapshot / import do (confirm-if-dirty), so a stray click can't
  // silently wipe an in-progress draft.
  async function startBlankWorkflow() {
    if (
      dirty &&
      !(await confirm({
        title: "Start a new workflow?",
        description: "Unsaved changes in the current draft will be lost.",
      }))
    ) {
      return;
    }
    loadDoc(EMPTY_DOC, null);
  }

  async function loadExampleWorkflow() {
    if (
      dirty &&
      !(await confirm({
        title: "Load the example?",
        description: "Unsaved changes in the current draft will be lost.",
      }))
    ) {
      return;
    }
    loadDoc(EXAMPLE_DOC, null);
  }

  function handleGoToDefinitions(id: string) {
    handleSelectNode(id);
  }

  async function handleConfirmDeleteItem(id: string) {
    if (
      !(await confirm({
        title: "Delete this item?",
        description: "This can't be undone.",
      }))
    ) {
      return;
    }
    handleDeleteItem(id);
  }

  async function handleDeleteSelected() {
    // Snapshot the selection BEFORE the await so we delete exactly what the user
    // confirmed against, even if selection state changes during the dialog.
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    if (
      !(await confirm({
        title: "Delete selected items?",
        description: `Delete ${ids.length} selected item${ids.length === 1 ? "" : "s"}? This can't be undone.`,
      }))
    ) {
      return;
    }
    setDoc((d) => deleteNodes(d, ids));
    clearSelection();
  }

  function handleFitAll() {
    if (doc.nodes.length === 0 && doc.notes.length === 0) return;
    const container = canvasScrollRef.current;
    if (!container) return;
    const { NODE_W, NODE_H, NOTE_W, NOTE_H, PAD } = CANVAS;
    const minX = Math.min(
      ...doc.nodes.map((n) => n.x),
      ...doc.notes.map((n) => n.x)
    );
    const minY = Math.min(
      ...doc.nodes.map((n) => n.y),
      ...doc.notes.map((n) => n.y)
    );
    const maxX = Math.max(
      ...doc.nodes.map((n) => n.x + NODE_W),
      ...doc.notes.map((n) => n.x + NOTE_W)
    );
    const maxY = Math.max(
      ...doc.nodes.map((n) => n.y + NODE_H),
      ...doc.notes.map((n) => n.y + NOTE_H)
    );
    const pad = PAD;
    const contentWidth = maxX - minX + pad * 2;
    const contentHeight = maxY - minY + pad * 2;
    const visibleWidth = container.clientWidth;
    const visibleHeight = container.clientHeight;
    container.scrollTo({
      left: Math.max(0, minX - pad + (contentWidth - visibleWidth) / 2),
      top: Math.max(0, minY - pad + (contentHeight - visibleHeight) / 2),
      behavior: "smooth",
    });
  }

  async function handleCopyJson() {
    if (doc.nodes.length === 0 && doc.notes.length === 0) {
      toast.error("Add a step or note first — nothing to copy yet.");
      return;
    }
    const text = JSON.stringify(spec, null, 2);
    if (await copyText(text)) {
      toast.success("Workflow JSON copied to clipboard");
    } else {
      toast.error("Could not copy to clipboard");
    }
  }

  const parsedImport = useMemo(() => {
    if (!pasteText.trim()) return null;
    return docFromImportedJson(pasteText);
  }, [pasteText]);

  const pastePreview = useMemo<PastePreview>(() => {
    if (!pasteText.trim()) return { ok: null, count: 0, name: "" };
    if (!parsedImport) return { ok: false, count: 0, name: "" };
    return {
      ok: true,
      count: parsedImport.nodes.length,
      name: parsedImport.name,
    };
  }, [pasteText, parsedImport]);

  async function handlePasteImport() {
    if (!parsedImport) {
      toast.error("That JSON isn't a valid workflow.");
      return;
    }
    if (
      doc.nodes.length > 0 &&
      !(await confirm({
        title: "Replace current workflow?",
        description: `Importing will replace the current ${doc.nodes.length}-step workflow.`,
      }))
    ) {
      return;
    }
    loadDoc(parsedImport, null);
    setPasteOpen(false);
    setPasteText("");
    toast.success(
      `Imported ${parsedImport.nodes.length} step${parsedImport.nodes.length === 1 ? "" : "s"}`
    );
  }

  const keybindings: Keybinding[] = useMemo(
    () => [
      { chord: "mod+z", action: "undo", description: "Undo" },
      { chord: "mod+shift+z", action: "redo", description: "Redo" },
      {
        chord: "mod+d",
        action: "duplicate",
        description: "Duplicate selected step",
      },
      { chord: "mod+a", action: "selectAll", description: "Select all items" },
      {
        chord: "Delete",
        action: "deleteSelected",
        description: "Delete selected item(s)",
      },
      {
        chord: "Escape",
        action: "clearSelection",
        description: "Clear selection",
      },
      {
        chord: "mod+shift+l",
        action: "shortcuts",
        description: "Show keyboard shortcuts",
      },
    ],
    []
  );

  useGlobalKeybindings(
    keybindings,
    (action) => {
      if (action === "undo") handleUndo();
      else if (action === "redo") handleRedo();
      else if (action === "duplicate") handleDuplicate();
      else if (action === "selectAll") {
        const allIds = new Set([
          ...doc.nodes.map((n) => n.step.id),
          ...doc.notes.map((n) => n.id),
        ]);
        setSelectedIds(allIds);
        setPrimaryId(doc.nodes[0]?.step.id ?? doc.notes[0]?.id ?? null);
      } else if (action === "deleteSelected") {
        void handleDeleteSelected();
      } else if (action === "clearSelection") {
        clearSelection();
      } else if (action === "shortcuts") setShortcutsOpen(true);
    },
    { capture: true, stopPropagation: true }
  );

  // Download the workflow as JSON (the BuilderDoc — positions included, so it
  // re-imports into the canvas exactly; it also imports as a bare spec elsewhere).
  function handleExport() {
    if (doc.nodes.length === 0 && doc.notes.length === 0) {
      toast.error("Add a step or note first — nothing to export yet.");
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
    toast.message("Git export tip", {
      description:
        "Commit exported .stoa-workflow.json files to git to version workflows alongside code.",
      icon: <GitBranch className="h-4 w-4" />,
    });
  }

  function handleImportFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // let the same file be picked again
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      const next = docFromImportedJson(String(reader.result ?? ""));
      if (!next) {
        toast.error("That file isn't a valid workflow JSON.");
        return;
      }
      if (
        doc.nodes.length > 0 &&
        !(await confirm({
          title: "Replace current workflow?",
          description: `Importing will replace the current ${doc.nodes.length}-step workflow.`,
        }))
      ) {
        return;
      }
      loadDoc(next, null); // imported = a fresh unsaved draft
      toast.success("Imported workflow");
    };
    reader.onerror = () => toast.error("Couldn't read that file.");
    reader.readAsText(file);
  }

  // Insert an upstream step's output reference at the Task caret + wire the
  // dependency. The splice itself lives in builder-model (insertOutputRef reads the
  // task from the doc, so a concurrent keystroke can't make it stale); here we just
  // capture the caret, commit it as one undoable edit, and restore focus.
  function handleInsertRef(refId: string) {
    const node = primaryNode;
    if (!node) return;
    const el = taskRef.current;
    const fallback = (node.step.task ?? "").length;
    const start = el?.selectionStart ?? fallback;
    const end = el?.selectionEnd ?? start;
    setDoc((d) => insertOutputRef(d, node.step.id, refId, start, end));
    setShowRefMenu(false);
    // Restore focus + place the caret right after the inserted token.
    requestAnimationFrame(() => {
      const caret = start + outputRefToken(refId).length;
      el?.focus();
      el?.setSelectionRange(caret, caret);
    });
  }

  async function handleContextCopyId(id: string) {
    if (await copyText(id)) {
      toast.success(`Copied id "${id}"`);
    } else {
      toast.error("Could not copy to clipboard");
    }
  }

  async function handleStart() {
    if (!valid || !conductorId) return;
    try {
      const run = await start.mutateAsync({
        spec,
        conductorSessionId: conductorId,
      });
      toast.success(`Started "${spec.name}"`);
      onStarted(run.id);
    } catch (e) {
      toast.error(
        e instanceof Error ? e.message : "Failed to start the pipeline"
      );
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      {/* 1. Design with AI — collapsible, closed by default */}
      <WorkflowDesignPanel
        projectId={doc.projectId}
        dirty={dirty}
        confirm={confirm}
        onLoadDoc={loadDoc}
      />

      {/* 2. Toolbar */}
      <WorkflowToolbar
        doc={doc}
        canUndo={canUndo}
        canRedo={canRedo}
        dirty={dirty}
        savedId={savedId}
        savedList={savedList}
        currentSaved={currentSaved}
        createPending={createWf.isPending}
        updatePending={updateWf.isPending}
        selectedIds={selectedIds}
        fileRef={fileRef}
        onUndo={handleUndo}
        onRedo={handleRedo}
        onFitAll={handleFitAll}
        onShowShortcuts={() => setShortcutsOpen(true)}
        onSave={handleSave}
        onSaveCopy={handleSaveCopy}
        onDeleteSaved={handleDeleteSaved}
        onTidy={handleTidy}
        onNewWorkflow={startBlankWorkflow}
        onLoadExample={loadExampleWorkflow}
        onImportClick={() => fileRef.current?.click()}
        onPasteOpen={() => setPasteOpen(true)}
        onExport={handleExport}
        onCopyJson={handleCopyJson}
        onLoadDoc={loadDoc}
        onLoadSnapshot={loadSnapshot}
        onImportFile={handleImportFile}
        onAdd={handleAdd}
        onAddNote={handleAddNote}
        onDuplicate={() => handleDuplicate()}
        onDeleteSelected={handleDeleteSelected}
      />

      {/* 3. Main split area: canvas top/left, edit panel bottom/right.
           Stacks vertically on mobile (< lg) and side-by-side on lg+. */}
      <div className="flex min-h-0 flex-1 flex-col gap-2 lg:flex-row">
        {/* LEFT column */}
        <div className="flex min-h-0 flex-1 flex-col gap-2">
          {/* 3a. Settings collapsible */}
          <CollapsibleSection title="Settings" defaultOpen={false}>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-muted-foreground text-xs">
                  Workflow name
                </span>
                <Input
                  value={doc.name}
                  onChange={(e) =>
                    setDoc((d) => ({ ...d, name: e.target.value }), {
                      transient: true,
                    })
                  }
                  onBlur={commit}
                />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-muted-foreground text-xs">
                  Project context
                </span>
                <Select
                  value={doc.projectId || "none"}
                  onValueChange={(v) => {
                    const id = v === "none" ? null : v;
                    const project = projects.find((p) => p.id === id);
                    setDoc((d) =>
                      setProject(d, id, project?.working_directory)
                    );
                  }}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Pick a project" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">
                      <span className="text-muted-foreground">No project</span>
                    </SelectItem>
                    {projects
                      .filter((p) => !p.is_uncategorized)
                      .map((project) => (
                        <SelectItem key={project.id} value={project.id}>
                          {project.name}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </label>
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-muted-foreground text-xs">Worktree</span>
                <Select
                  value={doc.worktreePath || "new"}
                  onValueChange={(v) => {
                    const wt = worktrees.find((w) => w.path === v);
                    setDoc((d) =>
                      setWorktree(d, wt?.path ?? null, wt?.projectId)
                    );
                  }}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="new">
                      <span className="text-muted-foreground">
                        New worktree
                      </span>
                    </SelectItem>
                    {availableWorktrees(
                      doc,
                      worktrees,
                      selectedProject?.working_directory
                    ).map((w) => (
                      <SelectItem key={w.path} value={w.path}>
                        {worktreeLabel(w)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </label>
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-muted-foreground text-xs">
                  Working directory
                </span>
                <Input
                  value={doc.workingDirectory}
                  onChange={(e) =>
                    setDoc(
                      (d) => ({ ...d, workingDirectory: e.target.value }),
                      { transient: true }
                    )
                  }
                  onBlur={commit}
                />
              </label>
            </div>
          </CollapsibleSection>

          {/* 3b. Canvas */}
          {doc.nodes.length === 0 && doc.notes.length === 0 ? (
            <div className="text-muted-foreground flex min-h-[180px] flex-1 items-center justify-center rounded-md border border-dashed px-3 text-center text-xs">
              No steps yet — tap <span className="font-medium">Add step</span>{" "}
              to add your first node.
            </div>
          ) : (
            <div className="relative min-h-0 flex-1 overflow-hidden rounded-md border">
              <PipelineCanvas
                doc={doc}
                selectedIds={selectedIds}
                errorIds={errorIds}
                onSelectNode={handleSelectNode}
                onMoveItems={handleMoveItems}
                onMoveEnd={handleMoveEnd}
                onConnect={(from, to) => setDoc((d) => connect(d, from, to))}
                onDisconnect={(from, to) =>
                  setDoc((d) => disconnect(d, from, to))
                }
                onDuplicateNode={handleDuplicate}
                onDeleteItem={handleConfirmDeleteItem}
                onCopyId={handleContextCopyId}
                onGoToDefinitions={handleGoToDefinitions}
                onDropSnippet={handleSnippetDrop}
                scrollRef={canvasScrollRef}
                panEnabled
              />
              <Minimap
                doc={doc}
                selectedIds={selectedIds}
                scrollRef={canvasScrollRef}
                className="absolute top-2 right-2 z-10"
              />
            </div>
          )}
        </div>

        {/* RIGHT column — edit panel (node or note), only when something is selected.
             On mobile (< lg) it fills the full width and appears below the canvas;
             the scrollIntoView effect above brings it into view on selection. */}
        <WorkflowInspector
          doc={doc}
          primaryNode={primaryNode}
          primaryNote={primaryNote}
          primaryId={primaryId}
          editPanelRef={editPanelRef}
          taskRef={taskRef}
          showRefMenu={showRefMenu}
          setShowRefMenu={setShowRefMenu}
          onDuplicate={handleDuplicate}
          onConfirmDelete={handleConfirmDeleteItem}
          onCommitRename={commitRename}
          onPatch={patch}
          onPatchTransient={patchTransient}
          onPatchNote={patchNote}
          onCommit={commit}
          onInsertRef={handleInsertRef}
          setDoc={setDoc}
        />
      </div>

      {/* 4. Agents panel — collapsible, open by default */}
      <CollapsibleSection title="Agents" icon={Layers} defaultOpen={true}>
        <AgentsPanel onSelectSnippet={handleSnippetSelect} />
      </CollapsibleSection>

      {/* 5. Validation */}
      {doc.nodes.length > 0 &&
        (valid ? (
          <p className="flex-shrink-0 text-xs font-medium text-emerald-600 dark:text-emerald-400">
            ✓ Valid — {doc.nodes.length} step
            {doc.nodes.length === 1 ? "" : "s"}.
          </p>
        ) : (
          <ul className="flex flex-shrink-0 flex-col gap-1 rounded-md bg-red-500/10 p-2.5 text-xs text-red-600 dark:text-red-400">
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

      {/* 6. Conductor session */}
      <label className="flex flex-shrink-0 flex-col gap-1 text-sm">
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

      {/* 7. Amber tip */}
      <p className="text-muted-foreground flex-shrink-0 rounded-md bg-amber-500/10 px-3 py-2 text-xs leading-relaxed">
        Any step that writes code runs in its own throwaway git worktree off the
        base branch, so it never touches your checkout.
      </p>

      {/* 8. Start pipeline */}
      <Button
        onClick={handleStart}
        disabled={!canStart}
        className="w-full flex-shrink-0 sm:w-auto sm:self-start"
      >
        {start.isPending ? (
          <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
        ) : (
          <Play className="mr-1.5 h-4 w-4" />
        )}
        Start pipeline
      </Button>

      {/* 9. Dialogs */}
      <Dialog open={shortcutsOpen} onOpenChange={setShortcutsOpen}>
        <DialogContent showCloseButton={false}>
          <DialogTitle className="sr-only">
            Workflow builder shortcuts
          </DialogTitle>
          <DialogDescription className="sr-only">
            Keyboard shortcuts available on the workflow builder canvas.
          </DialogDescription>
          <WorkflowsShortcuts onClose={() => setShortcutsOpen(false)} />
        </DialogContent>
      </Dialog>

      <Dialog
        open={pasteOpen}
        onOpenChange={(open) => {
          setPasteOpen(open);
          if (!open) setPasteText("");
        }}
      >
        <DialogContent>
          <DialogTitle>Paste workflow JSON</DialogTitle>
          <DialogDescription>
            Paste a saved workflow or a bare pipeline spec — positions will be
            seeded automatically.
          </DialogDescription>
          <Textarea
            value={pasteText}
            onChange={(e) => setPasteText(e.target.value)}
            placeholder={'{ "name": "...", "steps": [...] }'}
            spellCheck={false}
            className="min-h-[160px] font-mono text-xs"
          />
          <div className="flex items-center justify-between gap-2">
            <span
              className={cn(
                "text-xs",
                pastePreview.ok === false && "text-red-600",
                pastePreview.ok === true &&
                  "text-emerald-600 dark:text-emerald-400",
                pastePreview.ok === null && "text-muted-foreground"
              )}
            >
              {pastePreview.ok === false
                ? "That JSON doesn't look like a workflow."
                : pastePreview.ok === true
                  ? `${pastePreview.count} step${pastePreview.count === 1 ? "" : "s"} ready to import${pastePreview.name ? ` (${pastePreview.name})` : ""}`
                  : "Paste JSON above to preview"}
            </span>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  setPasteOpen(false);
                  setPasteText("");
                }}
              >
                Cancel
              </Button>
              <Button
                type="button"
                size="sm"
                onClick={handlePasteImport}
                disabled={pastePreview.ok !== true}
              >
                Import
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
