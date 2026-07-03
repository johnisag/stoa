"use client";

import { useState } from "react";
import { MessageCircleQuestion, Loader2, Check, Ban, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  useElicitations,
  useAnswerElicitation,
  type PendingElicitation,
  type ElicitValue,
} from "@/data/mcp-elicitations/queries";

// One draft value per field; numbers/enums are held as strings (the server
// re-coerces + validates every submission, so the browser form isn't trusted).
type Draft = Record<string, string | boolean>;

function initialDraft(item: PendingElicitation): Draft {
  const d: Draft = {};
  for (const f of item.fields) {
    d[f.key] =
      f.type === "boolean"
        ? false
        : f.type === "enum"
          ? (f.enumValues?.[0] ?? "")
          : "";
  }
  return d;
}

function ElicitationCard({ item }: { item: PendingElicitation }) {
  const answer = useAnswerElicitation();
  const [draft, setDraft] = useState<Draft>(() => initialDraft(item));

  const set = (key: string, value: string | boolean) =>
    setDraft((d) => ({ ...d, [key]: value }));

  const submit = (action: "accept" | "decline" | "cancel") => {
    if (action === "accept") {
      const values: Record<string, ElicitValue> = {};
      for (const f of item.fields) {
        const raw = draft[f.key];
        // Booleans go as-is; string/number/enum go as strings for the server to
        // coerce to the declared type (a blank number is rejected server-side).
        values[f.key] = f.type === "boolean" ? !!raw : String(raw ?? "");
      }
      answer.mutate(
        { id: item.id, action: "accept", values },
        {
          onError: (e) => toast.error((e as Error).message),
        }
      );
    } else {
      answer.mutate(
        { id: item.id, action },
        { onError: (e) => toast.error((e as Error).message) }
      );
    }
  };

  const busy = answer.isPending;

  return (
    <div className="border-border bg-primary/5 rounded-md border p-3">
      <div className="mb-2 flex items-start gap-2">
        <MessageCircleQuestion className="text-primary mt-0.5 h-4 w-4 flex-shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium break-words whitespace-pre-wrap">
            {item.message}
          </p>
          <p className="text-muted-foreground mt-0.5 text-[10px]">
            Requested by session {item.conductorId.slice(0, 8)}
          </p>
        </div>
      </div>

      <div className="mb-3 flex flex-col gap-2">
        {item.fields.map((f) => (
          <label key={f.key} className="flex flex-col gap-1 text-xs">
            <span className="text-muted-foreground">
              {f.description || f.key}
            </span>
            {f.type === "boolean" ? (
              <input
                type="checkbox"
                className="h-4 w-4 self-start"
                checked={Boolean(draft[f.key])}
                onChange={(e) => set(f.key, e.target.checked)}
                disabled={busy}
              />
            ) : f.type === "enum" ? (
              <select
                className="border-input bg-background h-8 rounded-md border px-2 text-sm"
                value={String(draft[f.key] ?? "")}
                onChange={(e) => set(f.key, e.target.value)}
                disabled={busy}
              >
                {(f.enumValues ?? []).map((opt) => (
                  <option key={opt} value={opt}>
                    {opt}
                  </option>
                ))}
              </select>
            ) : (
              <Input
                type={f.type === "number" ? "number" : "text"}
                className="h-8"
                value={String(draft[f.key] ?? "")}
                onChange={(e) => set(f.key, e.target.value)}
                disabled={busy}
              />
            )}
          </label>
        ))}
      </div>

      <div className="flex items-center justify-end gap-2">
        <Button
          variant="ghost"
          size="sm"
          className="h-8"
          onClick={() => submit("cancel")}
          disabled={busy}
        >
          <X className="mr-1 h-3.5 w-3.5" />
          Cancel
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-8"
          onClick={() => submit("decline")}
          disabled={busy}
        >
          <Ban className="mr-1 h-3.5 w-3.5" />
          Decline
        </Button>
        <Button
          size="sm"
          className="h-8"
          onClick={() => submit("accept")}
          disabled={busy}
        >
          {busy ? (
            <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
          ) : (
            <Check className="mr-1 h-3.5 w-3.5" />
          )}
          Submit
        </Button>
      </div>
    </div>
  );
}

/**
 * Pending MCP elicitations (#48) — agents blocked waiting on the operator for
 * structured input, rendered as schema-driven form cards at the top of the
 * Verdict Inbox (a distinct, higher-priority concern than diff review). Renders
 * nothing when the queue is empty.
 */
export function ElicitationRequests() {
  const { data: items = [] } = useElicitations(true);
  if (items.length === 0) return null;
  return (
    <div className="mb-3 flex flex-col gap-2">
      <div className="text-muted-foreground text-[10px] font-medium tracking-wide uppercase">
        Operator input requested
      </div>
      {items.map((i) => (
        <ElicitationCard key={i.id} item={i} />
      ))}
    </div>
  );
}
