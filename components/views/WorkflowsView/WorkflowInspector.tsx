"use client";

import { Copy, Trash2, X } from "lucide-react";
import {
  disconnect,
  outputRefToken,
  setDependsOn,
  updateStep,
  type BuilderDoc,
  type BuilderNode,
  type BuilderNote,
} from "@/lib/pipeline/builder-model";
import { AGENT_OPTIONS } from "@/components/NewSessionDialog/NewSessionDialog.types";
import type { AgentType } from "@/lib/providers";
import { Button } from "@/components/ui/button";
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
import type { SetDocOptions } from "@/hooks/useBuilderHistory";

/**
 * The workflow builder's right-column edit panel (the "inspector"): the form for
 * the currently-selected step, or the textarea for the currently-selected note.
 * Extracted VERBATIM from WorkflowBuilder — same markup, same handlers, same
 * conditional rendering — so behavior is byte-identical; it's a pure view over
 * the doc + the doc-mutation callbacks the builder passes down.
 *
 * Renders nothing when neither a node nor a note is selected (the builder used
 * to gate this with `{(primaryNode || primaryNote) && (...)}`; that gate now
 * lives here so the parent JSX stays flat).
 */
export function WorkflowInspector({
  doc,
  primaryNode,
  primaryNote,
  primaryId,
  editPanelRef,
  taskRef,
  showRefMenu,
  setShowRefMenu,
  onDuplicate,
  onConfirmDelete,
  onCommitRename,
  onPatch,
  onPatchTransient,
  onPatchNote,
  onCommit,
  onInsertRef,
  setDoc,
}: {
  doc: BuilderDoc;
  primaryNode: BuilderNode | null;
  primaryNote: BuilderNote | null;
  primaryId: string | null;
  editPanelRef: React.RefObject<HTMLDivElement | null>;
  taskRef: React.RefObject<HTMLTextAreaElement | null>;
  showRefMenu: boolean;
  setShowRefMenu: React.Dispatch<React.SetStateAction<boolean>>;
  onDuplicate: (id?: string) => void;
  onConfirmDelete: (id: string) => void;
  onCommitRename: (oldId: string, raw: string) => void;
  onPatch: (id: string, p: Parameters<typeof updateStep>[2]) => void;
  onPatchTransient: (id: string, p: Parameters<typeof updateStep>[2]) => void;
  onPatchNote: (id: string, text: string) => void;
  onCommit: () => void;
  onInsertRef: (refId: string) => void;
  setDoc: (
    updater: BuilderDoc | ((prev: BuilderDoc) => BuilderDoc),
    opts?: SetDocOptions
  ) => void;
}) {
  if (!primaryNode && !primaryNote) return null;
  return (
    <div
      ref={editPanelRef}
      key={primaryId ?? undefined}
      className="bg-card flex w-full flex-shrink-0 flex-col gap-3 overflow-y-auto rounded-md border p-3 lg:w-72"
    >
      {primaryNode && (
        <>
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm font-medium">Edit step</span>
            <div className="flex items-center gap-1">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => onDuplicate()}
                title="Duplicate step (Ctrl/Cmd+D)"
              >
                <Copy className="mr-1.5 h-3.5 w-3.5" /> Duplicate
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="text-red-600 hover:text-red-600 dark:text-red-400"
                onClick={() => onConfirmDelete(primaryNode.step.id)}
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
                onKeyDown={(e) => {
                  if (e.key === "Enter") e.currentTarget.blur();
                }}
                onBlur={(e) =>
                  onCommitRename(primaryNode.step.id, e.target.value)
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
                  onPatchTransient(primaryNode.step.id, {
                    name: e.target.value || undefined,
                  })
                }
                onBlur={onCommit}
              />
            </label>
          </div>

          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground text-xs">Agent</span>
            <Select
              value={primaryNode.step.agent}
              onValueChange={(v) =>
                onPatch(primaryNode.step.id, { agent: v as AgentType })
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
                onPatchTransient(primaryNode.step.id, {
                  task: e.target.value,
                })
              }
              onBlur={onCommit}
              className="min-h-[80px]"
            />
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
                          onClick={() => onInsertRef(n.step.id)}
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
              placeholder={
                'Unbreakable rules the step must satisfy, e.g. "must pass tests; open a PR".'
              }
              onChange={(e) =>
                onPatchTransient(primaryNode.step.id, {
                  exitCriteria: e.target.value || undefined,
                })
              }
              onBlur={onCommit}
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
                onPatch(primaryNode.step.id, {
                  worktreePolicy: c ? "shared" : undefined,
                })
              }
            />
          </label>
        </>
      )}

      {primaryNote && (
        <>
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm font-medium">Edit note</span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="text-red-600 hover:text-red-600 dark:text-red-400"
              onClick={() => onConfirmDelete(primaryNote.id)}
            >
              <Trash2 className="mr-1.5 h-3.5 w-3.5" /> Delete
            </Button>
          </div>
          <Textarea
            value={primaryNote.text}
            spellCheck={false}
            placeholder="Write a note…"
            onChange={(e) => onPatchNote(primaryNote.id, e.target.value)}
            onBlur={onCommit}
            className="min-h-[80px]"
          />
        </>
      )}
    </div>
  );
}
