"use client";

import { PIPELINE_TEMPLATES } from "@/lib/pipeline/templates";
import { cn } from "@/lib/utils";

/**
 * The catalog grid — every curated PIPELINE_TEMPLATE as a pickable card. Picking
 * one hands its id up so the parent swaps in the param form. Read-only templates
 * are badged so a first-timer can pick a safe one (matches templates.ts `mutates`).
 */
export function TemplatePicker({ onPick }: { onPick: (id: string) => void }) {
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
      {PIPELINE_TEMPLATES.map((t) => (
        <button
          key={t.id}
          type="button"
          onClick={() => onPick(t.id)}
          className="bg-card hover:border-foreground/20 flex flex-col gap-1.5 rounded-md border p-3 text-left transition-colors"
        >
          <div className="flex items-start justify-between gap-2">
            <span className="text-sm font-medium">{t.name}</span>
            <span
              className={cn(
                "flex-shrink-0 rounded px-1.5 py-0.5 text-[11px]",
                t.mutates
                  ? "bg-amber-500/15 text-amber-600 dark:text-amber-400"
                  : "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
              )}
            >
              {t.mutates ? "writes code" : "read-only"}
            </span>
          </div>
          <p className="text-muted-foreground text-xs leading-relaxed">
            {t.description}
          </p>
        </button>
      ))}
    </div>
  );
}
