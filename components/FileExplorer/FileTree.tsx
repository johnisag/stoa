"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import {
  ChevronRight,
  ChevronDown,
  File,
  Folder,
  FolderOpen,
  Loader2,
  Copy,
  Plus,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import type { FileNode } from "@/lib/file-utils";
import { applyDirRefresh } from "@/lib/file-utils";
import type { DirRefreshResult } from "@/lib/file-utils";
import { relativePath, formatPathsForAgent } from "@/lib/path-display";
import { useCopyToClipboard } from "@/hooks/useCopyToClipboard";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";

interface FileTreeProps {
  nodes: FileNode[];
  basePath: string;
  onFileClick: (path: string) => void;
  /** Inject a path into the active agent's prompt (right-click → "Add to agent").
   *  Omitted where no terminal is in scope (e.g. the docked file drawer). */
  onAddToAgent?: (path: string) => void;
  /** Bump to force a refetch of every expanded directory (agent edits don't
   *  reach the tree otherwise — listings are cached on first expand). */
  refreshKey?: number;
  depth?: number;
}

/**
 * Recursive file tree component
 * Mobile-optimized with larger touch targets
 * Lazily loads directory contents when expanded
 */
export function FileTree({
  nodes,
  basePath,
  onFileClick,
  onAddToAgent,
  refreshKey = 0,
  depth = 0,
}: FileTreeProps) {
  // expanded + loadedChildren live in ONE state object so a refresh can swap
  // both atomically (applyDirRefresh) — separate setStates could tear when a
  // deleted dir must drop out of both maps at once.
  const [cache, setCache] = useState<{
    expanded: Set<string>;
    loadedChildren: Map<string, FileNode[]>;
  }>({ expanded: new Set(), loadedChildren: new Map() });
  const { expanded, loadedChildren } = cache;
  const [loadingDirs, setLoadingDirs] = useState<Set<string>>(new Set());
  const { copy } = useCopyToClipboard();
  const lastRefreshKey = useRef(refreshKey);
  // Ref mirror of `expanded` so the refresh effect can depend on refreshKey
  // alone — with `expanded` in deps, a user expand/collapse mid-flight would
  // cancel the in-flight batch and the re-run would early-return (key already
  // consumed), silently dropping that refresh for every dir. Synced via effect
  // (declared BEFORE the refresh effect so it runs first in the same flush) —
  // writing a ref during render is unsafe under concurrent rendering.
  const expandedRef = useRef(expanded);
  useEffect(() => {
    expandedRef.current = expanded;
  }, [expanded]);
  // Skip overlapping batches: with server latency above the poll interval a
  // new batch would cancel the previous one before it commits, starving the
  // expanded-dir listings. Skipping retries on the next tick instead.
  const refreshingRef = useRef(false);

  const handleCopyPath = useCallback(
    async (text: string) => {
      const ok = await copy(text);
      if (ok) toast.success("Copied to clipboard", { description: text });
      else toast.error("Couldn't copy to clipboard");
    },
    [copy]
  );

  const fetchChildren = useCallback(
    async (dirPath: string) => {
      if (loadedChildren.has(dirPath)) return;

      setLoadingDirs((prev) => new Set(prev).add(dirPath));
      try {
        const res = await fetch(
          `/api/files?path=${encodeURIComponent(dirPath)}`
        );
        if (!res.ok) throw new Error(`Failed to load directory: ${res.status}`);
        const data = await res.json();
        if (data.files) {
          setCache((prev) => ({
            ...prev,
            loadedChildren: new Map(prev.loadedChildren).set(
              dirPath,
              data.files
            ),
          }));
        }
      } catch (err) {
        console.error("Failed to load directory:", err);
      } finally {
        setLoadingDirs((prev) => {
          const next = new Set(prev);
          next.delete(dirPath);
          return next;
        });
      }
    },
    [loadedChildren]
  );

  // Refresh: bump of `refreshKey` refetches every expanded dir at this level.
  // Only SUCCESSFUL fetches update the cache — a transient failure (network
  // blip, server restart, 5xx) keeps the last-known listing so one bad tick
  // can't collapse the whole tree. Deleted dirs return an empty listing and
  // vanish from their parent's refreshed children. Nested levels get the same
  // key via props and refresh themselves.
  useEffect(() => {
    if (refreshKey === lastRefreshKey.current) return;
    lastRefreshKey.current = refreshKey;
    if (refreshingRef.current) return; // batch in flight; next tick retries
    const dirs = Array.from(expandedRef.current);
    if (dirs.length === 0) return;
    refreshingRef.current = true;
    const token = { cancelled: false };
    void (async () => {
      try {
        const settled = await Promise.all(
          dirs.map(async (dirPath): Promise<DirRefreshResult | null> => {
            try {
              const res = await fetch(
                `/api/files?path=${encodeURIComponent(dirPath)}`
              );
              if (!res.ok) return null; // transient: keep current listing
              const data = await res.json();
              if (!Array.isArray(data.files)) return null;
              return { path: dirPath, files: data.files as FileNode[] };
            } catch {
              return null; // network failure: keep current listing
            }
          })
        );
        if (token.cancelled) return;
        const results = settled.filter(
          (r): r is DirRefreshResult => r !== null
        );
        if (results.length === 0) return;
        setCache((prev) =>
          applyDirRefresh(prev.loadedChildren, prev.expanded, results)
        );
      } finally {
        refreshingRef.current = false;
      }
    })();
    return () => {
      token.cancelled = true;
    };
  }, [refreshKey]);

  const toggleExpand = useCallback(
    async (path: string) => {
      const isCurrentlyExpanded = expanded.has(path);

      setCache((prev) => {
        const next = new Set(prev.expanded);
        if (next.has(path)) {
          next.delete(path);
        } else {
          next.add(path);
        }
        return { ...prev, expanded: next };
      });

      // Fetch children if expanding and not already loaded
      if (!isCurrentlyExpanded && !loadedChildren.has(path)) {
        await fetchChildren(path);
      }
    },
    [expanded, loadedChildren, fetchChildren]
  );

  return (
    <div className="w-full">
      {nodes.map((node) => {
        const isExpanded = expanded.has(node.path);
        const isDirectory = node.type === "directory";
        const isLoading = loadingDirs.has(node.path);
        const children = loadedChildren.get(node.path) || node.children;

        return (
          <div key={node.path}>
            {/* File/Directory item */}
            <ContextMenu>
              <ContextMenuTrigger asChild>
                <button
                  onClick={() => {
                    if (isDirectory) {
                      toggleExpand(node.path);
                    } else {
                      onFileClick(node.path);
                    }
                  }}
                  className={cn(
                    "hover:bg-accent flex w-full items-center gap-2 px-2 py-2 text-left transition-colors",
                    "min-h-[40px] md:min-h-[32px]", // Touch target
                    "text-sm"
                  )}
                  style={{ paddingLeft: `${depth * 12 + 8}px` }}
                >
                  {/* Expand/collapse icon */}
                  {isDirectory && (
                    <span className="flex h-4 w-4 flex-shrink-0 items-center justify-center">
                      {isLoading ? (
                        <Loader2 className="text-muted-foreground h-3 w-3 animate-spin" />
                      ) : isExpanded ? (
                        <ChevronDown className="text-muted-foreground h-4 w-4" />
                      ) : (
                        <ChevronRight className="text-muted-foreground h-4 w-4" />
                      )}
                    </span>
                  )}

                  {/* Icon */}
                  <span className="flex-shrink-0">
                    {isDirectory ? (
                      isExpanded ? (
                        <FolderOpen className="h-4 w-4 text-blue-400" />
                      ) : (
                        <Folder className="h-4 w-4 text-blue-400" />
                      )
                    ) : (
                      <FileIcon extension={node.extension || ""} />
                    )}
                  </span>

                  {/* Name */}
                  <span
                    className={cn(
                      "flex-1 truncate",
                      isDirectory ? "font-medium" : "text-muted-foreground"
                    )}
                  >
                    {node.name}
                  </span>

                  {/* Size (files only, on desktop) */}
                  {!isDirectory && node.size !== undefined && (
                    <span className="text-muted-foreground hidden flex-shrink-0 text-xs md:block">
                      {formatFileSize(node.size)}
                    </span>
                  )}
                </button>
              </ContextMenuTrigger>
              <ContextMenuContent>
                {onAddToAgent && (
                  <ContextMenuItem
                    onSelect={() =>
                      onAddToAgent(formatPathsForAgent(node.path))
                    }
                  >
                    <Plus className="h-3.5 w-3.5" />
                    Add to agent
                  </ContextMenuItem>
                )}
                <ContextMenuItem onSelect={() => handleCopyPath(node.path)}>
                  <Copy className="h-3.5 w-3.5" />
                  Copy path
                </ContextMenuItem>
                <ContextMenuItem
                  onSelect={() =>
                    handleCopyPath(relativePath(node.path, basePath))
                  }
                >
                  <Copy className="h-3.5 w-3.5" />
                  Copy relative path
                </ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>

            {/* Children (if expanded) */}
            {isDirectory && isExpanded && children && children.length > 0 && (
              <FileTree
                nodes={children}
                basePath={basePath}
                onFileClick={onFileClick}
                onAddToAgent={onAddToAgent}
                refreshKey={refreshKey}
                depth={depth + 1}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * File icon based on extension
 */
function FileIcon({ extension }: { extension: string }) {
  const ext = extension.toLowerCase();

  // Color coding by file type
  const colorMap: Record<string, string> = {
    // JavaScript/TypeScript
    js: "text-yellow-400",
    jsx: "text-yellow-400",
    ts: "text-blue-400",
    tsx: "text-blue-400",
    // Styles
    css: "text-pink-400",
    scss: "text-pink-400",
    // Markup
    html: "text-orange-400",
    xml: "text-orange-400",
    // Data
    json: "text-green-400",
    yaml: "text-purple-400",
    yml: "text-purple-400",
    // Config
    md: "text-blue-300",
    toml: "text-gray-400",
    env: "text-yellow-300",
  };

  const color = colorMap[ext] || "text-muted-foreground";

  return <File className={cn("h-4 w-4", color)} />;
}

/**
 * Format file size for display
 */
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}
