/**
 * Visual workflow builder — PURE document model. A BuilderDoc is a PipelineSpec
 * plus a canvas position (x/y) per step, so the visual canvas can place and drag
 * nodes while staying a faithful view of an executable spec. Every operation
 * returns a NEW doc (immutable) and is I/O-free, so the whole builder is driven
 * by exhaustively unit-testable transitions — the same pure-core / thin-shell
 * split as the pipeline engine.
 *
 * Positions are seeded from the read-only layout (layoutDag) and then overridable
 * by dragging; they are NOT part of the spec (PipelineSpec has no coordinates), so
 * a round-trip through JSON re-seeds them from the topology. That's intentional —
 * the executable contract stays clean; the layout is a builder-only affordance.
 */

import type { PipelineSpec, PipelineStep } from "./types";
import type { AgentType } from "../providers";
import { layoutDag } from "./graph-layout";
import { parsePipelineSpec } from "./engine";

/** Canvas geometry (1 SVG user-unit = 1 px, matching PipelineGraph). Roomier than
 * the read-only graph — these nodes are tap/drag targets, so mobile-first sizing. */
export const CANVAS = {
  NODE_W: 160,
  NODE_H: 48,
  NOTE_W: 160,
  NOTE_H: 80,
  COL_W: 210, // column pitch when seeding from layout depth
  ROW_H: 96, // row pitch
  PAD: 16,
} as const;

export interface BuilderNode {
  step: PipelineStep;
  x: number;
  y: number;
}

export interface BuilderNote {
  id: string;
  text: string;
  x: number;
  y: number;
  color?: "yellow";
}

export interface BuilderDoc {
  name: string;
  workingDirectory: string;
  /** Optional selected project id that owns the working directory. */
  projectId?: string | null;
  /** Optional Stoa-managed worktree path the pipeline should run against. */
  worktreePath?: string | null;
  nodes: BuilderNode[];
  notes: BuilderNote[];
}

export interface HistorySnapshot {
  id: string;
  name: string;
  doc: BuilderDoc;
  createdAt: string;
}

/** A persisted builder doc with its store identity + timestamps (the API shape). */
export interface SavedWorkflow {
  id: string;
  name: string;
  doc: BuilderDoc;
  history: HistorySnapshot[];
  createdAt: string;
  updatedAt: string;
}

/** Serialize a doc for storage. */
export function serializeBuilderDoc(doc: BuilderDoc): string {
  return JSON.stringify(doc);
}

/**
 * Parse a stored doc defensively — a hand-edited or legacy row must never crash a
 * load. Returns null on anything that isn't a well-formed doc; drops malformed
 * nodes/notes rather than failing the whole doc (mirrors the snippets-store shape guard).
 */
export function parseBuilderDoc(raw: string): BuilderDoc | null {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (typeof o.name !== "string" || typeof o.workingDirectory !== "string") {
    return null;
  }
  if (!Array.isArray(o.nodes)) return null;
  const nodes: BuilderNode[] = [];
  for (const n of o.nodes) {
    if (!n || typeof n !== "object") continue;
    const node = n as Record<string, unknown>;
    const raw = node.step as Record<string, unknown> | undefined;
    if (
      !raw ||
      typeof raw.id !== "string" ||
      typeof raw.task !== "string" ||
      typeof raw.agent !== "string" ||
      typeof node.x !== "number" ||
      typeof node.y !== "number"
    ) {
      continue;
    }
    // Whitelist the known fields with per-field type checks rather than casting
    // the raw object through — this is a trust boundary (the API stores whatever
    // parses), so a malformed `dependsOn` (or any junk field) must NOT ride into a
    // stored doc and later throw in validateSpec or reach a spawn.
    const step: PipelineStep = {
      id: raw.id,
      agent: raw.agent as PipelineStep["agent"],
      task: raw.task,
    };
    if (typeof raw.name === "string") step.name = raw.name;
    if (typeof raw.model === "string") step.model = raw.model;
    if (
      Array.isArray(raw.dependsOn) &&
      raw.dependsOn.every((d) => typeof d === "string")
    ) {
      step.dependsOn = raw.dependsOn as string[];
    }
    if (typeof raw.workingDirectory === "string") {
      step.workingDirectory = raw.workingDirectory;
    }
    if (typeof raw.outputFile === "string") step.outputFile = raw.outputFile;
    if (typeof raw.exitCriteria === "string") {
      step.exitCriteria = raw.exitCriteria;
    }
    if (raw.worktreePolicy === "new" || raw.worktreePolicy === "shared") {
      step.worktreePolicy = raw.worktreePolicy;
    }
    nodes.push({ step, x: node.x, y: node.y });
  }
  const notes: BuilderNote[] = [];
  if (Array.isArray(o.notes)) {
    for (const n of o.notes) {
      if (!n || typeof n !== "object") continue;
      const note = n as Record<string, unknown>;
      if (
        typeof note.id !== "string" ||
        typeof note.text !== "string" ||
        typeof note.x !== "number" ||
        typeof note.y !== "number"
      ) {
        continue;
      }
      const built: BuilderNote = {
        id: note.id,
        text: note.text,
        x: note.x,
        y: note.y,
      };
      if (note.color === "yellow") built.color = note.color;
      notes.push(built);
    }
  }

  return {
    name: o.name,
    workingDirectory: o.workingDirectory,
    projectId: typeof o.projectId === "string" ? o.projectId : null,
    worktreePath: typeof o.worktreePath === "string" ? o.worktreePath : null,
    nodes,
    notes,
  };
}

