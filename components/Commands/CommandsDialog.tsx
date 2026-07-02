"use client";

/**
 * Commands dialog (#8) — author native slash commands for a provider. Saving
 * writes a markdown file into the provider's command dir (Claude:
 * ~/.claude/commands/<name>.md) so it becomes a real `/<name>` the provider's own
 * TUI autocompletes. List + author/edit/delete, per supported provider. Reaches
 * the SAME /api/skills route as everything else.
 */

import { useEffect, useState } from "react";
import { TerminalSquare, Plus, Trash2, X, Bot } from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  useSkillProviders,
  useSkills,
  useWriteSkill,
  useDeleteSkill,
  fetchSkill,
} from "@/data/skills";

export function CommandsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { data: providers = [] } = useSkillProviders();
  const [provider, setProvider] = useState<string>("");
  // Default to the first supported provider once they load.
  useEffect(() => {
    if (open && !provider && providers.length) setProvider(providers[0].id);
  }, [open, provider, providers]);

  const { data: skills = [] } = useSkills(provider, open);
  const writeSkill = useWriteSkill();
  const deleteSkill = useDeleteSkill();

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [body, setBody] = useState("");
  const [editingExisting, setEditingExisting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setName("");
    setDescription("");
    setBody("");
    setEditingExisting(false);
    setError(null);
  };

  const startEdit = async (skillName: string) => {
    try {
      const s = await fetchSkill(provider, skillName);
      if (s) {
        setName(s.name);
        setDescription(s.description);
        setBody(s.body);
        setEditingExisting(true);
        setError(null);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load command");
    }
  };

  const save = async () => {
    setError(null);
    try {
      await writeSkill.mutateAsync({ provider, name, description, body });
      reset();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save command");
    }
  };

  const remove = async (skillName: string) => {
    try {
      await deleteSkill.mutateAsync({ provider, name: skillName });
      if (editingExisting && name === skillName) reset();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete command");
    }
  };

  const providerName =
    providers.find((p) => p.id === provider)?.name ?? provider;

  // #35: one-click install of the Stoa workflow ROLES as reusable scoped
  // subagents (~/.claude/agents/<role>/AGENT.md), each with a per-role tools
  // allowlist. Existing hand-authored files are left alone.
  const [installingRoles, setInstallingRoles] = useState(false);
  const installRoles = async () => {
    setInstallingRoles(true);
    try {
      const res = await fetch("/api/subagents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider }),
      });
      const data = (await res.json()) as {
        written?: string[];
        skipped?: string[];
        error?: string;
      };
      if (!res.ok) throw new Error(data.error || "Failed to install subagents");
      const w = data.written?.length ?? 0;
      const s = data.skipped?.length ?? 0;
      toast.success(
        `Installed ${w} workflow role${w === 1 ? "" : "s"} as ${providerName} subagents` +
          (s ? ` (${s} already existed, left untouched)` : "")
      );
    } catch (e) {
      toast.error(
        e instanceof Error ? e.message : "Failed to install subagents"
      );
    } finally {
      setInstallingRoles(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col gap-0 overflow-hidden sm:max-w-2xl">
        <DialogHeader className="space-y-1 text-left">
          <DialogTitle className="flex items-center gap-2">
            <TerminalSquare className="h-5 w-5" /> Commands
          </DialogTitle>
          <DialogDescription>
            Author a slash command — it&apos;s written to the agent&apos;s
            native command dir and becomes a real{" "}
            <span className="font-medium">/name</span> in its terminal.
          </DialogDescription>
        </DialogHeader>

        {providers.length === 0 ? (
          <div className="text-muted-foreground py-10 text-center text-sm">
            Commands need a supported agent (today: Claude Code). Install one
            and restart Stoa.
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col gap-3 py-3">
            {providers.length > 1 && (
              <div className="flex items-center gap-2 text-sm">
                <span className="text-muted-foreground">Agent</span>
                <select
                  value={provider}
                  onChange={(e) => {
                    setProvider(e.target.value);
                    reset();
                  }}
                  className="border-border bg-background rounded-md border px-2 py-1 text-sm"
                >
                  {providers.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </div>
            )}

            <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 sm:grid-cols-2">
              {/* Existing commands */}
              <div className="flex min-h-0 flex-col">
                <div className="mb-1 flex items-center justify-between">
                  <span className="text-muted-foreground text-xs font-medium uppercase">
                    {providerName} commands
                  </span>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    onClick={reset}
                    title="New command"
                  >
                    <Plus className="h-4 w-4" />
                  </Button>
                </div>
                <div className="min-h-0 flex-1 space-y-1 overflow-y-auto">
                  {skills.length === 0 ? (
                    <p className="text-muted-foreground px-1 py-2 text-sm">
                      No commands yet.
                    </p>
                  ) : (
                    skills.map((s) => (
                      <div
                        key={s.name}
                        className="hover:bg-accent/50 group flex items-center gap-1 rounded px-1"
                      >
                        <button
                          type="button"
                          onClick={() => startEdit(s.name)}
                          className="min-w-0 flex-1 py-1 text-left"
                        >
                          <span className="font-mono text-sm">/{s.name}</span>
                          {s.description && (
                            <span className="text-muted-foreground ml-2 truncate text-xs">
                              {s.description}
                            </span>
                          )}
                        </button>
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          className="opacity-60 group-hover:opacity-100"
                          aria-label={`Delete /${s.name}`}
                          onClick={() => remove(s.name)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    ))
                  )}
                </div>
              </div>

              {/* Editor */}
              <div className="flex min-h-0 flex-col gap-2">
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  disabled={editingExisting}
                  placeholder="command-name (becomes /command-name)"
                  className="border-border bg-background rounded-md border px-2 py-1 font-mono text-sm disabled:opacity-60"
                />
                <input
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Short description (optional)"
                  className="border-border bg-background rounded-md border px-2 py-1 text-sm"
                />
                <textarea
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  placeholder="The prompt this command runs. Use $ARGUMENTS for what the user types after it."
                  className="border-border bg-background min-h-[8rem] flex-1 resize-none rounded-md border p-2 font-mono text-sm"
                />
                {error && <p className="text-xs text-red-500">{error}</p>}
                <div className="flex items-center justify-end gap-2">
                  {(name || body) && (
                    <Button size="sm" variant="ghost" onClick={reset}>
                      <X className="mr-1 h-3.5 w-3.5" /> Clear
                    </Button>
                  )}
                  <Button
                    size="sm"
                    onClick={save}
                    disabled={
                      !name.trim() || !body.trim() || writeSkill.isPending
                    }
                  >
                    {editingExisting ? "Save" : "Create"}
                  </Button>
                </div>
              </div>
            </div>

            {/* #35: install the workflow ROLES as reusable scoped subagents. */}
            <div className="border-border flex items-center justify-between gap-2 border-t pt-3">
              <span className="text-muted-foreground text-xs">
                Install Stoa&apos;s workflow roles as reusable {providerName}{" "}
                subagents (each scoped to a tools allowlist).
              </span>
              <Button
                size="sm"
                variant="secondary"
                onClick={installRoles}
                disabled={installingRoles}
              >
                <Bot className="mr-1 h-3.5 w-3.5" />
                {installingRoles ? "Installing…" : "Install roles"}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
