/**
 * Client-safe file utilities (no Node.js dependencies)
 */

export interface FileNode {
  name: string;
  path: string;
  type: "file" | "directory";
  size?: number;
  extension?: string;
  children?: FileNode[];
}

/**
 * Flatten a (possibly nested) file tree to just its FILE nodes, depth-first.
 * Used by the recursive file search in the picker: directories are dropped and
 * each returned node keeps its absolute `path`. Pure → unit-tested.
 */
export function flattenFileNodes(nodes: FileNode[]): FileNode[] {
  const out: FileNode[] = [];
  const walk = (list: FileNode[]) => {
    for (const node of list) {
      if (node.type === "directory") {
        if (node.children) walk(node.children);
      } else {
        out.push(node);
      }
    }
  };
  walk(nodes);
  return out;
}

/**
 * The display path of `fullPath` relative to `base` (forward-slashed), or the
 * bare name when it isn't under `base`. Lets the recursive picker disambiguate
 * same-named files (e.g. two `index.ts`) by where they live, cross-platform.
 */
export function relativeDisplayPath(base: string, fullPath: string): string {
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
  const b = norm(base);
  const f = norm(fullPath);
  // Windows paths are case-insensitive, so compare the boundary case-folded when
  // either side used backslashes (e.g. a DB-stored cwd `C:\Repo` vs an OS-resolved
  // `C:\repo`). POSIX stays case-sensitive. The returned segment keeps real casing.
  const winish = base.includes("\\") || fullPath.includes("\\");
  const cb = winish ? b.toLowerCase() : b;
  const cf = winish ? f.toLowerCase() : f;
  if (b && (cf === cb || cf.startsWith(cb + "/"))) {
    return f.slice(b.length + 1) || f;
  }
  return f.split("/").pop() || f;
}

/**
 * Get file extension for syntax highlighting
 */
export function getLanguageFromExtension(ext: string): string {
  const languageMap: Record<string, string> = {
    js: "javascript",
    jsx: "javascript",
    ts: "typescript",
    tsx: "typescript",
    py: "python",
    rb: "ruby",
    go: "go",
    rs: "rust",
    java: "java",
    c: "c",
    cpp: "cpp",
    cs: "csharp",
    php: "php",
    html: "html",
    css: "css",
    scss: "scss",
    json: "json",
    xml: "xml",
    yaml: "yaml",
    yml: "yaml",
    md: "markdown",
    sh: "bash",
    bash: "bash",
    zsh: "bash",
    sql: "sql",
    graphql: "graphql",
    vue: "vue",
    svelte: "svelte",
  };

  return languageMap[ext.toLowerCase()] || "plaintext";
}

/**
 * Result of re-fetching one directory's listing during a tree refresh.
 * Only successful fetches produce a result — transient failures (network
 * blip, server restart, 5xx) are skipped by the caller so the tree keeps its
 * last-known listing instead of collapsing every expanded dir on a hiccup.
 * A DELETED dir needs no special case: it returns an empty listing here, and
 * its parent's refreshed listing drops the node entirely.
 */
export interface DirRefreshResult {
  path: string;
  files: FileNode[];
}

/**
 * Merge refreshed directory listings into the FileTree's per-level cache.
 * Untouched dirs keep their cached children; expanded state is preserved
 * (returned as a fresh Set so the caller can swap both maps atomically).
 * Pure → unit-tested.
 */
export function applyDirRefresh(
  loadedChildren: ReadonlyMap<string, FileNode[]>,
  expanded: ReadonlySet<string>,
  results: DirRefreshResult[]
): { loadedChildren: Map<string, FileNode[]>; expanded: Set<string> } {
  const nextChildren = new Map(loadedChildren);
  for (const { path, files } of results) {
    nextChildren.set(path, files);
  }
  return { loadedChildren: nextChildren, expanded: new Set(expanded) };
}
