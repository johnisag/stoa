"use client";

import { useState, useEffect, useRef } from "react";
import { X, RefreshCw, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

interface ServerLogsModalProps {
  serverId: string;
  serverName: string;
  onClose: () => void;
}

export function ServerLogsModal({
  serverId,
  serverName,
  onClose,
}: ServerLogsModalProps) {
  const [logs, setLogs] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const logsRef = useRef<HTMLDivElement>(null);

  // `token` guards against out-of-order responses: the 3s auto-refresh and the
  // per-serverId initial fetch can overlap, so a slow/stale response could
  // otherwise write the previous server's logs after serverId changes. Each
  // effect run owns a token and cancels it on unmount/serverId change.
  const fetchLogs = async (
    isRefresh = false,
    token?: { cancelled: boolean }
  ) => {
    if (isRefresh) {
      setRefreshing(true);
    } else {
      setLoading(true);
    }

    try {
      const res = await fetch(`/api/dev-servers/${serverId}/logs?lines=200`);
      if (token?.cancelled) return;
      if (res.ok) {
        const data = await res.json();
        if (token?.cancelled) return;
        setLogs(data.logs || []);
      }
    } catch (err) {
      if (!token?.cancelled) console.error("Failed to fetch logs:", err);
    } finally {
      if (!token?.cancelled) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  };

  // Initial fetch
  useEffect(() => {
    // Clear any refresh spinner left stuck by an in-flight auto-refresh whose
    // token was cancelled by the previous serverId change (its finally skipped
    // setRefreshing(false)). The stale-write guard stays intact.
    setRefreshing(false);
    const token = { cancelled: false };
    fetchLogs(false, token);
    return () => {
      token.cancelled = true;
    };
  }, [serverId]);

  // Auto-scroll to bottom when logs update
  useEffect(() => {
    if (logsRef.current) {
      logsRef.current.scrollTop = logsRef.current.scrollHeight;
    }
  }, [logs]);

  // Auto-refresh every 3 seconds
  useEffect(() => {
    const token = { cancelled: false };
    const interval = setInterval(() => {
      fetchLogs(true, token);
    }, 3000);
    return () => {
      token.cancelled = true;
      clearInterval(interval);
    };
  }, [serverId]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div
        className={cn(
          "flex h-[80vh] w-full max-w-3xl flex-col rounded-xl",
          "bg-background border-border border",
          "shadow-2xl"
        )}
      >
        {/* Header */}
        <div className="border-border flex items-center justify-between border-b px-4 py-3">
          <h2 className="truncate text-lg font-semibold">Logs: {serverName}</h2>
          <div className="flex items-center gap-2">
            <button
              onClick={() => fetchLogs(true)}
              disabled={refreshing}
              className={cn(
                "hover:bg-muted rounded-md p-1.5 transition-colors",
                "disabled:opacity-50"
              )}
              title="Refresh"
            >
              <RefreshCw
                className={cn("h-4 w-4", refreshing && "animate-spin")}
              />
            </button>
            <button
              onClick={onClose}
              className="hover:bg-muted rounded-md p-1.5 transition-colors"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        {/* Logs content */}
        <div
          ref={logsRef}
          className={cn(
            "flex-1 overflow-auto p-4",
            "bg-zinc-950 font-mono text-sm leading-relaxed"
          )}
        >
          {loading ? (
            <div className="flex h-full items-center justify-center">
              <Loader2 className="text-muted-foreground h-5 w-5 animate-spin" />
              <span className="text-muted-foreground ml-2">
                Loading logs...
              </span>
            </div>
          ) : logs.length === 0 ? (
            <div className="text-muted-foreground flex h-full items-center justify-center">
              No logs available
            </div>
          ) : (
            <div className="space-y-0.5">
              {logs.map((line, i) => (
                <div
                  key={i}
                  className={cn(
                    "break-all whitespace-pre-wrap",
                    line.includes("error") || line.includes("Error")
                      ? "text-red-400"
                      : line.includes("warn") || line.includes("Warning")
                        ? "text-yellow-400"
                        : "text-zinc-300"
                  )}
                >
                  {line || " "}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="border-border text-muted-foreground border-t px-4 py-2 text-xs">
          Auto-refreshing every 3 seconds
          {refreshing && (
            <span className="ml-2">
              <RefreshCw className="inline h-3 w-3 animate-spin" />
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
