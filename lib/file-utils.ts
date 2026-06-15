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
  if (b && (f === b || f.startsWith(b + "/"))) {
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
