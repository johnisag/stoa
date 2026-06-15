import { useQuery } from "@tanstack/react-query";
import { fileKeys } from "./keys";
import type { FileNode } from "@/lib/file-utils";

export { fileKeys };

export interface DirectoryData {
  files: FileNode[];
  resolvedPath: string;
}

async function fetchDirectory(
  path: string,
  opts: { recursive?: boolean; depth?: number } = {}
): Promise<DirectoryData> {
  const params = new URLSearchParams({ path });
  if (opts.recursive) {
    params.set("recursive", "true");
    if (opts.depth != null) params.set("depth", String(opts.depth));
  }
  const res = await fetch(`/api/files?${params}`);
  const data = await res.json();
  if (!res.ok || data.error)
    throw new Error(data.error || "Failed to fetch directory");
  return { files: data.files || [], resolvedPath: data.path || path };
}

export function useDirectoryFilesQuery(path: string) {
  return useQuery({
    queryKey: fileKeys.list(path),
    queryFn: () => fetchDirectory(path),
    staleTime: 10000,
  });
}

/**
 * Recursive listing of `path` (a bounded tree) for the picker's fuzzy file
 * search. Only fetched while `enabled` (i.e. the user is searching), so normal
 * browsing never pays for it. Cached briefly and keyed separately from the
 * shallow per-directory listing so the two don't clobber each other.
 */
export function useRecursiveFilesQuery(
  path: string,
  enabled: boolean,
  depth = 4
) {
  return useQuery({
    queryKey: [...fileKeys.list(path), "recursive", depth],
    queryFn: () => fetchDirectory(path, { recursive: true, depth }),
    enabled,
    staleTime: 15000,
  });
}
