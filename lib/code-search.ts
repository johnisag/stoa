/**
 * Resolve ripgrep's bundled binary path at runtime.
 *
 * Turbopack traces even a literal `require("@vscode/ripgrep")` and tries to
 * bundle the platform package's raw `rg.exe` ("Unknown module type"), which
 * breaks `next dev`. We resolve the real Node require and pass a NON-LITERAL
 * specifier so the bundler can't follow it; the module is loaded from
 * node_modules at runtime. Paired with serverExternalPackages in next.config.ts.
 */
function getRgPath(): string {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const nodeRequire = eval("require") as NodeRequire;
  const pkg = ["@vscode", "ripgrep"].join("/");
  return (nodeRequire(pkg) as { rgPath: string }).rgPath;
}

/**
 * Check if ripgrep is available. ripgrep is now bundled via @vscode/ripgrep,
 * so it is always available regardless of platform.
 */
export function isRipgrepAvailable(): boolean {
  return true;
}

export interface SearchOptions {
  maxResults?: number;
  contextLines?: number;
  filePattern?: string;
  caseSensitive?: boolean;
}

export interface SearchMatch {
  type: "match";
  data: {
    path: { text: string };
    lines: { text: string };
    line_number: number;
    absolute_offset: number;
    submatches: Array<{ match: { text: string }; start: number; end: number }>;
  };
}

export interface FormattedMatch {
  file: string;
  line: number;
  column: number;
  matchText: string;
  lineText: string;
}

/**
 * Build the ripgrep argv from a query + options. Extracted as a pure function
 * so the flag handling (case sensitivity, file globbing) can be unit-tested
 * without spawning a process.
 */
export function buildSearchArgs(
  query: string,
  options: SearchOptions = {}
): string[] {
  const {
    maxResults = 100,
    contextLines = 2,
    filePattern = "*",
    caseSensitive = false,
  } = options;

  const args = [
    "--json",
    `--max-count=${Math.ceil(maxResults / 10)}`,
    `--context=${contextLines}`,
  ];

  // Honor case sensitivity: only force case-insensitive matching when the
  // caller didn't ask for a case-sensitive search.
  if (!caseSensitive) {
    args.push("--ignore-case");
  }

  // Honor a file-scoped request: a non-default pattern restricts the search.
  if (filePattern && filePattern !== "*") {
    args.push(`--glob=${filePattern}`);
  }

  args.push(
    query,
    "." // CRITICAL: Tell ripgrep to search current directory explicitly
  );

  return args;
}

export function searchCode(
  workingDir: string,
  query: string,
  options: SearchOptions = {}
): SearchMatch[] {
  const { maxResults = 100 } = options;

  try {
    // Use spawn instead of execSync for better control
    const { spawnSync } = require("child_process");

    const args = buildSearchArgs(query, options);

    const rgPath = getRgPath();
    const result = spawnSync(rgPath, args, {
      cwd: workingDir,
      encoding: "utf-8",
      timeout: 10000,
      maxBuffer: 1024 * 1024 * 5,
      stdio: ["ignore", "pipe", "pipe"], // Ignore stdin so ripgrep doesn't wait for it
      windowsHide: process.platform === "win32",
    });

    if (result.error) {
      throw result.error;
    }

    // Status 1 = no matches (not an error for ripgrep)
    if (result.status !== 0 && result.status !== 1) {
      return [];
    }

    const output = result.stdout || "";
    const matches: SearchMatch[] = [];
    const lines = output.trim().split("\n").filter(Boolean);

    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        if (parsed.type === "match") {
          matches.push(parsed);
          if (matches.length >= maxResults) break;
        }
      } catch {
        continue;
      }
    }

    return matches;
  } catch (error) {
    console.error("Error in searchCode:", error);
    // ENOENT = bundled ripgrep binary missing
    if ((error as any).code === "ENOENT") {
      throw new Error(
        `bundled ripgrep binary not found at ${getRgPath()}. Try reinstalling dependencies.`
      );
    }
    // Other errors - return empty
    return [];
  }
}

export function formatSearchResults(matches: SearchMatch[]): FormattedMatch[] {
  return matches.map((match) => ({
    file: match.data.path.text,
    line: match.data.line_number,
    column: match.data.submatches[0]?.start || 0,
    matchText: match.data.submatches[0]?.match.text || "",
    lineText: match.data.lines.text,
  }));
}
