"use client";

import { Layers, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { WORKFLOW_SNIPPETS } from "@/lib/pipeline/snippets";

export function SnippetsPanel({
  onSelectSnippet,
}: {
  onSelectSnippet: (id: string) => void;
}) {
  return (
    <div className="flex flex-col gap-3 rounded-md border p-3">
      <div className="flex items-center gap-2">
        <Layers className="text-muted-foreground h-4 w-4" />
        <h4 className="text-sm font-medium">Snippets</h4>
      </div>
      <p className="text-muted-foreground text-xs leading-relaxed">
        Tap a pre-wired step to add it to the canvas.
      </p>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {WORKFLOW_SNIPPETS.map((s) => (
          <Button
            key={s.id}
            type="button"
            variant="outline"
            size="sm"
            className="h-auto justify-start py-2"
            onClick={() => onSelectSnippet(s.id)}
          >
            <Plus className="mr-1.5 h-3.5 w-3.5 flex-shrink-0" />
            <span className="flex flex-col items-start">
              <span className="text-xs font-medium">{s.title}</span>
              <span className="text-muted-foreground text-xs font-normal">
                {s.description}
              </span>
            </span>
          </Button>
        ))}
      </div>
    </div>
  );
}