/** Seed a builder doc from a spec, placing each node by its layout depth/row. */
export function docFromSpec(spec: PipelineSpec): BuilderDoc {
  const layout = layoutDag(spec);
  const placed = new Map(layout.nodes.map((n) => [n.id, n]));
  return {
    name: spec.name ?? "",
    workingDirectory: spec.workingDirectory ?? "",
    projectId: null,
    worktreePath: null,
    nodes: (spec.steps ?? []).map((step) => {
      const p = placed.get(step.id);
      return {
        step,
        x: CANVAS.PAD + (p?.level ?? 0) * CANVAS.COL_W,
        y: CANVAS.PAD + (p?.row ?? 0) * CANVAS.ROW_H,
      };
    }),
    notes: [],
  };
}

/** Project a builder doc back to an executable spec (drops positions). Order is
 * preserved so the resulting JSON reads in the same order the nodes were added. */
export function docToSpec(doc: BuilderDoc): PipelineSpec {
  return {
    name: doc.name,
    workingDirectory: doc.worktreePath || doc.workingDirectory,
    steps: doc.nodes.map((n) => n.step),
  };
}

/** Re-snap every node to the clean topological layout (columns by dependency
 * depth, rows by spec order), preserving the steps + edges. Tidies a hand-arranged
 * canvas — re-seeding positions from layoutDag exactly as a fresh load would. */
export function relayout(doc: BuilderDoc): BuilderDoc {
  return { ...docFromSpec(docToSpec(doc)), notes: doc.notes };
}

/**
 * Load an imported JSON string as a builder doc. Accepts EITHER a BuilderDoc
 * (canvas positions preserved) OR a bare PipelineSpec (positions seeded from the
 * layout) — so a workflow exported from the builder AND a spec authored in the
 * Custom tab both import. Null if the text is neither.
 */
export function docFromImportedJson(text: string): BuilderDoc | null {
  try {
    const doc = parseBuilderDoc(text);
    if (doc) return dedupeStepIds(doc); // a BuilderDoc (has name + workingDirectory + nodes[])
    const { spec } = parsePipelineSpec(text); // else a bare PipelineSpec?
    return spec ? dedupeStepIds(docFromSpec(spec)) : null;
  } catch {
    return null; // never throw — a bad import file is a null, not a crash
  }
}

/**
 * Rename any duplicate step ids so the imported doc renders with stable React
 * keys and intact dependency edges. The first occurrence keeps its id; later
 * collisions get a `uniqueStepId` suffix, and all `dependsOn` references are
 * rewritten to match.
 */
export function dedupeStepIds(doc: BuilderDoc): BuilderDoc {
  const renames = new Map<string, string>();
  const nodes: BuilderNode[] = [];
  for (const n of doc.nodes) {
    let id = n.step.id;
    if (
      nodes.some((existing) => existing.step.id === id) ||
      doc.notes.some((note) => note.id === id)
    ) {
      id = uniqueStepId({ ...doc, nodes }, id);
      renames.set(n.step.id, id);
    }
    nodes.push({ ...n, step: { ...n.step, id } });
  }
  const seen = new Set(nodes.map((n) => n.step.id));
  return {
    ...doc,
    nodes: nodes.map((n) => {
      if (!n.step.dependsOn) return n;
      return {
        ...n,
        step: {
          ...n.step,
          dependsOn: n.step.dependsOn.map((d) =>
            seen.has(d) ? d : (renames.get(d) ?? d)
          ),
        },
      };
    }),
  };
}

