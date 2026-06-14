"use client";

import {
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import { CANVAS, type BuilderDoc } from "@/lib/pipeline/builder-model";
import { cn } from "@/lib/utils";

const { NODE_W, NODE_H, PAD } = CANVAS;

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
 * owns the doc and applies onMoveNode/onSelectNode/onConnect.
 */
export function PipelineCanvas({
  doc,
  selectedId,
  errorIds,
  onSelectNode,
  onMoveNode,
  onMoveEnd,
  onConnect,
  onDisconnect,
  scrollRef,
}: {
  doc: BuilderDoc;
  selectedId: string | null;
  /** Step ids that have validation errors — shown as a red badge on the node. */
  errorIds?: Set<string>;
  onSelectNode: (id: string | null) => void;
  onMoveNode: (id: string, x: number, y: number) => void;
  /** Called when a node drag ends, so the parent can commit the move to history. */
  onMoveEnd?: () => void;
  /** Create a dependency edge by dragging from a node's output port to another. */
  onConnect: (from: string, to: string) => void;
  /** Remove a dependency edge by tapping it. */
  onDisconnect: (from: string, to: string) => void;
  /** Ref to the scrollable container, used by the parent to recenter/fit-all. */
  scrollRef?: RefObject<HTMLDivElement | null>;
}) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  // Active drag: which node, and the grab offset (pointer − node origin) so the
  // node doesn't jump its top-left to the cursor on grab. A ref, not state, so a
  // drag in flight doesn't re-render on every pointermove (only onMoveNode does).
  const drag = useRef<{ id: string; dx: number; dy: number } | null>(null);
  // Active connection drag from a node's output port — needs state (not a ref)
  // because the rubber-band line follows the pointer and must re-render each move.
  const [connecting, setConnecting] = useState<{
    from: string;
    x: number;
    y: number;
  } | null>(null);

  // Pointer client coords → SVG user space. viewBox == width/height (1:1, no
  // transform), so subtracting the svg's rect is exact even while scrolled.
  function toUser(e: ReactPointerEvent) {
    const r = svgRef.current?.getBoundingClientRect();
    return { x: e.clientX - (r?.left ?? 0), y: e.clientY - (r?.top ?? 0) };
  }

  function onNodePointerDown(e: ReactPointerEvent, id: string) {
    e.stopPropagation();
    onSelectNode(id);
    const node = doc.nodes.find((n) => n.step.id === id);
    if (!node) return;
    const p = toUser(e);
    drag.current = { id, dx: p.x - node.x, dy: p.y - node.y };
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  function onNodePointerMove(e: ReactPointerEvent) {
    if (!drag.current) return;
    const p = toUser(e);
    onMoveNode(drag.current.id, p.x - drag.current.dx, p.y - drag.current.dy);
  }

  function onNodePointerUp(e: ReactPointerEvent) {
    const didDrag = !!drag.current;
    if (drag.current && e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    drag.current = null;
    if (didDrag) onMoveEnd?.();
  }

  // Output-port drag → connect. stopPropagation so it doesn't start a node move.
  function onPortPointerDown(e: ReactPointerEvent, id: string) {
    e.stopPropagation();
    const node = doc.nodes.find((n) => n.step.id === id);
    if (!node) return;
    setConnecting({ from: id, x: node.x + NODE_W, y: node.y + NODE_H / 2 });
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  function onPortPointerMove(e: ReactPointerEvent) {
    const p = toUser(e);
    setConnecting((c) => (c ? { ...c, x: p.x, y: p.y } : c));
  }

  function onPortPointerUp(e: ReactPointerEvent) {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
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
    PAD + Math.max(NODE_W, ...doc.nodes.map((n) => n.x + NODE_W)) + PAD;
  const height =
    PAD + Math.max(NODE_H, ...doc.nodes.map((n) => n.y + NODE_H)) + PAD;

  return (
    <div
      ref={scrollRef}
      className="bg-muted/20 max-h-[40vh] overflow-auto rounded-md border"
    >
      <svg
        ref={svgRef}
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        className="text-foreground"
        // Pointer-down on the empty canvas (not a node) clears the selection.
        onPointerDown={() => onSelectNode(null)}
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
                  strokeWidth={14}
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

        {doc.nodes.map((n) => {
          const selected = n.step.id === selectedId;
          const isDropTarget = n.step.id === hoverTargetId;
          const hasError = errorIds?.has(n.step.id) ?? false;
          const label = n.step.name || n.step.id;
          return (
            <g
              key={n.step.id}
              transform={`translate(${n.x}, ${n.y})`}
              className="cursor-grab touch-none active:cursor-grabbing"
              onPointerDown={(e) => onNodePointerDown(e, n.step.id)}
              onPointerMove={onNodePointerMove}
              onPointerUp={onNodePointerUp}
              onPointerCancel={onNodePointerUp}
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
                      : "stroke-border"
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
            </g>
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
            move-drag target), but a larger transparent circle gives it a ~28px
            touch target on a phone. */}
        {doc.nodes.map((n) => (
          <g key={`port-${n.step.id}`}>
            <circle
              cx={n.x + NODE_W}
              cy={n.y + NODE_H / 2}
              r={14}
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
