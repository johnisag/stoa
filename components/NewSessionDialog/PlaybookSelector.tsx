"use client";

import { useState } from "react";
import { BookMarked, Pin, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  usePlaybooksQuery,
  useCreatePlaybook,
  useDeletePlaybook,
} from "@/data/playbooks/queries";
import { PLAYBOOK_NAME_MAX } from "@/lib/playbooks";

/**
 * Playbooks + auto-recalled Knowledge (#13) — a compact NewSessionDialog control.
 * Pick a saved RECIPE to load its body into the prompt, or SAVE the current prompt as
 * a named recipe (optionally PIN it to the project so it auto-loads into every future
 * session there). Pinned recipes are surfaced with a pin badge; they inject
 * server-side regardless of what's picked here.
 */
export function PlaybookSelector({
  projectId,
  currentPrompt,
  onLoadRecipe,
}: {
  projectId: string | null;
  /** The current initial-prompt text (what "Save as recipe" persists). */
  currentPrompt: string;
  /** Load a recipe's body into the prompt textarea. */
  onLoadRecipe: (body: string) => void;
}) {
  const { data: playbooks = [] } = usePlaybooksQuery(projectId);
  const create = useCreatePlaybook();
  const del = useDeletePlaybook();
  const [saving, setSaving] = useState(false);
  const [newName, setNewName] = useState("");
  const [pin, setPin] = useState(false);

  const handleSave = () => {
    const name = newName.trim();
    const body = currentPrompt.trim();
    if (!name || !body) return;
    create.mutate(
      // Pin only makes sense for a project-scoped recipe.
      {
        name,
        body,
        projectId: projectId ?? undefined,
        pinned: projectId ? pin : false,
      },
      {
        onSuccess: () => {
          setNewName("");
          setPin(false);
          setSaving(false);
          toast.success(`Saved playbook "${name}"`);
        },
        onError: (e) => toast.error(e.message),
      }
    );
  };

  return (
    <div className="border-border/60 space-y-2 rounded-md border p-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-muted-foreground flex items-center gap-1.5 text-xs font-medium">
          <BookMarked className="h-3.5 w-3.5" />
          Playbooks <span className="font-normal">(reusable recipes)</span>
        </span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-xs"
          disabled={!currentPrompt.trim()}
          title={
            currentPrompt.trim()
              ? "Save the current prompt as a reusable recipe"
              : "Type a prompt first, then save it as a recipe"
          }
          onClick={() => setSaving((s) => !s)}
        >
          Save current as…
        </Button>
      </div>

      {playbooks.length > 0 ? (
        <ul className="max-h-28 space-y-1 overflow-y-auto">
          {playbooks.map((p) => (
            <li key={p.id} className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => onLoadRecipe(p.body)}
                title={`Load "${p.name}" into the prompt`}
                className="hover:bg-accent/60 flex min-w-0 flex-1 items-center gap-1.5 rounded px-1.5 py-1 text-left text-xs transition-colors"
              >
                {p.pinned && (
                  <Pin
                    className="h-3 w-3 flex-shrink-0 text-amber-500"
                    aria-label="pinned (auto-loads)"
                  />
                )}
                <span className="truncate">{p.name}</span>
              </button>
              <button
                type="button"
                aria-label={`Delete playbook ${p.name}`}
                title="Delete this playbook"
                className="text-muted-foreground flex-shrink-0 rounded p-1 transition-colors hover:text-red-500"
                onClick={() =>
                  del.mutate(p.id, {
                    onError: (e) => toast.error(e.message),
                  })
                }
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-muted-foreground px-1 text-xs">
          No saved recipes yet. Type a prompt and “Save current as…”.
        </p>
      )}

      {saving && (
        <div className="space-y-2 pt-1">
          <Input
            value={newName}
            maxLength={PLAYBOOK_NAME_MAX}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Recipe name (e.g. “Fix a flaky test”)"
            className="h-7 text-xs"
          />
          <div className="flex items-center justify-between gap-2">
            {projectId ? (
              <label className="text-muted-foreground flex items-center gap-1.5 text-xs">
                <input
                  type="checkbox"
                  checked={pin}
                  onChange={(e) => setPin(e.target.checked)}
                  className="accent-amber-500"
                />
                Pin to this project (auto-load into every session)
              </label>
            ) : (
              <span className="text-muted-foreground text-xs">
                Global recipe (pick a project to pin)
              </span>
            )}
            <Button
              type="button"
              size="sm"
              className="h-6 px-2 text-xs"
              disabled={
                !newName.trim() || !currentPrompt.trim() || create.isPending
              }
              onClick={handleSave}
            >
              Save
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
