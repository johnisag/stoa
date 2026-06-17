"use client";

import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import { Copy, ListTree, Trash2 } from "lucide-react";
import {
  CANVAS,
  wrapNoteText,
  type BuilderDoc,
} from "@/lib/pipeline/builder-model";
import { cn } from "@/lib/utils";
import { useSpacePan } from "@/hooks/useSpacePan";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";

const { NODE_W, NODE_H, NOTE_W, NOTE_H, PAD } = CANVAS;

// Pointer travel (SVG units ≈ px at the 1:1 viewBox) before a press becomes a node
// DRAG. Below it a press is a tap/click: touch input wobbles a few px between down
// and up, and without this guard that jitter nudges the node and eats the click.
const NODE_DRAG_THRESHOLD = 4;

/**
 * Interactive workflow canvas — draggable SVG nodes over a dependency-free render
 * (the same 1-unit-per-px viewBox model as PipelineGraph, so client→SVG mapping is
 * a plain getBoundingClientRect subtraction with no CTM math). Nodes are moved with
 * Pointer Events + setPointerCapture, a single code path for mouse, touch, and pen.
 * `touch-action: none` lives ONLY on the node <g> and the output ports: a finger-drag
 * on a node moves the box (and on a port wires a dependency), while a finger-drag on
 * empty canvas falls through to native scroll (the svg must NOT carry touch-none or it
 * would trap the page scroll on a phone). Each node has an output port on its right
 * edge — drag it onto another node to add that dependency edge. Controlled: the parent
 * owns the doc and applies onMoveItems/onSelectNode/onConnect.
 */
