"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Loader2, Sparkles, X } from "lucide-react";
import { getModelOptions } from "@/lib/model-catalog";
import { useGenerateWorkflow } from "@/data/chat/useCommand";
import type { BuilderDoc } from "@/lib/pipeline/builder-model";
import type { useConfirm } from "@/components/ConfirmProvider";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { CollapsibleSection } from "./WorkflowCollapsibleSection";

type Confirm = ReturnType<typeof useConfirm>;

/**
 * The "Design with AI" collapsible: describe a goal → an agent designs a
 * workflow that replaces the canvas (or replies in prose). Extracted VERBATIM
 * from WorkflowBuilder — the gen state (summary/provider/model/answer), the
 * generate mutation, and `handleGenerate` all move here unchanged, so behavior
 * is byte-identical. The builder passes the project context + the dirty guard +
 * `onLoadDoc`, keeping this panel's coupling to the doc explicit and minimal.
 */
export function WorkflowDesignPanel({
  projectId,
  dirty,
  confirm,
  onLoadDoc,
}: {
  projectId: string | null | undefined;
  dirty: boolean;
  confirm: Confirm;
  onLoadDoc: (doc: BuilderDoc, savedWorkflowId: string | null) => void;
}) {
  // Assisted generator (top bar): describe a goal → an agent designs the workflow.
  const [genSummary, setGenSummary] = useState("");
  const [genProvider, setGenProvider] = useState<"claude" | "codex">("claude");
  const [genModel, setGenModel] = useState(""); // "" → the agent's default model
  // A prose reply from the designer (a clarifying question, or why it couldn't
  // design one). Shown inline (not a fleeting toast) so the user can act on it.
  const [genAnswer, setGenAnswer] = useState<string | null>(null);
  const generate = useGenerateWorkflow();

  async function handleGenerate() {
    const summary = genSummary.trim();
    if (!summary) {
      toast.error("Describe what you want to build first.");
      return;
    }
    if (!projectId) {
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
        projectId,
        provider: genProvider,
        model: genModel || undefined,
      });
      if (reply.kind === "workflow") {
        onLoadDoc(reply.doc, null); // a fresh, unsaved, undoable draft
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

  return (
    <CollapsibleSection
      title="Design with AI"
      icon={Sparkles}
      defaultOpen={false}
    >
      <div className="flex flex-col gap-2" aria-busy={generate.isPending}>
        <Textarea
          value={genSummary}
          onChange={(e) => setGenSummary(e.target.value)}
          placeholder={
            "Describe what to build — e.g. “a Stripe billing page with full tests and a review gate”. An agent designs the workflow; you review and edit before anything runs."
          }
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
            disabled={generate.isPending || !genSummary.trim() || !projectId}
            title={
              !projectId
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
          {!projectId && (
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
    </CollapsibleSection>
  );
}
