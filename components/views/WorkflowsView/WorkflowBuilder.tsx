"use client";

import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { toast } from "sonner";
import {
  Check,
  ClipboardPaste,
  Copy,
  Download,
  FileJson,
  FolderOpen,
  Fullscreen,
  GitBranch,
  HelpCircle,
  Loader2,
  Play,
  Plus,
  Redo2,
  Save,
  Sparkles,
  StickyNote,
  Trash2,
  Undo2,
  Upload,
  Wand2,
  X,
} from "lucide-react";
import {
  addNote,
  addPresetStep,
  addStep,
  connect,
  deleteNodes,
  disconnect,
  docFromImportedJson,
  docFromSpec,
  docToSpec,
  duplicateNodes,
  duplicateStep,
  insertOutputRef,
  moveNode,
  moveNote,
  nextAutoPosition,
  outputRefToken,
  relayout,
  renameStep,
  serializeBuilderDoc,
  setDependsOn,
  setProject,
  setWorktree,
  updateNote,
  updateStep,
  CANVAS,
  type BuilderDoc,
  type HistorySnapshot,
} from "@/lib/pipeline/builder-model";
import { WORKFLOW_SNIPPETS } from "@/lib/pipeline/snippets";
import { validateSpec } from "@/lib/pipeline/engine";
import { getModelOptions } from "@/lib/model-catalog";
import { useStartRun } from "@/data/pipelines/queries";
import { useGenerateWorkflow } from "@/data/chat/useCommand";
import { useProjectsQuery } from "@/data/projects/queries";
import { useWorktrees, type StoaWorktree } from "@/data/worktrees/queries";
import {
  useSavedWorkflows,
  useCreateSavedWorkflow,
  useUpdateSavedWorkflow,
  useDeleteSavedWorkflow,
} from "@/data/saved-workflows/queries";
import { AGENT_OPTIONS } from "@/components/NewSessionDialog/NewSessionDialog.types";
import type { AgentType } from "@/lib/providers";
import { useConfirm } from "@/components/ConfirmProvider";
import { copyText } from "@/lib/clipboard";
import { cn } from "@/lib/utils";
import { PipelineCanvas } from "./PipelineCanvas";
import { Minimap } from "./Minimap";
import { WorkflowsShortcuts } from "./WorkflowsShortcuts";
import { SnippetsPanel } from "./SnippetsPanel";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
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
import { useGlobalKeybindings } from "@/hooks/useGlobalKeybindings";
import { useBuilderHistory } from "@/hooks/useBuilderHistory";
import type { Keybinding } from "@/lib/keybindings";

const EMPTY_DOC: BuilderDoc = {
  name: "My workflow",
  workingDirectory: "~/my-project",
  nodes: [],
  notes: [],
};

/** Format a stored ISO timestamp for display, falling back to the raw string
 * (rather than "Invalid Date") if a hand-edited/legacy row holds garbage. */
function formatSnapshotTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

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
      task: `Using these findings:\n${outputRefToken("research")}\nimplement the fix.`,
      dependsOn: ["research"],
      exitCriteria: "The change MUST pass the test suite. Open a PR when done.",
    },
  ],
});

function worktreeBaseName(p: string) {
  return p.split(/[/\\]/).filter(Boolean).pop() || p;
}

function worktreeLabel(w: StoaWorktree) {
  return `${w.branch || worktreeBaseName(w.path)}${w.attached ? " (in use)" : ""}`;
}

