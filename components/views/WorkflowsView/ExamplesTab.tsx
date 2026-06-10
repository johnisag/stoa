"use client";

import { Play } from "lucide-react";
import {
  WORKFLOW_EXAMPLES,
  type WorkflowExample,
} from "@/lib/pipeline/examples";
import { Button } from "@/components/ui/button";

function ExampleCard({
  ex,
  onRunTemplate,
}: {
  ex: WorkflowExample;
  onRunTemplate: (templateId: string) => void;
}) {
  return (
    <div className="bg-card flex flex-col gap-2 rounded-md border p-3 text-sm">
      <div className="flex items-start justify-between gap-2">
        <span className="font-medium">{ex.title}</span>
        {ex.templateId ? (
          <span className="flex-shrink-0 rounded bg-emerald-500/15 px-1.5 py-0.5 text-[11px] text-emerald-600 dark:text-emerald-400">
            runnable
          </span>
        ) : (
          <span className="text-muted-foreground bg-muted flex-shrink-0 rounded px-1.5 py-0.5 text-[11px]">
            reference
          </span>
        )}
      </div>
      <pre className="text-muted-foreground bg-muted/50 overflow-x-auto rounded px-2 py-1.5 text-[11px] leading-relaxed">
        {ex.diagram}
      </pre>
      <p className="text-muted-foreground text-xs leading-relaxed">
        {ex.description}
      </p>
      {ex.templateId && (
        <Button
          size="sm"
          variant="outline"
          className="w-full sm:w-auto sm:self-start"
          onClick={() => onRunTemplate(ex.templateId!)}
        >
          <Play className="mr-1.5 h-3.5 w-3.5" /> Run this
        </Button>
      )}
    </div>
  );
}

/**
 * The Examples tab — the 16-pattern authoring catalog as read-only docs. Split
 * into Runnable (ships as a template → "Run this" jumps to the Templates tab with
 * it picked) and Reference (authoring patterns), so a user who wants to *do*
 * something isn't scrolling past docs-only cards to find it.
 */
export function ExamplesTab({
  onRunTemplate,
}: {
  onRunTemplate: (templateId: string) => void;
}) {
  const runnable = WORKFLOW_EXAMPLES.filter((e) => e.templateId);
  const reference = WORKFLOW_EXAMPLES.filter((e) => !e.templateId);

  return (
    <div className="flex flex-col gap-4">
      <p className="text-muted-foreground text-xs leading-relaxed">
        Patterns you can run or build on. Steps in ⟨…⟩ run in parallel; an arrow
        means “waits for”. The runnable ones ship as a template — tap Run to
        fill its slots; the rest are authoring references for designing your
        own.
      </p>

      <section className="flex flex-col gap-2">
        <h3 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
          Runnable
        </h3>
        {runnable.map((ex) => (
          <ExampleCard key={ex.id} ex={ex} onRunTemplate={onRunTemplate} />
        ))}
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
          Reference patterns
        </h3>
        {reference.map((ex) => (
          <ExampleCard key={ex.id} ex={ex} onRunTemplate={onRunTemplate} />
        ))}
      </section>
    </div>
  );
}