/** A fresh step id not already used by any node step or note. */
export function uniqueStepId(doc: BuilderDoc, base = "step"): string {
  const used = new Set([
    ...doc.nodes.map((n) => n.step.id),
    ...doc.notes.map((note) => note.id),
  ]);
  if (!used.has(base)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}`;
    if (!used.has(candidate)) return candidate;
  }
}

/** Set the selected project on a doc, keeping the working directory in sync. */
export function setProject(
  doc: BuilderDoc,
  projectId: string | null,
  projectDir?: string
): BuilderDoc {
  const next: BuilderDoc = {
    ...doc,
    projectId,
    worktreePath: null,
  };
  if (projectId && projectDir) {
    next.workingDirectory = projectDir;
  }
  return next;
}

/** Set the selected Stoa worktree on a doc, keeping the working directory in sync. */
export function setWorktree(
  doc: BuilderDoc,
  worktreePath: string | null,
  repoPath?: string
): BuilderDoc {
  const next: BuilderDoc = { ...doc, worktreePath };
  if (worktreePath) {
    // Prefer the owning repo path as the pipeline base so each step can create a
    // fresh worktree off the same repository; fall back to the worktree path itself.
    next.workingDirectory = repoPath || worktreePath;
  } else if (doc.projectId && repoPath) {
    next.workingDirectory = repoPath;
  }
  return next;
}

/** A fresh note id not already used by any node step or note. Delegates to
 * uniqueStepId, which already spans both nodes and notes — the two id spaces
 * share a namespace, so there is one allocator with two default bases. */
export function uniqueNoteId(doc: BuilderDoc, base = "note"): string {
  return uniqueStepId(doc, base);
}

/** The next grid slot used when auto-placing a new node (cascades so repeated
 * adds don't stack exactly on top of each other). */
export function nextAutoPosition(doc: BuilderDoc): { x: number; y: number } {
  const i = doc.nodes.length + doc.notes.length;
  return {
    x: CANVAS.PAD + (i % 4) * (CANVAS.NODE_W + 24),
    y: CANVAS.PAD + Math.floor(i / 4) * (CANVAS.NODE_H + 40),
  };
}

/** Append a new step at (x, y) with a unique id and the default agent. */
export function addStep(
  doc: BuilderDoc,
  x: number,
  y: number,
  agent: AgentType = "claude"
): BuilderDoc {
  const id = uniqueStepId(doc);
  return {
    ...doc,
    nodes: [...doc.nodes, { step: { id, agent, task: "" }, x, y }],
  };
}

/**
 * Append a step pre-filled from a template/snippet at the next auto-grid slot.
 * The id is derived from `preset.id` (made unique) and agent/task — plus optional
 * exitCriteria — are copied in. Pure twin of the snippets panel's "tap to add",
 * kept here so the construction is unit-tested rather than buried in the component.
 */
export function addPresetStep(
  doc: BuilderDoc,
  preset: { id: string; agent: AgentType; task: string; exitCriteria?: string }
): BuilderDoc {
  const id = uniqueStepId(doc, preset.id);
  const { x, y } = nextAutoPosition(doc);
  const step: PipelineStep = { id, agent: preset.agent, task: preset.task };
  if (preset.exitCriteria) step.exitCriteria = preset.exitCriteria;
  return { ...doc, nodes: [...doc.nodes, { step, x, y }] };
}

/** Move a node to (x, y), clamped to the top-left padding so it can't drift
 * off-canvas into negative space. */
export function moveNode(
  doc: BuilderDoc,
  id: string,
  x: number,
  y: number
): BuilderDoc {
  return {
    ...doc,
    nodes: doc.nodes.map((n) =>
      n.step.id === id ? { ...n, x: Math.max(0, x), y: Math.max(0, y) } : n
    ),
  };
}

/** Merge a patch into a step's fields (not its id — use renameStep for that). */
export function updateStep(
  doc: BuilderDoc,
  id: string,
  patch: Partial<Omit<PipelineStep, "id">>
): BuilderDoc {
  return {
    ...doc,
    nodes: doc.nodes.map((n) =>
      n.step.id === id ? { ...n, step: { ...n.step, ...patch } } : n
    ),
  };
}

/** Replace a step's dependency set (deduped, self-dep dropped). */
export function setDependsOn(
  doc: BuilderDoc,
  id: string,
  deps: string[]
): BuilderDoc {
  const clean = [...new Set(deps)].filter((d) => d !== id);
  return updateStep(doc, id, {
    dependsOn: clean.length ? clean : undefined,
  });
}

/**
 * Add a dependency edge `from → to` (i.e. `to` depends on `from`), as produced by
 * dragging a connector between two nodes on the canvas. A no-op for a self-edge,
 * an unknown target, or a duplicate. Permissive about cycles — validateSpec flags
 * a cycle so the UI shows it red, matching how the dependsOn checklist behaves.
 */
export function connect(doc: BuilderDoc, from: string, to: string): BuilderDoc {
  if (from === to) return doc;
  const target = doc.nodes.find((n) => n.step.id === to);
  if (!target) return doc;
  const deps = target.step.dependsOn ?? [];
  if (deps.includes(from)) return doc;
  return setDependsOn(doc, to, [...deps, from]);
}

/** Remove the dependency edge `from → to`. No-op if the target or edge is absent. */
export function disconnect(
  doc: BuilderDoc,
  from: string,
  to: string
): BuilderDoc {
  const target = doc.nodes.find((n) => n.step.id === to);
  const deps = target?.step.dependsOn ?? [];
  if (!deps.includes(from)) return doc;
  return setDependsOn(
    doc,
    to,
    deps.filter((d) => d !== from)
  );
}

/** Remove a step and strip its id from every other step's dependsOn. */
export function removeStep(doc: BuilderDoc, id: string): BuilderDoc {
  return {
    ...doc,
    nodes: doc.nodes
      .filter((n) => n.step.id !== id)
      .map((n) => {
        if (!n.step.dependsOn?.includes(id)) return n;
        const dependsOn = n.step.dependsOn.filter((d) => d !== id);
        return {
          ...n,
          step: {
            ...n.step,
            dependsOn: dependsOn.length ? dependsOn : undefined,
          },
        };
      }),
  };
}

/**
 * Rename a step's id, cascading the change into every other step's dependsOn.
 * A no-op if the new id is empty, unchanged, or already taken (the caller's form
 * surfaces the conflict) — so the doc never ends up with duplicate or dangling ids.
 */
export function renameStep(
  doc: BuilderDoc,
  oldId: string,
  newId: string
): BuilderDoc {
  if (!newId || newId === oldId) return doc;
  if (doc.nodes.some((n) => n.step.id === newId)) return doc;
  if (doc.notes.some((note) => note.id === newId)) return doc;

  // Rewrite {{steps.<oldId>.output}} placeholders in task/exitCriteria so a rename
  // doesn't leave dangling output references that validateSpec will reject.
  const outputRef = new RegExp(
    `\\{\\{\\s*steps\\.${escapeRegExp(oldId)}\\.output\\s*\\}\\}`,
    "g"
  );
  const rewrite = (text: string | undefined) =>
    // Use a replacer function so special `$` sequences in the new id are treated
    // as literal text, not as String.prototype.replace substitution patterns.
    text?.replace(outputRef, () => `{{steps.${newId}.output}}`);
  return {
    ...doc,
    nodes: doc.nodes.map((n) => ({
      ...n,
      step: {
        ...n.step,
        id: n.step.id === oldId ? newId : n.step.id,
        dependsOn: n.step.dependsOn?.map((d) => (d === oldId ? newId : d)),
        task: rewrite(n.step.task) ?? n.step.task,
        exitCriteria: rewrite(n.step.exitCriteria),
      },
    })),
  };
}

/** Offset used when duplicating a node so it doesn't overlap the original or prior duplicates. */
export const DUPLICATE_OFFSET = CANVAS.NODE_H;

/**
 * Duplicate a step: clone its fields (except id and dependsOn), assign a unique
 * id derived from the original, and offset the new node down-right so the user
 * sees both. A no-op if the source id is not found.
 */
export function duplicateStep(doc: BuilderDoc, id: string): BuilderDoc {
  const node = doc.nodes.find((n) => n.step.id === id);
  if (!node) return doc;
  const newId = uniqueStepId(doc, id);
  const { id: _id, dependsOn: _dependsOn, ...restStep } = node.step;

  // Nudge the copy clear of any node already occupying the target spot so
  // repeated duplicates of the same source don't stack on top of each other.
  // Cap iterations so a pathological doc can't loop forever.
  let x = node.x + DUPLICATE_OFFSET;
  let y = node.y + DUPLICATE_OFFSET;
  let guard = 0;
  const MAX_NUDGE = 100;
  while (guard++ < MAX_NUDGE) {
    const hitsNode = doc.nodes.some(
      (n) =>
        x < n.x + CANVAS.NODE_W &&
        x + CANVAS.NODE_W > n.x &&
        y < n.y + CANVAS.NODE_H &&
        y + CANVAS.NODE_H > n.y
    );
    const hitsNote = doc.notes.some(
      (note) =>
        x < note.x + CANVAS.NOTE_W &&
        x + CANVAS.NODE_W > note.x &&
        y < note.y + CANVAS.NOTE_H &&
        y + CANVAS.NODE_H > note.y
    );
    if (!hitsNode && !hitsNote) break;
    x += DUPLICATE_OFFSET;
    y += DUPLICATE_OFFSET;
  }

  return {
    ...doc,
    nodes: [
      ...doc.nodes,
      {
        step: { ...restStep, id: newId },
        x,
        y,
      },
    ],
  };
}

/** Duplicate every selected node whose step id is in `ids`. Notes are not
 * duplicated here — the caller handles note selection separately. */
export function duplicateNodes(doc: BuilderDoc, ids: string[]): BuilderDoc {
  let result = doc;
  for (const id of ids) {
    if (result.nodes.some((n) => n.step.id === id)) {
      result = duplicateStep(result, id);
    }
  }
  return result;
}

/** Escape a string for use inside a RegExp constructor. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Remove every id in `ids`, treating each as either a step or a note. Steps are
 * removed with their dependency cascade; notes are removed with no cascade. */
export function deleteNodes(doc: BuilderDoc, ids: string[]): BuilderDoc {
  let result = doc;
  for (const id of ids) {
    if (result.nodes.some((n) => n.step.id === id)) {
      result = removeStep(result, id);
    } else if (result.notes.some((note) => note.id === id)) {
      result = removeNote(result, id);
    }
  }
  return result;
}

/** Append a new note at (x, y) with a unique id. */
export function addNote(
  doc: BuilderDoc,
  x: number,
  y: number,
  text = ""
): BuilderDoc {
  const id = uniqueNoteId(doc);
  return {
    ...doc,
    notes: [...doc.notes, { id, text, x, y }],
  };
}

/** Move a note to (x, y), clamped to non-negative coordinates. */
export function moveNote(
  doc: BuilderDoc,
  id: string,
  x: number,
  y: number
): BuilderDoc {
  return {
    ...doc,
    notes: doc.notes.map((note) =>
      note.id === id ? { ...note, x: Math.max(0, x), y: Math.max(0, y) } : note
    ),
  };
}

/** Update a note's text. */
export function updateNote(
  doc: BuilderDoc,
  id: string,
  text: string
): BuilderDoc {
  return {
    ...doc,
    notes: doc.notes.map((note) => (note.id === id ? { ...note, text } : note)),
  };
}

/** Remove a note by id. */
export function removeNote(doc: BuilderDoc, id: string): BuilderDoc {
  return {
    ...doc,
    notes: doc.notes.filter((note) => note.id !== id),
  };
}

/**
 * Wrap a sticky note's text into display lines that fit the note box (NOTE_W
 * wide, NOTE_H tall). Respects explicit newlines, soft-wraps on spaces,
 * hard-breaks a word longer than a line, and caps the line count — the last
 * shown line gets an ellipsis when content is clipped. Pure (no DOM/canvas
 * measurement) so the SVG renderer stays declarative and this stays testable.
 * `maxChars`/`maxLines` are tuned to NOTE_W=160 / NOTE_H=80 at fontSize 12.
 */
export function wrapNoteText(
  text: string,
  maxChars = 24,
  maxLines = 4
): string[] {
  if (!text) return [];
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    if (paragraph.trim() === "") {
      lines.push("");
      continue;
    }
    let current = "";
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      let w = word;
      // Hard-break a single word that can't fit on one line.
      while (w.length > maxChars) {
        if (current) {
          lines.push(current);
          current = "";
        }
        lines.push(w.slice(0, maxChars));
        w = w.slice(maxChars);
      }
      if (!current) current = w;
      else if (current.length + 1 + w.length <= maxChars) current += ` ${w}`;
      else {
        lines.push(current);
        current = w;
      }
    }
    if (current) lines.push(current);
  }
  if (lines.length <= maxLines) return lines;
  const shown = lines.slice(0, maxLines);
  const last = shown[maxLines - 1];
  shown[maxLines - 1] =
    last.length >= maxChars ? `${last.slice(0, maxChars - 1)}…` : `${last}…`;
  return shown;
}
