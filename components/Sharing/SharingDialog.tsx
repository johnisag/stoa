"use client";

import { useEffect, useState, useCallback } from "react";
import { KeyRound, Trash2, Copy, Check, Eye, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

interface TokenInfo {
  id: string;
  name: string;
  scope: "admin" | "observer";
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

/**
 * Per-device named revocable tokens (#46/#49). Mint a named token — `admin` (full
 * control) or `observer` (a read-only SPECTATOR link: Live Wall + reads, rejected
 * by every mutation) — copy its one-time share URL, and revoke any device. Secrets
 * are shown ONCE at create (the server stores only a hash) and never again.
 */
export function SharingDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [tokens, setTokens] = useState<TokenInfo[]>([]);
  const [name, setName] = useState("");
  const [scope, setScope] = useState<"admin" | "observer">("observer");
  const [creating, setCreating] = useState(false);
  // The freshly-minted secret URL, shown once until dismissed.
  const [fresh, setFresh] = useState<{ name: string; url: string } | null>(
    null
  );
  const [copied, setCopied] = useState(false);
  // True when the token list 403s — the caller is a read-only observer, so sharing
  // (an admin-only surface) is unavailable. Distinguishes that from a transient error.
  const [readOnly, setReadOnly] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/tokens");
      if (res.status === 403) {
        setReadOnly(true);
        return;
      }
      if (!res.ok) return; // transient — keep the last list
      setReadOnly(false);
      const data = (await res.json()) as { tokens?: TokenInfo[] };
      setTokens(data.tokens ?? []);
    } catch {
      /* ignore — a transient fetch error just leaves the last list */
    }
  }, []);

  useEffect(() => {
    if (open) refresh();
    // The dialog stays mounted (Radix), so clear the one-time secret + form when it
    // closes: the freshly-minted URL must not linger / re-appear on reopen.
    else {
      setFresh(null);
      setName("");
      setCopied(false);
    }
  }, [open, refresh]);

  const create = async () => {
    if (!name.trim() || creating) return;
    setCreating(true);
    try {
      const res = await fetch("/api/tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, scope }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        token?: string;
        name?: string;
        error?: string;
      };
      if (!res.ok || !data.token)
        throw new Error(data.error || "Failed to create token");
      const url = `${window.location.origin}/?token=${encodeURIComponent(data.token)}`;
      setFresh({ name: data.name || name, url });
      setName("");
      setCopied(false);
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to create token");
    } finally {
      setCreating(false);
    }
  };

  const revoke = async (t: TokenInfo) => {
    try {
      const res = await fetch(`/api/tokens/${encodeURIComponent(t.id)}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error("Failed to revoke");
      toast.success(`Revoked "${t.name}"`);
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to revoke");
    }
  };

  const copyFresh = async () => {
    if (!fresh) return;
    try {
      await navigator.clipboard.writeText(fresh.url);
      setCopied(true);
      toast.success("Share link copied");
    } catch {
      toast.error("Couldn't copy — select and copy the link manually");
    }
  };

  const live = tokens.filter((t) => !t.revoked_at);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col gap-0 overflow-hidden sm:max-w-lg">
        <DialogHeader className="space-y-1 text-left">
          <DialogTitle className="flex items-center gap-2">
            <KeyRound className="h-5 w-5" /> Sharing &amp; devices
          </DialogTitle>
          <DialogDescription>
            Create a named access link per device. An{" "}
            <span className="font-medium">observer</span> link is read-only — it
            streams the Live Wall but can&apos;t control anything. Revoke any
            link anytime.
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 flex-1 flex-col gap-3 py-3">
          {readOnly ? (
            <div className="text-muted-foreground flex items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">
              <Eye className="h-4 w-4 shrink-0" />
              This is a read-only spectator link — managing device links is
              admin-only.
            </div>
          ) : (
            <>
              {/* Create */}
              <div className="border-border space-y-2 rounded-md border p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Device name (e.g. Phone, TV)"
                    className="border-border bg-background min-w-0 flex-1 rounded-md border px-2 py-1 text-sm"
                    onKeyDown={(e) => e.key === "Enter" && create()}
                  />
                  <select
                    value={scope}
                    onChange={(e) =>
                      setScope(e.target.value as "admin" | "observer")
                    }
                    className="border-border bg-background rounded-md border px-2 py-1 text-sm"
                  >
                    <option value="observer">Observer (read-only)</option>
                    <option value="admin">Admin (full control)</option>
                  </select>
                  <Button
                    size="sm"
                    onClick={create}
                    disabled={!name.trim() || creating}
                  >
                    Create link
                  </Button>
                </div>
                {fresh && (
                  <div className="bg-muted/40 space-y-1.5 rounded-md p-2">
                    <p className="text-muted-foreground text-xs">
                      Share link for{" "}
                      <span className="text-foreground font-medium">
                        {fresh.name}
                      </span>{" "}
                      — copy it now, it won&apos;t be shown again:
                    </p>
                    <div className="flex items-center gap-2">
                      <code className="bg-background min-w-0 flex-1 truncate rounded border px-2 py-1 font-mono text-xs">
                        {fresh.url}
                      </code>
                      <Button
                        size="icon-sm"
                        variant="secondary"
                        onClick={copyFresh}
                      >
                        {copied ? (
                          <Check className="h-3.5 w-3.5" />
                        ) : (
                          <Copy className="h-3.5 w-3.5" />
                        )}
                      </Button>
                    </div>
                  </div>
                )}
              </div>

              {/* List */}
              <div className="min-h-0 flex-1 space-y-1 overflow-y-auto">
                {live.length === 0 ? (
                  <p className="text-muted-foreground px-1 py-3 text-center text-sm">
                    No device links yet.
                  </p>
                ) : (
                  live.map((t) => (
                    <div
                      key={t.id}
                      className="hover:bg-accent/40 group flex items-center gap-2 rounded px-2 py-1.5"
                    >
                      {t.scope === "admin" ? (
                        <ShieldCheck className="text-muted-foreground h-4 w-4 shrink-0" />
                      ) : (
                        <Eye className="text-muted-foreground h-4 w-4 shrink-0" />
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium">
                          {t.name}
                        </div>
                        <div className="text-muted-foreground text-xs">
                          {t.scope}
                          {t.last_used_at
                            ? ` · last used ${fmtWhen(t.last_used_at)}`
                            : " · never used"}
                        </div>
                      </div>
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        className="opacity-60 group-hover:opacity-100"
                        aria-label={`Revoke ${t.name}`}
                        onClick={() => revoke(t)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  ))
                )}
              </div>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Render a SQLite UTC datetime ('YYYY-MM-DD HH:MM:SS') in the viewer's locale
 * instead of a bare UTC string read as local. */
function fmtWhen(sqliteUtc: string): string {
  const d = new Date(sqliteUtc.replace(" ", "T") + "Z");
  return isNaN(d.getTime()) ? sqliteUtc : d.toLocaleString();
}