export function PipelineCanvas({
  doc,
  selectedIds,
  errorIds,
  onSelectNode,
  onMoveItems,
  onMoveEnd,
  onConnect,
  onDisconnect,
  onDuplicateNode,
  onDeleteItem,
  onCopyId,
  onGoToDefinitions,
  scrollRef,
  panEnabled = false,
  onDropSnippet,
}: {
  doc: BuilderDoc;
  selectedIds: Set<string>;
  /** Step ids that have validation errors — shown as a red badge on the node. */
  errorIds?: Set<string>;
  onSelectNode: (
    id: string | null,
    opts?: {
      shiftKey?: boolean;
      addToSelection?: boolean;
      keepSelection?: boolean;
    }
  ) => void;
  /** Move many items at once during a multi-selection drag. */
  onMoveItems: (updates: { id: string; x: number; y: number }[]) => void;
  /** Called when a drag ends, so the parent can commit the move to history. */
  onMoveEnd?: () => void;
  /** Create a dependency edge by dragging from a node's output port to another. */
  onConnect: (from: string, to: string) => void;
  /** Remove a dependency edge by tapping it. */
  onDisconnect: (from: string, to: string) => void;
  /** Context-menu actions surfaced on a node. */
  onDuplicateNode: (id: string) => void;
  onDeleteItem: (id: string) => void;
  onCopyId: (id: string) => void;
  /** Scroll the selected item's definition/edit panel into view. */
  onGoToDefinitions?: (id: string) => void;
  /** Ref to the scrollable container, used by the parent to recenter/fit-all. */
  scrollRef?: RefObject<HTMLDivElement | null>;
  /** When true, hold-Space turns a drag into a canvas pan (builder tab only). */
  panEnabled?: boolean;
  onDropSnippet?: (snippetId: string, x: number, y: number) => void;
}) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  // Hold-Space-to-pan: while Space is held the cursor is a grab hand and a drag
  // scrolls the wrapper instead of lassoing/moving nodes (Figma/Miro gesture).
  const spaceHeld = useSpacePan(panEnabled);
  // Active pan drag: pointer origin + the wrapper scroll offset at press, in px.
  const pan = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    scrollLeft: number;
    scrollTop: number;
  } | null>(null);
  // Active drag: pointer start in SVG user space, plus the original position of
  // every selected item (steps + notes). A ref, not state, so a drag in flight
  // doesn't re-render on every pointermove (only onMoveItems does).
  const drag = useRef<{
    start: { x: number; y: number };
    origins: Map<string, { x: number; y: number; isNote: boolean }>;
    moved: boolean;
  } | null>(null);
  // Active connection drag from a node's output port — needs state (not a ref)
  // because the rubber-band line follows the pointer and must re-render each move.
  const [connecting, setConnecting] = useState<{
    from: string;
    x: number;
    y: number;
  } | null>(null);
  // Lasso selection rectangle.
  const [lasso, setLasso] = useState<{
    x0: number;
    y0: number;
    x1: number;
    y1: number;
  } | null>(null);
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  // Long-press state: fire a synthetic context-menu event on touch after 500ms.
  const longPress = useRef<{
    id: string;
    timer: ReturnType<typeof setTimeout>;
    target: Element;
    pointerId: number;
    x: number;
    y: number;
    clientX: number;
    clientY: number;
  } | null>(null);
  useEffect(
    () => () => {
      if (longPress.current) {
        clearTimeout(longPress.current.timer);
        longPress.current = null;
      }
    },
    []
  );

  // Pointer client coords → SVG user space. viewBox == width/height (1:1, no
  // transform), so subtracting the svg's rect is exact even while scrolled.
  function toUser(e: ReactPointerEvent) {
    const r = svgRef.current?.getBoundingClientRect();
    return { x: e.clientX - (r?.left ?? 0), y: e.clientY - (r?.top ?? 0) };
  }

  function onSvgPointerDown(e: ReactPointerEvent) {
    // Space held = pan mode: let the press bubble to the wrapper pan handler
    // instead of starting a lasso selection here.
    if (spaceHeld) return;
    if (e.button !== 0) return;
    if (e.pointerType !== "mouse") return;
    if (e.target !== svgRef.current) return;
    const p = toUser(e);
    setLasso({ x0: p.x, y0: p.y, x1: p.x, y1: p.y });
    svgRef.current?.setPointerCapture(e.pointerId);
    if (!e.shiftKey) onSelectNode(null);
  }

  function onSvgPointerMove(e: ReactPointerEvent) {
    if (!lasso) return;
    const p = toUser(e);
    setLasso({ ...lasso, x1: p.x, y1: p.y });
  }

  function rectsOverlap(
    ax1: number,
    ay1: number,
    ax2: number,
    ay2: number,
    bx1: number,
    by1: number,
    bx2: number,
    by2: number
  ) {
    return ax1 < bx2 && ax2 > bx1 && ay1 < by2 && ay2 > by1;
  }

  function onSvgPointerUp(e: ReactPointerEvent) {
    if (!lasso) return;
    const l = Math.min(lasso.x0, lasso.x1);
    const r = Math.max(lasso.x0, lasso.x1);
    const t = Math.min(lasso.y0, lasso.y1);
    const b = Math.max(lasso.y0, lasso.y1);

    const hits: string[] = [];
    for (const n of doc.nodes) {
      if (rectsOverlap(l, t, r, b, n.x, n.y, n.x + NODE_W, n.y + NODE_H)) {
        hits.push(n.step.id);
      }
    }
    for (const note of doc.notes) {
      if (
        rectsOverlap(
          l,
          t,
          r,
          b,
          note.x,
          note.y,
          note.x + NOTE_W,
          note.y + NOTE_H
        )
      ) {
        hits.push(note.id);
      }
    }

    if (svgRef.current?.hasPointerCapture(e.pointerId)) {
      svgRef.current.releasePointerCapture(e.pointerId);
    }
    setLasso(null);

    if (!e.shiftKey) onSelectNode(null);
    for (const id of hits) {
      onSelectNode(id, { addToSelection: true });
    }
    if (hits.length > 0) {
      onSelectNode(hits[0], { keepSelection: true });
    }
  }

  function itemPosition(id: string) {
    const node = doc.nodes.find((n) => n.step.id === id);
    if (node) return { x: node.x, y: node.y, isNote: false };
    const note = doc.notes.find((n) => n.id === id);
    if (note) return { x: note.x, y: note.y, isNote: true };
    return null;
  }

  function onNodePointerDown(e: ReactPointerEvent, id: string) {
    // Space held = pan mode: don’t grab the node; let it bubble to the wrapper
    // pan handler (so a Space-drag started over a node still pans).
    if (spaceHeld) return;
    // Only the primary button starts a drag / long-press.
    if (e.button !== 0) return;
    e.stopPropagation();

    if (e.shiftKey) {
      onSelectNode(id, { shiftKey: true });
      return;
    }

    if (!selectedIds.has(id)) {
      onSelectNode(id);
    } else {
      onSelectNode(id, { keepSelection: true });
    }

    // The parent may not have batched the selection update yet, so drag the
    // clicked id along with any already-selected items.
    const toDrag = selectedIds.has(id) ? selectedIds : new Set([id]);
    const p = toUser(e);
    const origins = new Map<
      string,
      { x: number; y: number; isNote: boolean }
    >();
    for (const itemId of toDrag) {
      const pos = itemPosition(itemId);
      if (pos) origins.set(itemId, pos);
    }
    drag.current = { start: p, origins, moved: false };
    e.currentTarget.setPointerCapture(e.pointerId);

    // Start a 500ms long-press timer to open the context menu on touch.
    if (longPress.current) {
      clearTimeout(longPress.current.timer);
      longPress.current = null;
    }
    longPress.current = {
      id,
      target: e.currentTarget,
      pointerId: e.pointerId,
      x: p.x,
      y: p.y,
      clientX: e.clientX,
      clientY: e.clientY,
      timer: setTimeout(() => {
        // Cancel any in-flight drag and release capture before opening the menu.
        if (drag.current) {
          try {
            longPress.current?.target.releasePointerCapture(
              longPress.current.pointerId
            );
          } catch {
            // capture may already be released
          }
          drag.current = null;
        }
        longPress.current?.target.dispatchEvent(
          new MouseEvent("contextmenu", {
            bubbles: true,
            cancelable: true,
            clientX: longPress.current.clientX,
            clientY: longPress.current.clientY,
            button: 2,
            buttons: 2,
          })
        );
        longPress.current = null;
      }, 500),
    };
  }

  function onNodePointerMove(e: ReactPointerEvent) {
    e.stopPropagation();
    if (longPress.current) {
      const p = toUser(e);
      const dx = p.x - longPress.current.x;
      const dy = p.y - longPress.current.y;
      if (Math.sqrt(dx * dx + dy * dy) > 10) {
        clearTimeout(longPress.current.timer);
        longPress.current = null;
      }
    }
    if (!drag.current) return;
    const p = toUser(e);
    const dx = p.x - drag.current.start.x;
    const dy = p.y - drag.current.start.y;
    // Ignore sub-threshold jitter so a tap isn't misread as a drag (which would
    // nudge the node and swallow the selection click). Once dragging, keep going.
    if (!drag.current.moved && Math.hypot(dx, dy) < NODE_DRAG_THRESHOLD) return;
    drag.current.moved = true;

    const updates: { id: string; x: number; y: number }[] = [];
    for (const [id, origin] of drag.current.origins) {
      updates.push({ id, x: origin.x + dx, y: origin.y + dy });
    }
    onMoveItems(updates);
  }

  function onNodePointerUp(e: ReactPointerEvent) {
    e.stopPropagation();
    if (longPress.current) {
      clearTimeout(longPress.current.timer);
      longPress.current = null;
    }
    const didDrag = drag.current?.moved ?? false;
    if (drag.current && e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    drag.current = null;
    if (didDrag) onMoveEnd?.();
  }

  // Output-port drag → connect. stopPropagation so it doesn't start a node move.
  function onPortPointerDown(e: ReactPointerEvent, id: string) {
    if (spaceHeld) return;
    e.stopPropagation();
    const node = doc.nodes.find((n) => n.step.id === id);
    if (!node) return;
    setConnecting({ from: id, x: node.x + NODE_W, y: node.y + NODE_H / 2 });
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  function onPortPointerMove(e: ReactPointerEvent) {
    e.stopPropagation();
    const p = toUser(e);
    setConnecting((c) => (c ? { ...c, x: p.x, y: p.y } : c));
  }

  function onPortPointerUp(e: ReactPointerEvent) {
    e.stopPropagation();
    // Always attempt the release (don't gate on hasPointerCapture, which reads
    // false on a detached element). releasePointerCapture throws if the element is
    // detached / capture is already lost — so swallow it.
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // detached element / capture already lost — safe to ignore
    }
    if (connecting) {
      const p = toUser(e);
      const target = nodeAt(p.x, p.y, connecting.from);
      if (target) onConnect(connecting.from, target.step.id);
    }
    setConnecting(null);
  }

  // Topmost node whose box contains (x, y), excluding `exclude`. Iterate in
  // reverse so the hit matches paint order (nodes are drawn in array order, so
  // the last one is on top) — dropping on an overlap wires the box you SEE.
  function nodeAt(x: number, y: number, exclude?: string) {
    for (let i = doc.nodes.length - 1; i >= 0; i--) {
      const n = doc.nodes[i];
      if (n.step.id === exclude) continue;
      if (x >= n.x && x <= n.x + NODE_W && y >= n.y && y <= n.y + NODE_H) {
        return n;
      }
    }
    return null;
  }

  // While connecting, the node under the pointer is the prospective drop target —
  // highlight it so a touch user (whose finger hides the box) gets a clear cue.
  const hoverTargetId = connecting
    ? (nodeAt(connecting.x, connecting.y, connecting.from)?.step.id ?? null)
    : null;

  const byId = new Map(doc.nodes.map((n) => [n.step.id, n]));
  const width =
    PAD +
    Math.max(
      NODE_W,
      NOTE_W,
      ...doc.nodes.map((n) => n.x + NODE_W),
      ...doc.notes.map((n) => n.x + NOTE_W)
    ) +
    PAD;
  const height =
    PAD +
    Math.max(
      NODE_H,
      NOTE_H,
      ...doc.nodes.map((n) => n.y + NODE_H),
      ...doc.notes.map((n) => n.y + NOTE_H)
    ) +
    PAD;

  // Space-drag pan: move the wrapper scroll by the pointer delta. Pointer capture
  // keeps the drag alive even if the cursor leaves the element.
  function onWrapperPointerDown(e: ReactPointerEvent) {
    if (!spaceHeld) return;
    // Primary button only — a middle/right press while Space is held must not
    // start a pan (and the context menu is already prevented above).
    if (e.button !== 0) return;
    const el = scrollRef?.current;
    if (!el) return;
    pan.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      scrollLeft: el.scrollLeft,
      scrollTop: el.scrollTop,
    };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    e.preventDefault();
  }

  function onWrapperPointerMove(e: ReactPointerEvent) {
    // Also require spaceHeld so a leaked capture (no pointerup/cancel) can’t
    // keep panning on a plain no-button mouse move.
    if (!pan.current || !spaceHeld) return;
    const el = scrollRef?.current;
    if (!el) return;
    el.scrollLeft = pan.current.scrollLeft - (e.clientX - pan.current.startX);
    el.scrollTop = pan.current.scrollTop - (e.clientY - pan.current.startY);
  }

  function onWrapperPointerUp(e: ReactPointerEvent) {
    if (!pan.current) return;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      // capture already lost — safe to ignore
    }
    pan.current = null;
  }

  return (
    <div
      ref={scrollRef}
      className={cn(
        "bg-muted/20 h-full w-full overflow-auto",
        spaceHeld && "cursor-grab"
      )}
      onContextMenu={(e) => e.preventDefault()}
      onPointerDown={onWrapperPointerDown}
      onPointerMove={onWrapperPointerMove}
      onPointerUp={onWrapperPointerUp}
      onPointerCancel={onWrapperPointerUp}
      onDragOver={(e) => { if (e.dataTransfer.types.includes("workflow-snippet-id")) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; } }}
      onDrop={(e) => { const snippetId = e.dataTransfer.getData("workflow-snippet-id"); if (!snippetId || !onDropSnippet) return; e.preventDefault(); const r = svgRef.current?.getBoundingClientRect(); const el = scrollRef?.current; const x = e.clientX - (r?.left ?? 0) + (el?.scrollLeft ?? 0); const y = e.clientY - (r?.top ?? 0) + (el?.scrollTop ?? 0); onDropSnippet(snippetId, Math.max(0, x - 80), Math.max(0, y - 24)); }}
    >
      <svg
        ref={svgRef}
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        className="text-foreground"
        onPointerDown={onSvgPointerDown}
        onPointerMove={onSvgPointerMove}
        onPointerUp={onSvgPointerUp}
        onPointerCancel={onSvgPointerUp}
      >
        <defs>
          <marker
            id="stoa-canvas-arrow"
            viewBox="0 0 8 8"
            refX={7}
            refY={4}
            markerWidth={6}
            markerHeight={6}
            orient="auto-start-reverse"
          >
            <path d="M 0 1 L 7 4 L 0 7 z" className="fill-border" />
          </marker>
        </defs>

        {/* Edges from each step to the steps that depend on it. Free node
            positions, so a horizontal-tangent Bézier between node mid-heights. A
            wide transparent path under each edge makes it tappable to remove. */}
        {doc.nodes.flatMap((n) =>
          (n.step.dependsOn ?? []).map((depId) => {
            const a = byId.get(depId);
            const b = n;
            if (!a) return null;
            const x1 = a.x + NODE_W;
            const y1 = a.y + NODE_H / 2;
            const x2 = b.x - 4;
            const y2 = b.y + NODE_H / 2;
            const c = Math.max(40, Math.abs(x2 - x1) / 2);
            const d = `M ${x1} ${y1} C ${x1 + c} ${y1}, ${x2 - c} ${y2}, ${x2} ${y2}`;
            return (
              <g key={`${depId}->${n.step.id}`} className="cursor-pointer">
                <path
                  d={d}
                  fill="none"
                  stroke="transparent"
                  strokeWidth={22}
                  pointerEvents="stroke"
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    onDisconnect(depId, n.step.id);
                  }}
                >
                  <title>Tap to remove this dependency</title>
                </path>
                <path
                  d={d}
                  fill="none"
                  strokeWidth={1.5}
                  markerEnd="url(#stoa-canvas-arrow)"
                  className="stroke-border pointer-events-none"
                />
              </g>
            );
          })
        )}

        {/* Lasso selection rectangle. */}
        {lasso && (
          <rect
            x={Math.min(lasso.x0, lasso.x1)}
            y={Math.min(lasso.y0, lasso.y1)}
            width={Math.abs(lasso.x1 - lasso.x0)}
            height={Math.abs(lasso.y1 - lasso.y0)}
            className="fill-primary stroke-primary pointer-events-none"
            fillOpacity={0.1}
            strokeWidth={1}
            strokeDasharray="4 3"
          />
        )}

        {/* Sticky notes. */}
        {doc.notes.map((note) => {
          const selected = selectedIds.has(note.id);
          const lines = wrapNoteText(note.text || "");
          return (
            <ContextMenu key={note.id}>
              <ContextMenuTrigger asChild>
                <g
                  transform={`translate(${note.x}, ${note.y})`}
                  tabIndex={0}
                  role="button"
                  aria-pressed={selected}
                  aria-label={note.text || "Note"}
                  className="group cursor-grab touch-none outline-none active:cursor-grabbing"
                  onPointerDown={(e) => onNodePointerDown(e, note.id)}
                  onPointerMove={onNodePointerMove}
                  onPointerUp={onNodePointerUp}
                  onPointerCancel={onNodePointerUp}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onSelectNode(note.id);
                    }
                  }}
                >
                  <title>{note.text || "Note"}</title>
                  <rect
                    width={NOTE_W}
                    height={NOTE_H}
                    rx={4}
                    strokeWidth={selected ? 2 : 1}
                    className={cn(
                      "fill-yellow-100 stroke-yellow-300 dark:fill-yellow-900 dark:stroke-yellow-700",
                      selected && "stroke-primary dark:stroke-primary",
                      "group-focus:stroke-primary"
                    )}
                  />
                  <text
                    x={10}
                    y={16}
                    fill="currentColor"
                    fontSize={12}
                    fontWeight={500}
                  >
                    {lines.map((line, i) => (
                      <tspan key={i} x={10} dy={i === 0 ? 0 : 15}>
                        {line}
                      </tspan>
                    ))}
                  </text>
                </g>
              </ContextMenuTrigger>
              <ContextMenuContent collisionPadding={8}>
                <ContextMenuItem onSelect={() => onGoToDefinitions?.(note.id)}>
                  <ListTree className="mr-2 h-3.5 w-3.5" /> Go to definitions
                </ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem
                  className="text-red-600 focus:text-red-600 dark:text-red-400 dark:focus:text-red-400"
                  onSelect={() => onDeleteItem(note.id)}
                >
                  <Trash2 className="mr-2 h-3.5 w-3.5" /> Delete
                </ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
          );
        })}

        {doc.nodes.map((n) => {
          const selected = selectedIds.has(n.step.id);
          const isDropTarget = n.step.id === hoverTargetId;
          const hasError = errorIds?.has(n.step.id) ?? false;
          const label = n.step.name || n.step.id;
          return (
            <ContextMenu key={n.step.id}>
              <ContextMenuTrigger asChild>
                <g
                  transform={`translate(${n.x}, ${n.y})`}
                  tabIndex={0}
                  role="button"
                  aria-pressed={selected}
                  aria-label={label}
                  className="group cursor-grab touch-none outline-none active:cursor-grabbing"
                  onPointerDown={(e) => onNodePointerDown(e, n.step.id)}
                  onPointerMove={onNodePointerMove}
                  onPointerUp={onNodePointerUp}
                  onPointerCancel={onNodePointerUp}
                  onMouseEnter={() => setHoveredNodeId(n.step.id)}
                  onMouseLeave={() => setHoveredNodeId(null)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onSelectNode(n.step.id);
                    }
                  }}
                >
                  {/* Full label as a native tooltip / accessible name — node text is
                      truncated, so two long shared-prefix names stay distinguishable. */}
                  <title>{label}</title>
                  <rect
                    width={NODE_W}
                    height={NODE_H}
                    rx={8}
                    strokeWidth={selected || isDropTarget || hasError ? 2 : 1}
                    className={cn(
                      isDropTarget ? "fill-primary/10" : "fill-card",
                      hasError
                        ? "stroke-red-500"
                        : selected || isDropTarget
                          ? "stroke-primary"
                          : "stroke-border",
                      "group-focus:stroke-primary"
                    )}
                  />
                  <text
                    x={10}
                    y={18}
                    fill="currentColor"
                    fontSize={12}
                    fontWeight={500}
                  >
                    {label.length > 18 ? `${label.slice(0, 17)}…` : label}
                  </text>
                  <text
                    x={10}
                    y={34}
                    className="fill-muted-foreground"
                    fontSize={10}
                  >
                    {n.step.agent}
                    {n.step.task?.trim() ? "" : " · no task yet"}
                  </text>
                  {hasError && (
                    <g
                      transform={`translate(${NODE_W - 8}, -8)`}
                      role="img"
                      aria-label="Step has a validation error"
                    >
                      <title>Step has a validation error</title>
                      <circle
                        r={6}
                        className="stroke-background fill-red-500"
                        strokeWidth={1.5}
                      />
                    </g>
                  )}
                  {(hoveredNodeId === n.step.id || selected) && (
                    <g
                      transform={"translate(" + (NODE_W - 10) + ", -10)"}
                      style={{ cursor: "pointer" }}
                      onClick={(e) => { e.stopPropagation(); onDeleteItem(n.step.id); }}
                      onPointerDown={(e) => e.stopPropagation()}
                      role="button"
                      aria-label={"Delete " + (n.step.name || n.step.id)}
                    >
                      <title>Delete this step</title>
                      <circle r={8} className="fill-destructive" />
                      <line x1="-3.5" y1="-3.5" x2="3.5" y2="3.5" stroke="white" strokeWidth={1.5} strokeLinecap="round" />
                      <line x1="3.5" y1="-3.5" x2="-3.5" y2="3.5" stroke="white" strokeWidth={1.5} strokeLinecap="round" />
                    </g>
                  )}
                </g>
              </ContextMenuTrigger>
              <ContextMenuContent collisionPadding={8}>
                <ContextMenuItem
                  onSelect={() => onGoToDefinitions?.(n.step.id)}
                >
                  <ListTree className="mr-2 h-3.5 w-3.5" /> Go to definitions
                </ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem onSelect={() => onDuplicateNode(n.step.id)}>
                  <Copy className="mr-2 h-3.5 w-3.5" /> Duplicate
                </ContextMenuItem>
                <ContextMenuItem onSelect={() => onCopyId(n.step.id)}>
                  Copy id
                </ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem
                  className="text-red-600 focus:text-red-600 dark:text-red-400 dark:focus:text-red-400"
                  onSelect={() => onDeleteItem(n.step.id)}
                >
                  <Trash2 className="mr-2 h-3.5 w-3.5" /> Delete
                </ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
          );
        })}

        {/* Rubber-band line while dragging a new connection, from the source
            node's output port to the pointer. */}
        {connecting &&
          (() => {
            const src = byId.get(connecting.from);
            if (!src) return null;
            return (
              <path
                d={`M ${src.x + NODE_W} ${src.y + NODE_H / 2} L ${connecting.x} ${connecting.y}`}
                fill="none"
                className="stroke-primary"
                strokeWidth={1.5}
                strokeDasharray="4 3"
              />
            );
          })()}

        {/* Output ports (drawn last, on top): drag one onto another node to wire a
            dependency. The visible dot is small (so most of the node stays a
            move-drag target), but a larger transparent circle gives it a ~44px
            touch target on a phone. */}
        {doc.nodes.map((n) => (
          <g key={`port-${n.step.id}`}>
            <circle
              cx={n.x + NODE_W}
              cy={n.y + NODE_H / 2}
              r={22}
              fill="transparent"
              pointerEvents="all"
              className="cursor-crosshair touch-none"
              onPointerDown={(e) => onPortPointerDown(e, n.step.id)}
              onPointerMove={onPortPointerMove}
              onPointerUp={onPortPointerUp}
              onPointerCancel={onPortPointerUp}
            >
              <title>Drag to a step to make it depend on “{n.step.id}”</title>
            </circle>
            <circle
              cx={n.x + NODE_W}
              cy={n.y + NODE_H / 2}
              r={6}
              strokeWidth={1.5}
              className="fill-primary stroke-card pointer-events-none"
            />
          </g>
        ))}
      </svg>
    </div>
  );
}