function availableWorktrees(
  doc: BuilderDoc,
  worktrees: StoaWorktree[],
  projectDir?: string
): StoaWorktree[] {
  // When a project is selected, only show worktrees that belong to the same repo.
  if (!doc.projectId) return worktrees;
  const base = projectDir || doc.workingDirectory;
  return worktrees.filter((w) => w.projectId === base);
}

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
  const { doc, committedDoc, setDoc, reset, undo, redo, canUndo, canRedo } =
    useBuilderHistory(EMPTY_DOC);
  const { data: projects = [] } = useProjectsQuery();
  const { data: worktrees = [] } = useWorktrees();
  const selectedProject = projects.find((p) => p.id === doc.projectId);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [primaryId, setPrimaryId] = useState<string | null>(null);
  const canvasScrollRef = useRef<HTMLDivElement | null>(null);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState("");
  // Assisted generator (top bar): describe a goal → an agent designs the workflow.
  const [genSummary, setGenSummary] = useState("");
  const [genProvider, setGenProvider] = useState<"claude" | "codex">("claude");
  const [genModel, setGenModel] = useState(""); // "" → the agent's default model
  // A prose reply from the designer (a clarifying question, or why it couldn't
  // design one). Shown inline (not a fleeting toast) so the user can act on it.
  const [genAnswer, setGenAnswer] = useState<string | null>(null);
  const generate = useGenerateWorkflow();
  // Bring the edit panel into view when a node is selected — on a phone it sits
  // below a tall canvas, so tapping a node would otherwise open a form off-screen.
  const editRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (primaryId) editRef.current?.scrollIntoView({ block: "nearest" });
  }, [primaryId]);

  // The Task field's "insert an upstream step's output" affordance.
  const taskRef = useRef<HTMLTextAreaElement>(null);
  const [showRefMenu, setShowRefMenu] = useState(false);
  // Collapse the menu whenever the selected step changes.
  useEffect(() => setShowRefMenu(false), [primaryId]);
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
  // Unsaved-changes signal: the last committed doc differs from the last
  // save/load. Keyed off the committed frame (not the live `doc`) so an
  // in-flight drag doesn't re-serialize the whole doc on every pointer frame.
  const dirty = useMemo(
    () => serializeBuilderDoc(committedDoc) !== savedSnapshot,
    [committedDoc, savedSnapshot]
  );
  const currentSaved = useMemo(
    () => savedList.data?.find((w) => w.id === savedId) ?? null,
    [savedList.data, savedId]
  );

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

  function clearSelection() {
    setSelectedIds(new Set());
    setPrimaryId(null);
  }

  function handleGoToDefinitions(id: string) {
    handleSelectNode(id);
    // The useEffect keyed on primaryId scrolls automatically on a new selection,
    // but only when the value changes. Force a scroll for repeated menu clicks.
    requestAnimationFrame(() => {
      editRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    });
  }

  function handleSelectNode(
    id: string | null,
    opts?: {
      shiftKey?: boolean;
      addToSelection?: boolean;
      keepSelection?: boolean;
    }
  ) {
    if (id === null) {
      clearSelection();
      return;
    }
    if (opts?.keepSelection) {
      setPrimaryId(id);
      return;
    }
    const shift = opts?.shiftKey ?? opts?.addToSelection ?? false;
    if (shift) {
      const next = new Set(selectedIds);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      setSelectedIds(next);
      setPrimaryId(next.has(id) ? id : next.size > 0 ? [...next][0] : null);
    } else {
      setSelectedIds(new Set([id]));
      setPrimaryId(id);
    }
  }

  function handleUndo() {
    undo();
    clearSelection();
  }

  function handleRedo() {
    redo();
    clearSelection();
  }

  function handleDuplicate(id?: string) {
    if (id) {
      const next = duplicateStep(doc, id);
      if (next === doc) return;
      setDoc(next);
      const copy = next.nodes[next.nodes.length - 1];
      setSelectedIds(new Set([copy.step.id]));
      setPrimaryId(copy.step.id);
      return;
    }
    const stepIds = [...selectedIds].filter((sid) =>
      doc.nodes.some((n) => n.step.id === sid)
    );
    if (stepIds.length === 0) return;
    const beforeIds = new Set(doc.nodes.map((n) => n.step.id));
    const next = duplicateNodes(doc, stepIds);
    if (next === doc) return;
    setDoc(next);
    const newIds = next.nodes
      .filter((n) => !beforeIds.has(n.step.id))
      .map((n) => n.step.id);
    setSelectedIds(new Set(newIds));
    setPrimaryId(newIds[0] ?? null);
  }

  function handleMoveItems(updates: { id: string; x: number; y: number }[]) {
    setDoc(
      (d) =>
        updates.reduce((acc, { id, x, y }) => {
          if (acc.nodes.some((n) => n.step.id === id))
            return moveNode(acc, id, x, y);
          if (acc.notes.some((n) => n.id === id))
            return moveNote(acc, id, x, y);
          return acc;
        }, d),
      { transient: true }
    );
  }

  function handleMoveEnd() {
    setDoc((d) => d);
  }

  function handleDeleteItem(id: string) {
    const next = deleteNodes(doc, [id]);
    setDoc(next);
    const remaining = new Set(selectedIds);
    remaining.delete(id);
    setSelectedIds(remaining);
    if (primaryId === id) {
      setPrimaryId(remaining.size > 0 ? [...remaining][0] : null);
    }
  }

  async function handleConfirmDeleteItem(id: string) {
    if (
      !(await confirm({
        title: "Delete this item?",
        description: "This can’t be undone.",
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
        description: `Delete ${ids.length} selected item${ids.length === 1 ? "" : "s"}? This can’t be undone.`,
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

  type PastePreview =
    | { ok: null; count: number; name: string }
    | { ok: false; count: number; name: string }
    | { ok: true; count: number; name: string };

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
      toast.error("That JSON isn’t a valid workflow.");
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

  function handleAdd() {
    // Cascade new nodes so they don't stack on top of each other; the user drags
    // them where they want.
    const { x, y } = nextAutoPosition(doc);
    const next = addStep(doc, x, y);
    setDoc(next);
    const id = next.nodes[next.nodes.length - 1].step.id;
    setSelectedIds(new Set([id]));
    setPrimaryId(id);
  }

  function handleAddNote() {
    const { x, y } = nextAutoPosition(doc);
    const next = addNote(doc, x + 16, y + 16, "New note");
    setDoc(next);
    const id = next.notes[next.notes.length - 1].id;
    setSelectedIds(new Set([id]));
    setPrimaryId(id);
  }

  function patchNote(id: string, text: string) {
    setDoc((d) => updateNote(d, id, text), { transient: true });
  }

  function loadDoc(next: BuilderDoc, savedWorkflowId: string | null) {
    reset(next);
    clearSelection();
    setSavedId(savedWorkflowId);
    setSavedSnapshot(serializeBuilderDoc(next)); // freshly loaded = no unsaved changes
  }

  // Returns false (after a toast) if the canvas isn't ready to save, so the menu
  // item can stay enabled and TEACH why — a disabled item gives a phone tap no
  // feedback at all.
  function saveGuard(): string | null {
    const name = doc.name.trim();
    if (doc.nodes.length === 0 && doc.notes.length === 0) {
      toast.error("Add a step or note first.");
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
    const snapshot = serializeBuilderDoc(doc);
    try {
      if (savedId) {
        await updateWf.mutateAsync({ id: savedId, name, doc });
      } else {
        const created = await createWf.mutateAsync({ name, doc });
        setSavedId(created.id);
      }
      setSavedSnapshot(snapshot); // now persisted = no unsaved changes
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
    const snapshot = serializeBuilderDoc(doc);
    try {
      const created = await createWf.mutateAsync({ name, doc });
      setSavedId(created.id);
      setSavedSnapshot(snapshot);
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
        toast.error("That file isn’t a valid workflow JSON.");
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

  function patchTransient(id: string, p: Parameters<typeof updateStep>[2]) {
    setDoc((d) => updateStep(d, id, p), { transient: true });
  }

  function commit() {
    setDoc((d) => d);
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

  function commitRename(oldId: string, raw: string) {
    const newId = raw.trim();
    if (!newId || newId === oldId) return;
    const next = renameStep(doc, oldId, newId);
    if (next === doc) {
      toast.error(`Step id “${newId}” is already taken`);
      return;
    }
    setDoc(next);
    setSelectedIds(new Set([newId]));
    setPrimaryId(newId);
  }

  async function handleContextCopyId(id: string) {
    if (await copyText(id)) {
      toast.success(`Copied id “${id}”`);
    } else {
      toast.error("Could not copy to clipboard");
    }
  }

  function handleSnippetSelect(snippetId: string) {
    const snippet = WORKFLOW_SNIPPETS.find((s) => s.id === snippetId);
    if (!snippet) return;
    const next = addPresetStep(doc, snippet);
    setDoc(next);
    const id = next.nodes[next.nodes.length - 1].step.id;
    setSelectedIds(new Set([id]));
    setPrimaryId(id);
  }

  async function handleGenerate() {
    const summary = genSummary.trim();
    if (!summary) {
      toast.error("Describe what you want to build first.");
      return;
    }
    if (!doc.projectId) {
      toast.error("Pick a Project context below first.");
      return;
    }
    // Generating REPLACES the canvas — guard unsaved work (confirm-if-dirty,
    // mirroring loadSnapshot). A clean/empty canvas loads straight away.
    if (
      dirty &&
      !(await confirm({
        title: "Replace the current draft?",
        description:
          "Generating designs a fresh workflow and loads it onto the canvas. Unsaved changes will be lost.",
      }))
    ) {
      return;
    }
    setGenAnswer(null); // clear any prior reply before a fresh attempt
    try {
      const reply = await generate.mutateAsync({
        summary,
        projectId: doc.projectId,
        provider: genProvider,
        model: genModel || undefined,
      });
      if (reply.kind === "workflow") {
        loadDoc(reply.doc, null); // a fresh, unsaved, undoable draft
        toast.success(
          `Designed a ${reply.doc.nodes.length}-step workflow — review and tweak, then Start.`
        );
      } else {
        // The designer answered in prose (a clarifying question, or why it
        // couldn't) — surface it INLINE (it may need the user to act) and leave
        // the canvas untouched.
        setGenAnswer(reply.text);
      }
    } catch (e) {
      toast.error(
        e instanceof Error ? e.message : "Failed to generate the workflow"
      );
    }
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
    <div className="flex h-full min-h-0 flex-col gap-4">
      {/* Assisted generator: describe a goal → an agent DESIGNS the workflow and
          loads it onto the canvas for review. Nothing runs until you hit Start. */}
      <div
        className="bg-card/40 flex flex-shrink-0 flex-col gap-2 rounded-md border p-3"
        aria-busy={generate.isPending}
      >
        <div className="flex items-center gap-1.5">
          <Sparkles className="text-primary h-4 w-4" />
          <span className="text-sm font-medium">Design a workflow with AI</span>
        </div>
        <Textarea
          value={genSummary}
          onChange={(e) => setGenSummary(e.target.value)}
          placeholder="Describe what to build — e.g. “a Stripe billing page with full tests and a review gate”. An agent designs the workflow; you review and edit before anything runs."
          rows={2}
          disabled={generate.isPending}
          aria-label="Describe what to build"
        />
        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={genProvider}
            onValueChange={(v) => {
              setGenProvider(v as "claude" | "codex");
              setGenModel(""); // model catalog is per-provider; reset to default
            }}
            disabled={generate.isPending}
          >
            <SelectTrigger className="w-28" aria-label="Designer agent">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="claude">Claude</SelectItem>
              <SelectItem value="codex">Codex</SelectItem>
            </SelectContent>
          </Select>
          <Select
            value={genModel || "default"}
            onValueChange={(v) => setGenModel(v === "default" ? "" : v)}
            disabled={generate.isPending}
          >
            <SelectTrigger className="w-40" aria-label="Designer model">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="default">
                <span className="text-muted-foreground">Default model</span>
              </SelectItem>
              {getModelOptions(genProvider).map((m) => (
                <SelectItem key={m.value} value={m.value}>
                  {m.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            type="button"
            size="sm"
            onClick={handleGenerate}
            disabled={
              generate.isPending || !genSummary.trim() || !doc.projectId
            }
            title={
              !doc.projectId
                ? "Pick a Project context below first"
                : "Design a workflow for this goal"
            }
          >
            {generate.isPending ? (
              <>
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />{" "}
                Designing…
              </>
            ) : (
              <>
                <Sparkles className="mr-1.5 h-3.5 w-3.5" /> Generate
              </>
            )}
          </Button>
          {!doc.projectId && (
            <span className="text-muted-foreground text-[11px]">
              Pick a <span className="font-medium">Project context</span> below
              first.
            </span>
          )}
        </div>
        {genAnswer && (
          <div className="bg-muted/50 text-muted-foreground flex items-start justify-between gap-2 rounded-md border px-3 py-2 text-xs leading-relaxed">
            <p className="min-w-0 whitespace-pre-wrap">{genAnswer}</p>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Dismiss reply"
              className="-mt-1 -mr-1 flex-shrink-0"
              onClick={() => setGenAnswer(null)}
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
        )}
      </div>

      <div className="flex flex-shrink-0 flex-wrap items-center justify-between gap-2">
        <div className="flex flex-shrink-0 flex-wrap items-center justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            aria-label="Undo"
            title="Undo"
            disabled={!canUndo}
            onClick={handleUndo}
          >
            <Undo2 className="h-3.5 w-3.5" />
          </Button>
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            aria-label="Redo"
            title="Redo"
            disabled={!canRedo}
            onClick={handleRedo}
          >
            <Redo2 className="h-3.5 w-3.5" />
          </Button>
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            aria-label="Center all items"
            title="Center all items"
            disabled={doc.nodes.length === 0 && doc.notes.length === 0}
            onClick={handleFitAll}
          >
            <Fullscreen className="h-3.5 w-3.5" />
          </Button>
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            aria-label="Keyboard shortcuts"
            title="Keyboard shortcuts"
            onClick={() => setShortcutsOpen(true)}
          >
            <HelpCircle className="h-3.5 w-3.5" />
          </Button>
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
              <DropdownMenuItem onSelect={startBlankWorkflow}>
                <Plus className="mr-2 h-3.5 w-3.5" /> New workflow
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={loadExampleWorkflow}>
                <FileJson className="mr-2 h-3.5 w-3.5" /> Load example
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => fileRef.current?.click()}>
                <Upload className="mr-2 h-3.5 w-3.5" /> Import workflow…
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setPasteOpen(true)}>
                <ClipboardPaste className="mr-2 h-3.5 w-3.5" /> Paste JSON
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={handleExport}
                disabled={doc.nodes.length === 0 && doc.notes.length === 0}
              >
                <Download className="mr-2 h-3.5 w-3.5" /> Export workflow
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={handleCopyJson}
                disabled={doc.nodes.length === 0 && doc.notes.length === 0}
              >
                <Copy className="mr-2 h-3.5 w-3.5" /> Copy JSON
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
              {currentSaved && currentSaved.history.length > 0 && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuLabel>History</DropdownMenuLabel>
                  {currentSaved.history.map((snapshot) => (
                    <DropdownMenuItem
                      key={snapshot.id}
                      onSelect={() => loadSnapshot(snapshot)}
                      className="flex flex-col items-start gap-0.5"
                    >
                      <span className="truncate text-xs">{snapshot.name}</span>
                      <span className="text-muted-foreground text-[10px]">
                        {formatSnapshotTime(snapshot.createdAt)}
                      </span>
                    </DropdownMenuItem>
                  ))}
                </>
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
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleAddNote}
          >
            <StickyNote className="mr-1.5 h-3.5 w-3.5" /> Add note
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground text-xs">Workflow name</span>
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
          <span className="text-muted-foreground text-xs">Project context</span>
          <Select
            value={doc.projectId || "none"}
            onValueChange={(v) => {
              const id = v === "none" ? null : v;
              const project = projects.find((p) => p.id === id);
              setDoc((d) => setProject(d, id, project?.working_directory));
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
              setDoc((d) => setWorktree(d, wt?.path ?? null, wt?.projectId));
            }}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="new">
                <span className="text-muted-foreground">New worktree</span>
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
              setDoc((d) => ({ ...d, workingDirectory: e.target.value }), {
                transient: true,
              })
            }
            onBlur={commit}
          />
        </label>
      </div>

      {doc.nodes.length === 0 && doc.notes.length === 0 ? (
        <div className="text-muted-foreground flex min-h-[180px] flex-1 items-center justify-center rounded-md border border-dashed px-3 text-center text-xs">
          No steps yet — tap <span className="font-medium">Add step</span> to
          add your first node.
        </div>
      ) : (
        <div className="relative min-h-[360px] flex-1 overflow-hidden rounded-md border">
          <PipelineCanvas
            doc={doc}
            selectedIds={selectedIds}
            errorIds={errorIds}
            onSelectNode={handleSelectNode}
            onMoveItems={handleMoveItems}
            onMoveEnd={handleMoveEnd}
            onConnect={(from, to) => setDoc((d) => connect(d, from, to))}
            onDisconnect={(from, to) => setDoc((d) => disconnect(d, from, to))}
            onDuplicateNode={handleDuplicate}
            onDeleteItem={handleConfirmDeleteItem}
            onCopyId={handleContextCopyId}
            onGoToDefinitions={handleGoToDefinitions}
            scrollRef={canvasScrollRef}
          />
          <Minimap
            doc={doc}
            selectedIds={selectedIds}
            scrollRef={canvasScrollRef}
            className="absolute top-2 right-2 z-10"
          />
        </div>
      )}

      {selectedIds.size > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-muted-foreground text-xs">
            {selectedIds.size} selected
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={
              ![...selectedIds].some((id) =>
                doc.nodes.some((n) => n.step.id === id)
              )
            }
            onClick={() => handleDuplicate()}
          >
            <Copy className="mr-1.5 h-3.5 w-3.5" /> Duplicate
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleDeleteSelected}
          >
            <Trash2 className="mr-1.5 h-3.5 w-3.5" /> Delete
          </Button>
        </div>
      )}

      <SnippetsPanel onSelectSnippet={handleSnippetSelect} />

      {/* Edit panel for the selected item (node or note). */}
      {primaryNode && (
        <div
          ref={editRef}
          key={primaryNode.step.id}
          className="bg-card flex flex-col gap-3 rounded-md border p-3"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm font-medium">Edit step</span>
            <div className="flex items-center gap-1">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => handleDuplicate()}
                title="Duplicate step (Ctrl/Cmd+D)"
              >
                <Copy className="mr-1.5 h-3.5 w-3.5" /> Duplicate
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="text-red-600 hover:text-red-600 dark:text-red-400"
                onClick={() => handleConfirmDeleteItem(primaryNode.step.id)}
              >
                <Trash2 className="mr-1.5 h-3.5 w-3.5" /> Delete
              </Button>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-muted-foreground text-xs">
                Step id <span className="text-red-500">*</span>
              </span>
              <Input
                key={primaryNode.step.id}
                defaultValue={primaryNode.step.id}
                spellCheck={false}
                // Commit on blur (so we don't rename on every keystroke) — and on
                // Enter, which blurs, so a phone user who taps straight to Start
                // doesn't lose the edit.
                onKeyDown={(e) => {
                  if (e.key === "Enter") e.currentTarget.blur();
                }}
                onBlur={(e) =>
                  commitRename(primaryNode.step.id, e.target.value)
                }
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-muted-foreground text-xs">
                Name (optional)
              </span>
              <Input
                value={primaryNode.step.name ?? ""}
                onChange={(e) =>
                  patchTransient(primaryNode.step.id, {
                    name: e.target.value || undefined,
                  })
                }
                onBlur={commit}
              />
            </label>
          </div>

          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground text-xs">Agent</span>
            <Select
              value={primaryNode.step.agent}
              onValueChange={(v) =>
                patch(primaryNode.step.id, { agent: v as AgentType })
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
              ref={taskRef}
              value={primaryNode.step.task}
              spellCheck={false}
              placeholder="What this agent should do. Reference an upstream step's output with {{steps.<id>.output}}."
              onChange={(e) =>
                patchTransient(primaryNode.step.id, { task: e.target.value })
              }
              onBlur={commit}
              className="min-h-[80px]"
            />
            {/* Insert a valid {{steps.<id>.output}} reference (no hand-typing /
                typos) — picking a step also adds it as a dependency. */}
            {doc.nodes.length > 1 && (
              <div className="flex flex-col gap-1">
                <button
                  type="button"
                  onClick={() => setShowRefMenu((v) => !v)}
                  className="text-muted-foreground hover:text-foreground self-start text-xs underline-offset-2 hover:underline"
                >
                  + Insert an upstream step&apos;s output
                </button>
                {showRefMenu && (
                  <div className="flex flex-col gap-0.5 rounded-md border p-1">
                    <span className="text-muted-foreground px-2 py-1 text-[11px]">
                      Inserts the reference and adds the step as a dependency.
                    </span>
                    {doc.nodes
                      .filter((n) => n.step.id !== primaryNode.step.id)
                      .map((n) => (
                        <button
                          key={n.step.id}
                          type="button"
                          onClick={() => handleInsertRef(n.step.id)}
                          title={`Insert ${outputRefToken(n.step.id)} and depend on this step`}
                          className="hover:bg-accent flex items-center gap-2 rounded px-2 py-1 text-left text-xs"
                        >
                          <span className="truncate font-medium">
                            {n.step.name || n.step.id}
                          </span>
                          <span className="text-muted-foreground truncate font-mono">
                            {outputRefToken(n.step.id)}
                          </span>
                        </button>
                      ))}
                  </div>
                )}
              </div>
            )}
          </label>

          {/* dependsOn — a checklist of the other step ids (the house multi-select
              idiom; the same edges you can draw by dragging a node's port). */}
          {doc.nodes.length > 1 && (
            <div className="flex flex-col gap-1 text-sm">
              <span className="text-muted-foreground text-xs">Depends on</span>
              <div className="flex flex-col gap-1 rounded-md border p-2">
                {doc.nodes
                  .filter((n) => n.step.id !== primaryNode.step.id)
                  .map((n) => {
                    const checked =
                      primaryNode.step.dependsOn?.includes(n.step.id) ?? false;
                    return (
                      <div
                        key={n.step.id}
                        className="flex items-center justify-between gap-2 text-xs"
                      >
                        <label className="flex flex-1 cursor-pointer items-center gap-2">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={(e) => {
                              const cur = primaryNode.step.dependsOn ?? [];
                              const next = e.target.checked
                                ? [...cur, n.step.id]
                                : cur.filter((d) => d !== n.step.id);
                              setDoc((d) =>
                                setDependsOn(d, primaryNode.step.id, next)
                              );
                            }}
                          />
                          {n.step.name || n.step.id}
                        </label>
                        {checked && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            aria-label={`Remove dependency on ${n.step.name || n.step.id}`}
                            title="Remove dependency"
                            onClick={() =>
                              setDoc((d) =>
                                disconnect(d, n.step.id, primaryNode.step.id)
                              )
                            }
                          >
                            <X className="h-3 w-3" />
                          </Button>
                        )}
                      </div>
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
              value={primaryNode.step.exitCriteria ?? ""}
              spellCheck={false}
              placeholder="Unbreakable rules the step must satisfy, e.g. “must pass tests; open a PR”."
              onChange={(e) =>
                patchTransient(primaryNode.step.id, {
                  exitCriteria: e.target.value || undefined,
                })
              }
              onBlur={commit}
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
              checked={primaryNode.step.worktreePolicy === "shared"}
              onCheckedChange={(c) =>
                patch(primaryNode.step.id, {
                  worktreePolicy: c ? "shared" : undefined,
                })
              }
            />
          </label>
        </div>
      )}

      {primaryNote && (
        <div
          ref={editRef}
          key={primaryNote.id}
          className="bg-card flex flex-col gap-3 rounded-md border p-3"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm font-medium">Edit note</span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="text-red-600 hover:text-red-600 dark:text-red-400"
              onClick={() => handleConfirmDeleteItem(primaryNote.id)}
            >
              <Trash2 className="mr-1.5 h-3.5 w-3.5" /> Delete
            </Button>
          </div>
          <Textarea
            value={primaryNote.text}
            spellCheck={false}
            placeholder="Write a note…"
            onChange={(e) => patchNote(primaryNote.id, e.target.value)}
            onBlur={commit}
            className="min-h-[80px]"
          />
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
                ? "That JSON doesn’t look like a workflow."
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
