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
      <span className="font-medium">{ex.title}</span>
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
 * something isn't scrolling past docs-only cards to find it. The section heading
 * carries the runnable/reference distinction, so cards need no per-card badge.
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
        means “then”. The runnable ones ship as a template — tap Run this to
        fill its slots; the rest are authoring references for designing your
        own.
      </p>

      <section className="flex flex-col gap-2">
        <h3 className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
          Runnable
        </h3>
        {runnable.map((ex) => (
          <ExampleCard key={ex.id} ex={ex} onRunTemplate={onRunTemplate} />
        ))}
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
          Reference patterns
        </h3>
        {reference.map((ex) => (
          <ExampleCard key={ex.id} ex={ex} onRunTemplate={onRunTemplate} />
        ))}
      </section>
    </div>
  );
}
