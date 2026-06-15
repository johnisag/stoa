"use client";

import { useState, useCallback, useMemo, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { useDirectoryFilesQuery, useRecursiveFilesQuery } from "@/data/files";
import {
  flattenFileNodes,
  relativeDisplayPath,
  type FileNode,
} from "@/lib/file-utils";
import { fuzzyScore } from "@/lib/session-search";

interface RootsData {
  roots: string[];
  separator: string;
}

interface UseDirectoryBrowserOptions {
  initialPath?: string;
  /** Filter which files to show (e.g., directories only) */
  filter?: (node: FileNode) => boolean;
  /**
   * Opt in to fuzzy file search: when the search box is non-empty, search the
   * whole subtree under the current directory (bounded recursive listing,
   * ranked by fuzzyScore) instead of only filtering the current directory's
   * names. Off by default so the directory-only consumers are unchanged.
   */
  recursiveSearch?: boolean;
}

/** Cap recursive matches so a huge repo can't flood the picker grid. */
const RECURSIVE_RESULT_CAP = 100;

function sortFiles(files: FileNode[]): FileNode[] {
  return [...files].sort((a, b) => {
    if (a.type === "directory" && b.type !== "directory") return -1;
    if (a.type !== "directory" && b.type === "directory") return 1;
    return a.name.localeCompare(b.name);
  });
}

/** Split a path into its segments, tolerant of either separator. */
function splitSegments(p: string): string[] {
  return p.split(/[\\/]/).filter(Boolean);
}

/**
 * Determine whether a resolved path is a filesystem root (e.g. "/" on POSIX or
 * "C:\\" on Windows). Roots have no meaningful parent to navigate up to.
 */
function isRootPath(p: string, roots: string[]): boolean {
  if (p === "/") return true;
  const normalized = p.replace(/[\\/]+$/, "");
  // A Windows drive root collapses to "C:" once trailing separators are removed.
  if (/^[a-zA-Z]:$/.test(normalized)) return true;
  return roots.some(
    (r) => r.replace(/[\\/]+$/, "").toLowerCase() === normalized.toLowerCase()
  );
}

export function useDirectoryBrowser(options: UseDirectoryBrowserOptions = {}) {
  const { initialPath = "~", filter, recursiveSearch = false } = options;
  const filterRef = useRef(filter);
  filterRef.current = filter;

  const [requestedPath, setRequestedPath] = useState(initialPath);
  const [search, setSearch] = useState("");

  // An empty requested path means "show the top-level filesystem roots"
  // (used on Windows to list drive letters). We synthesize that listing from
  // the roots endpoint instead of hitting /api/files, which needs a real path.
  const showRoots = requestedPath === "";

  // Pass a stable placeholder while showing roots so the directory query stays
  // idle and never requests an empty path.
  const { data, isPending, error } = useDirectoryFilesQuery(
    showRoots ? "~" : requestedPath
  );

  // Filesystem roots + OS separator (drive letters on Windows, "/" on POSIX).
  const { data: rootsData } = useQuery<RootsData>({
    queryKey: ["files", "roots"],
    queryFn: async () => {
      const res = await fetch("/api/files/roots");
      const json = await res.json();
      return {
        roots: json.roots || ["/"],
        separator: json.separator || "/",
      };
    },
    staleTime: Infinity,
  });

  const roots = useMemo(() => rootsData?.roots || ["/"], [rootsData]);
  const separator = rootsData?.separator || "/";

  // Resolved path for display/navigation (e.g., "~" → "/Users/you").
  // While showing roots there is no current directory.
  const currentPath = showRoots ? "" : data?.resolvedPath || requestedPath;

  // Filter and sort files from query data. When showing roots we synthesize a
  // directory node per filesystem root (drive letters on Windows).
  const files = useMemo(() => {
    if (showRoots) {
      return roots.map<FileNode>((root) => ({
        name: root,
        path: root,
        type: "directory",
      }));
    }
    if (!data?.files) return [];
    const items = filterRef.current
      ? data.files.filter(filterRef.current)
      : data.files;
    return sortFiles(items);
  }, [showRoots, roots, data?.files, filter]);

  // Fuzzy file search across the subtree, opt-in. Only fetch the (bounded)
  // recursive listing while the user is actually searching, so plain browsing
  // never pays for it.
  const searchActive =
    recursiveSearch && search.trim().length > 0 && !showRoots;
  const recursiveQuery = useRecursiveFilesQuery(
    showRoots ? "~" : currentPath || requestedPath,
    searchActive
  );
  const recursiveReady = searchActive && !!recursiveQuery.data?.files;
  // Searching the subtree, but the (bounded) recursive listing hasn't landed yet
  // — the picker shows shallow current-dir matches meanwhile and an indicator.
  const recursiveLoading = searchActive && !recursiveReady;

  const { items: filteredFiles, total: recursiveMatchCount } = useMemo(() => {
    const q = search.trim();
    if (recursiveReady) {
      const root = currentPath || requestedPath;
      const scored: { node: FileNode; score: number }[] = [];
      for (const node of flattenFileNodes(recursiveQuery.data!.files)) {
        if (filterRef.current && !filterRef.current(node)) continue;
        const byName = fuzzyScore(q, node.name);
        const byPath = fuzzyScore(q, relativeDisplayPath(root, node.path));
        const score = Math.max(byName ?? -Infinity, byPath ?? -Infinity);
        if (score > -Infinity) scored.push({ node, score });
      }
      scored.sort((a, b) => b.score - a.score);
      return {
        items: scored.slice(0, RECURSIVE_RESULT_CAP).map((s) => s.node),
        total: scored.length,
      };
    }
    // Shallow current-directory filter (also the fallback while a recursive
    // search is still in flight).
    const items = q
      ? files.filter((f) => f.name.toLowerCase().includes(q.toLowerCase()))
      : files;
    return { items, total: null as number | null };
  }, [
    recursiveReady,
    recursiveQuery.data,
    files,
    search,
    currentPath,
    requestedPath,
  ]);

  const navigateTo = useCallback((path: string) => {
    setSearch("");
    setRequestedPath(path);
  }, []);

  const atTopLevel = useMemo(
    () => showRoots || isRootPath(currentPath, roots),
    [showRoots, currentPath, roots]
  );

  const navigateUp = useCallback(() => {
    // At a filesystem root, "up" lands on the top-level root listing so the
    // user can pick another drive (Windows) or stay put (POSIX has one root).
    if (atTopLevel) {
      navigateTo(roots.length > 1 ? "" : "/");
      return;
    }

    const parts = splitSegments(currentPath);

    // Windows drive path with a single segment beyond the drive (e.g. "C:\foo")
    // collapses back to the drive root "C:\".
    if (/^[a-zA-Z]:$/.test(parts[0] || "")) {
      if (parts.length <= 1) {
        navigateTo(parts[0] + separator);
      } else {
        parts.pop();
        const head = parts.shift()!;
        navigateTo(head + separator + parts.join(separator));
      }
      return;
    }

    // POSIX-style absolute path.
    if (parts.length > 1) {
      parts.pop();
      navigateTo("/" + parts.join("/"));
    } else {
      navigateTo("/");
    }
  }, [atTopLevel, currentPath, navigateTo, roots, separator]);

  const navigateHome = useCallback(() => {
    navigateTo("~");
  }, [navigateTo]);

  const pathSegments = useMemo(() => splitSegments(currentPath), [currentPath]);

  /**
   * Build the absolute path for the breadcrumb segment at `index`, using the
   * OS separator. On Windows the first segment is the drive (e.g. "C:") and is
   * joined with a trailing separator to form a valid root.
   */
  const pathForSegment = useCallback(
    (index: number): string => {
      const parts = pathSegments.slice(0, index + 1);
      if (/^[a-zA-Z]:$/.test(parts[0] || "")) {
        if (parts.length === 1) return parts[0] + separator;
        const head = parts.shift()!;
        return head + separator + parts.join(separator);
      }
      return "/" + parts.join("/");
    },
    [pathSegments, separator]
  );

  return {
    currentPath,
    files,
    filteredFiles,
    loading: showRoots ? false : isPending,
    error: showRoots ? null : error?.message || null,
    search,
    setSearch,
    /** True while showing ranked subtree matches (vs. a single directory). */
    searchingRecursively: recursiveReady,
    /** Searching the subtree but the recursive listing hasn't landed yet. */
    recursiveLoading,
    /** Total subtree matches before the display cap (null when not recursive). */
    recursiveMatchCount,
    /** Max matches shown (so the UI can say "top N of M"). */
    recursiveResultCap: RECURSIVE_RESULT_CAP,
    pathSegments,
    navigateTo,
    navigateUp,
    navigateHome,
    // Cross-platform navigation helpers
    roots,
    separator,
    atTopLevel,
    pathForSegment,
  };
}
