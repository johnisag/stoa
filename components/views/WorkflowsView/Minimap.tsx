"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CANVAS, type BuilderDoc } from "@/lib/pipeline/builder-model";
import { cn } from "@/lib/utils";

const { NODE_W, NODE_H, NOTE_W, NOTE_H, PAD } = CANVAS;

const MAP_W = 160;
const MAP_H = 100;

/**
 * Compact minimap for the workflow canvas. Shows every node and note as a small
 * rectangle, the current viewport frame, and supports click/tap-to-center panning.
 * Renders only once the canvas reaches a useful complexity threshold.
 */
export function Minimap({
  doc,
  selectedIds,
  scrollRef,
  className,
}: {
  doc: BuilderDoc;
  selectedIds: Set<string>;
  scrollRef: React.RefObject<HTMLDivElement | null>;
  className?: string;
}) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [frame, setFrame] = useState({ x: 0, y: 0, w: 0, h: 0 });

  const totalItems = doc.nodes.length + doc.notes.length;

  const bounds = useMemo(() => {
    const minX = Math.min(
      0,
      ...doc.nodes.map((n) => n.x),
      ...doc.notes.map((n) => n.x)
    );
    const minY = Math.min(
      0,
      ...doc.nodes.map((n) => n.y),
      ...doc.notes.map((n) => n.y)
    );
    const maxX = Math.max(
      NODE_W,
      NOTE_W,
      ...doc.nodes.map((n) => n.x + NODE_W),
      ...doc.notes.map((n) => n.x + NOTE_W)
    );
    const maxY = Math.max(
      NODE_H,
      NOTE_H,
      ...doc.nodes.map((n) => n.y + NODE_H),
      ...doc.notes.map((n) => n.y + NOTE_H)
    );

    return {
      x: minX - PAD,
      y: minY - PAD,
      w: maxX - minX + PAD * 2,
      h: maxY - minY + PAD * 2,
    };
  }, [doc]);

  // Latest bounds for the (stable) updateFrame; kept current in the effect below.
  const boundsRef = useRef(bounds);

  // Stable across renders (depends only on scrollRef) so the scroll listener
  // isn't torn down and re-added on every bounds change — i.e. on every
  // transient drag frame. Reads the latest bounds from boundsRef.
  const updateFrame = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const b = boundsRef.current;
    const scaleX = MAP_W / b.w;
    const scaleY = MAP_H / b.h;
    setFrame({
      x: (el.scrollLeft - b.x) * scaleX,
      y: (el.scrollTop - b.y) * scaleY,
      w: el.clientWidth * scaleX,
      h: el.clientHeight * scaleY,
    });
  }, [scrollRef]);

  // Keep boundsRef current and refresh the frame when the content extent
  // changes (drag/add/remove) — without re-subscribing the scroll listener.
  useEffect(() => {
    boundsRef.current = bounds;
    updateFrame();
  }, [bounds, updateFrame]);

  // Subscribe the scroll listener once per scrollRef (updateFrame is stable).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.addEventListener("scroll", updateFrame, { passive: true });
    return () => el.removeEventListener("scroll", updateFrame);
  }, [scrollRef, updateFrame]);

  function onPointerDown(e: React.PointerEvent<SVGSVGElement>) {
    const svg = svgRef.current;
    const el = scrollRef.current;
    if (!svg || !el) return;

    const rect = svg.getBoundingClientRect();
    const mapX = e.clientX - rect.left;
    const mapY = e.clientY - rect.top;

    const contentX = bounds.x + (mapX / MAP_W) * bounds.w;
    const contentY = bounds.y + (mapY / MAP_H) * bounds.h;

    el.scrollTo({
      left: contentX - el.clientWidth / 2,
      top: contentY - el.clientHeight / 2,
      behavior: "smooth",
    });
  }

  if (totalItems < 6) return null;

  const nodeW = (NODE_W / bounds.w) * MAP_W;
  const nodeH = (NODE_H / bounds.h) * MAP_H;
  const noteW = (NOTE_W / bounds.w) * MAP_W;
  const noteH = (NOTE_H / bounds.h) * MAP_H;

  return (
    <div
      className={cn(
        "bg-card pointer-events-auto rounded-md border shadow-sm",
        className
      )}
      role="button"
      tabIndex={0}
      aria-label="Canvas minimap, click or press Enter to center the view"
      title="Canvas minimap — click or press Enter to center"
      onKeyDown={(e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        const el = scrollRef.current;
        if (!el) return;
        const contentX = bounds.x + bounds.w / 2;
        const contentY = bounds.y + bounds.h / 2;
        el.scrollTo({
          left: contentX - el.clientWidth / 2,
          top: contentY - el.clientHeight / 2,
          behavior: "smooth",
        });
      }}
    >
      <svg
        ref={svgRef}
        aria-hidden="true"
        width={MAP_W}
        height={MAP_H}
        viewBox={`0 0 ${MAP_W} ${MAP_H}`}
        className="cursor-pointer"
        onPointerDown={onPointerDown}
      >
        <rect
          x={0}
          y={0}
          width={MAP_W}
          height={MAP_H}
          className="fill-muted/40"
        />

        {doc.nodes.map((n) => (
          <rect
            key={n.step.id}
            x={((n.x - bounds.x) / bounds.w) * MAP_W}
            y={((n.y - bounds.y) / bounds.h) * MAP_H}
            width={nodeW}
            height={nodeH}
            rx={2}
            className={cn(
              selectedIds.has(n.step.id) ? "fill-primary" : "fill-foreground/60"
            )}
          />
        ))}

        {doc.notes.map((n) => (
          <rect
            key={n.id}
            x={((n.x - bounds.x) / bounds.w) * MAP_W}
            y={((n.y - bounds.y) / bounds.h) * MAP_H}
            width={noteW}
            height={noteH}
            rx={2}
            className="fill-yellow-400 dark:fill-yellow-600"
          />
        ))}

        <rect
          x={frame.x}
          y={frame.y}
          width={frame.w}
          height={frame.h}
          className="stroke-primary fill-transparent"
          strokeWidth={2}
          rx={2}
        />
      </svg>
    </div>
  );
}
