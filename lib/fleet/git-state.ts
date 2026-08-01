import { normalizeClaim } from "@/lib/dispatch/claims";
import { runGit } from "@/lib/git";

const GIT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_GIT_OUTPUT_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_PATHS = 10_000;
const DEFAULT_SUMMARY_PATHS = 100;
const MAX_REPO_RELATIVE_PATH_BYTES = 4_096;

export const UNKNOWN_FLEET_PATH_CLAIM = "__unknown__";
const LEGACY_UNKNOWN_FLEET_PATH_CLAIM = "*";

export type FleetGitStateErrorCode =
  | "invalid_input"
  | "not_repository"
  | "git_failed"
  | "invalid_git_output"
  | "head_mismatch"
  | "base_not_ancestor"
  | "limit_exceeded";

export class FleetGitStateError extends Error {
  constructor(
    public readonly code: FleetGitStateErrorCode,
    message: string
  ) {
    super(message);
    this.name = "FleetGitStateError";
  }
}

export type FleetGitChangeKind =
  | "added"
  | "copied"
  | "deleted"
  | "modified"
  | "renamed"
  | "type_changed"
  | "unmerged"
  | "broken_pair";

export interface FleetGitPathChange {
  kind: FleetGitChangeKind;
  /** The destination path for copies/renames, otherwise the changed path. */
  path: string;
  /** The source path for copies/renames. */
  previousPath: string | null;
  /** Git's exact status token, including an optional copy/rename score. */
  status: string;
}

export interface FleetCommittedPathChange extends FleetGitPathChange {
  /** Null means git classified the file as binary. */
  insertions: number | null;
  /** Null means git classified the file as binary. */
  deletions: number | null;
  binary: boolean;
}

export type FleetSensitivePathReason =
  | "automation"
  | "authentication"
  | "build_configuration"
  | "dependency_lock"
  | "environment_or_secret"
  | "migration"
  | "repository_instructions";

export interface FleetSensitivePath {
  path: string;
  reason: FleetSensitivePathReason;
}

export interface FleetGitDiffSummary {
  committedFiles: number;
  stagedFiles: number;
  unstagedFiles: number;
  untrackedFiles: number;
  insertions: number;
  deletions: number;
  binaryFiles: number;
  renamedFiles: number;
  touchedPathSample: string[];
  touchedPathsTruncated: boolean;
}

export interface FleetGitState {
  repositoryRoot: string;
  baseSha: string;
  headSha: string;
  /** Null when HEAD is detached. */
  currentBranch: string | null;
  committedChanges: FleetCommittedPathChange[];
  committedPaths: string[];
  stagedChanges: FleetGitPathChange[];
  unstagedChanges: FleetGitPathChange[];
  dirtyTrackedPaths: string[];
  untrackedPaths: string[];
  allTouchedPaths: string[];
  sensitivePaths: FleetSensitivePath[];
  summary: FleetGitDiffSummary;
}

export interface CollectFleetGitStateOptions {
  cwd: string;
  /** A full (40- or 64-hex) commit ID captured when the task was leased. */
  baseSha: string;
  /** When supplied, collection fails unless the worktree HEAD is this exact ID. */
  expectedHeadSha?: string;
  /** Limits may only lower, never raise, the server-owned safety ceilings. */
  limits?: {
    maxGitOutputBytes?: number;
    maxPaths?: number;
    summaryPaths?: number;
  };
}

interface EffectiveLimits {
  maxGitOutputBytes: number;
  maxPaths: number;
  summaryPaths: number;
}

interface NumstatEntry {
  path: string;
  previousPath: string | null;
  insertions: number | null;
  deletions: number | null;
  binary: boolean;
}

function cappedPositiveInteger(
  value: number | undefined,
  ceiling: number
): number {
  if (value === undefined) return ceiling;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new FleetGitStateError(
      "invalid_input",
      "Fleet git-state limits must be positive integers"
    );
  }
  return Math.min(value, ceiling);
}

function effectiveLimits(
  limits: CollectFleetGitStateOptions["limits"]
): EffectiveLimits {
  return {
    maxGitOutputBytes: cappedPositiveInteger(
      limits?.maxGitOutputBytes,
      DEFAULT_MAX_GIT_OUTPUT_BYTES
    ),
    maxPaths: cappedPositiveInteger(limits?.maxPaths, DEFAULT_MAX_PATHS),
    summaryPaths: cappedPositiveInteger(
      limits?.summaryPaths,
      DEFAULT_SUMMARY_PATHS
    ),
  };
}

function isFullCommitId(value: string): boolean {
  return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(value);
}

function requireFullCommitId(value: string, label: string): string {
  const normalized = value.trim().toLowerCase();
  if (!isFullCommitId(normalized)) {
    throw new FleetGitStateError(
      "invalid_input",
      `${label} must be a full 40- or 64-hex commit ID`
    );
  }
  return normalized;
}

/**
 * Normalize a git-reported repository-relative path without losing hostile but
 * valid whitespace (tabs/newlines included). Absolute and traversal paths are
 * rejected instead of being repaired.
 */
export function normalizeFleetGitPath(raw: string): string | null {
  if (!raw || raw.includes("\0")) return null;
  let normalized = raw.replace(/\\/g, "/");
  if (
    normalized.startsWith("/") ||
    /^[a-z]:\//i.test(normalized) ||
    normalized === "~" ||
    normalized.startsWith("~/")
  ) {
    return null;
  }

  normalized = normalized.replace(/\/{2,}/g, "/");
  const segments = normalized.split("/");
  if (segments.some((segment) => segment === "..")) return null;
  normalized = segments.filter((segment) => segment !== ".").join("/");
  if (
    !normalized ||
    Buffer.byteLength(normalized, "utf8") > MAX_REPO_RELATIVE_PATH_BYTES
  ) {
    return null;
  }
  return normalized;
}

function requireFleetGitPath(raw: string): string {
  const normalized = normalizeFleetGitPath(raw);
  if (!normalized) {
    throw new FleetGitStateError(
      "invalid_git_output",
      "Git returned an invalid repository-relative path"
    );
  }
  return normalized;
}

function splitNul(output: string): string[] {
  const fields = output.split("\0");
  if (fields.at(-1) === "") fields.pop();
  if (fields.some((field) => field === "")) {
    throw new FleetGitStateError(
      "invalid_git_output",
      "Git returned a malformed NUL-delimited record"
    );
  }
  return fields;
}

function kindForStatus(status: string): FleetGitChangeKind {
  const code = status[0];
  if (code === "A") return "added";
  if (code === "C") return "copied";
  if (code === "D") return "deleted";
  if (code === "M") return "modified";
  if (code === "R") return "renamed";
  if (code === "T") return "type_changed";
  if (code === "U") return "unmerged";
  if (code === "B") return "broken_pair";
  throw new FleetGitStateError(
    "invalid_git_output",
    `Git returned an unsupported change status: ${status}`
  );
}

function parseNameStatus(
  output: string,
  maxPaths: number
): FleetGitPathChange[] {
  const fields = splitNul(output);
  const changes: FleetGitPathChange[] = [];

  for (let index = 0; index < fields.length;) {
    const status = fields[index++];
    if (!/^(?:A|D|M|T|U|B|[RC][0-9]{0,3})$/.test(status)) {
      throw new FleetGitStateError(
        "invalid_git_output",
        `Git returned a malformed change status: ${status}`
      );
    }
    const renameOrCopy = status.startsWith("R") || status.startsWith("C");
    const firstPath = fields[index++];
    if (firstPath === undefined) {
      throw new FleetGitStateError(
        "invalid_git_output",
        "Git returned a change without a path"
      );
    }

    const secondPath = renameOrCopy ? fields[index++] : undefined;
    if (renameOrCopy && secondPath === undefined) {
      throw new FleetGitStateError(
        "invalid_git_output",
        "Git returned a rename/copy without a destination path"
      );
    }

    changes.push({
      kind: kindForStatus(status),
      path: requireFleetGitPath(secondPath ?? firstPath),
      previousPath: renameOrCopy ? requireFleetGitPath(firstPath) : null,
      status,
    });
    if (changes.length > maxPaths) {
      throw new FleetGitStateError(
        "limit_exceeded",
        "Fleet git-state path limit exceeded"
      );
    }
  }
  return changes;
}

function parseCount(raw: string): number | null {
  if (raw === "-") return null;
  if (!/^(?:0|[1-9][0-9]*)$/.test(raw)) {
    throw new FleetGitStateError(
      "invalid_git_output",
      "Git returned a malformed numstat count"
    );
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new FleetGitStateError(
      "invalid_git_output",
      "Git returned an unsafe numstat count"
    );
  }
  return value;
}

function parseNumstat(output: string, maxPaths: number): NumstatEntry[] {
  const fields = splitNul(output);
  const entries: NumstatEntry[] = [];

  for (let index = 0; index < fields.length;) {
    const record = fields[index++];
    const firstTab = record.indexOf("\t");
    const secondTab = record.indexOf("\t", firstTab + 1);
    if (firstTab < 1 || secondTab < firstTab + 2) {
      throw new FleetGitStateError(
        "invalid_git_output",
        "Git returned a malformed numstat record"
      );
    }

    const insertions = parseCount(record.slice(0, firstTab));
    const deletions = parseCount(record.slice(firstTab + 1, secondTab));
    if ((insertions === null) !== (deletions === null)) {
      throw new FleetGitStateError(
        "invalid_git_output",
        "Git returned inconsistent binary numstat markers"
      );
    }

    const inlinePath = record.slice(secondTab + 1);
    let path: string;
    let previousPath: string | null = null;
    if (inlinePath) {
      path = requireFleetGitPath(inlinePath);
    } else {
      const source = fields[index++];
      const destination = fields[index++];
      if (source === undefined || destination === undefined) {
        throw new FleetGitStateError(
          "invalid_git_output",
          "Git returned a malformed rename/copy numstat record"
        );
      }
      previousPath = requireFleetGitPath(source);
      path = requireFleetGitPath(destination);
    }

    entries.push({
      path,
      previousPath,
      insertions,
      deletions,
      binary: insertions === null,
    });
    if (entries.length > maxPaths) {
      throw new FleetGitStateError(
        "limit_exceeded",
        "Fleet git-state path limit exceeded"
      );
    }
  }
  return entries;
}

function uniquePaths(changes: readonly FleetGitPathChange[]): string[] {
  const paths = new Set<string>();
  for (const change of changes) {
    if (change.previousPath) paths.add(change.previousPath);
    paths.add(change.path);
  }
  return [...paths];
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function pathSegments(path: string): string[] {
  return path.toLowerCase().split("/");
}

/** Classify paths that require stronger review even when a broad claim covers them. */
export function classifySensitiveFleetPath(
  rawPath: string
): FleetSensitivePathReason | null {
  const path = normalizeFleetGitPath(rawPath);
  if (!path) return "environment_or_secret";
  const lower = path.toLowerCase();
  const segments = pathSegments(path);
  const basename = segments.at(-1) ?? "";

  if (
    lower === ".github/workflows" ||
    lower.startsWith(".github/workflows/") ||
    lower === ".github/actions" ||
    lower.startsWith(".github/actions/") ||
    lower.startsWith(".circleci/") ||
    basename === ".gitlab-ci.yml" ||
    basename === "azure-pipelines.yml" ||
    basename === "jenkinsfile"
  ) {
    return "automation";
  }
  if (
    segments.some((segment) =>
      ["auth", "authentication", "oauth", "credentials"].includes(segment)
    ) ||
    /(?:^|[._-])(?:auth|oauth|credential|credentials)(?:[._-]|$)/.test(basename)
  ) {
    return "authentication";
  }
  if (
    basename === ".env" ||
    basename.startsWith(".env.") ||
    [".npmrc", ".pypirc", ".netrc", ".secrets", "credentials.json"].includes(
      basename
    ) ||
    segments.some((segment) => ["secret", "secrets"].includes(segment)) ||
    /(?:^|[._-])(?:secret|secrets|token|tokens|password|passwd)(?:[._-]|$)/.test(
      basename
    )
  ) {
    return "environment_or_secret";
  }
  if (
    [
      "package-lock.json",
      "npm-shrinkwrap.json",
      "pnpm-lock.yaml",
      "yarn.lock",
      "bun.lock",
      "bun.lockb",
      "cargo.lock",
      "gemfile.lock",
      "poetry.lock",
      "pipfile.lock",
      "uv.lock",
      "composer.lock",
      "go.sum",
    ].includes(basename)
  ) {
    return "dependency_lock";
  }
  if (
    segments.includes("migrations") ||
    segments.includes("migration") ||
    segments.includes("schema")
  ) {
    return "migration";
  }
  if (
    [
      "agents.md",
      "claude.md",
      "codex.md",
      ".cursorrules",
      "copilot-instructions.md",
    ].includes(basename)
  ) {
    return "repository_instructions";
  }
  if (
    basename === "package.json" ||
    basename === "makefile" ||
    basename === "cmakelists.txt" ||
    basename === "dockerfile" ||
    /^(?:docker-compose|compose)\.(?:yml|yaml)$/.test(basename) ||
    /^(?:build|webpack|vite|next|rollup|esbuild)\.config\./.test(basename) ||
    (segments.includes("scripts") &&
      /^(?:build|release|publish)(?:[._-]|$)/.test(basename))
  ) {
    return "build_configuration";
  }
  return null;
}

export function findSensitiveFleetPaths(
  paths: readonly string[]
): FleetSensitivePath[] {
  const sensitive: FleetSensitivePath[] = [];
  for (const path of unique(paths)) {
    const reason = classifySensitiveFleetPath(path);
    if (reason) sensitive.push({ path, reason });
  }
  return sensitive;
}

export interface FleetClaimDriftResult {
  normalizedClaims: string[];
  actualPaths: string[];
  coveredPaths: string[];
  driftPaths: string[];
  invalidClaims: string[];
  invalidActualPaths: string[];
  sensitivePaths: FleetSensitivePath[];
  unknownClaim: boolean;
  hasDrift: boolean;
}

/**
 * Compare authoritative git paths with approved repo-relative prefix claims.
 * `__unknown__` is a deliberate global wildcard (the existing `*` value remains
 * accepted for stored-plan compatibility), but malformed inputs still fail closed.
 */
export function compareFleetPathClaims(
  plannedPrefixClaims: readonly string[],
  gitPaths: readonly string[]
): FleetClaimDriftResult {
  const normalizedClaims: string[] = [];
  const invalidClaims: string[] = [];
  let unknownClaim = false;

  for (const raw of plannedPrefixClaims) {
    const trimmed = typeof raw === "string" ? raw.trim() : "";
    if (
      trimmed === UNKNOWN_FLEET_PATH_CLAIM ||
      trimmed === LEGACY_UNKNOWN_FLEET_PATH_CLAIM
    ) {
      unknownClaim = true;
      continue;
    }
    const claim = normalizeClaim(raw);
    if (!claim || claim === ".") {
      invalidClaims.push(String(raw));
    } else if (!normalizedClaims.includes(claim)) {
      normalizedClaims.push(claim);
    }
  }

  const actualPaths: string[] = [];
  const invalidActualPaths: string[] = [];
  for (const raw of gitPaths) {
    const path = normalizeFleetGitPath(raw);
    if (!path) {
      invalidActualPaths.push(String(raw));
    } else if (!actualPaths.includes(path)) {
      actualPaths.push(path);
    }
  }

  const coveredPaths: string[] = [];
  const driftPaths: string[] = [];
  for (const path of actualPaths) {
    const covered =
      unknownClaim ||
      normalizedClaims.some(
        (claim) => path === claim || path.startsWith(`${claim}/`)
      );
    (covered ? coveredPaths : driftPaths).push(path);
  }

  return {
    normalizedClaims,
    actualPaths,
    coveredPaths,
    driftPaths,
    invalidClaims,
    invalidActualPaths,
    sensitivePaths: findSensitiveFleetPaths(actualPaths),
    unknownClaim,
    hasDrift:
      invalidClaims.length > 0 ||
      invalidActualPaths.length > 0 ||
      driftPaths.length > 0,
  };
}

export async function collectFleetGitState(
  options: CollectFleetGitStateOptions
): Promise<FleetGitState> {
  const cwd = options.cwd.trim();
  if (!cwd) {
    throw new FleetGitStateError("invalid_input", "cwd is required");
  }
  const limits = effectiveLimits(options.limits);
  const requestedBaseSha = requireFullCommitId(options.baseSha, "baseSha");
  const requestedHeadSha = options.expectedHeadSha
    ? requireFullCommitId(options.expectedHeadSha, "expectedHeadSha")
    : null;
  let outputBytes = 0;

  const git = async (args: string[], operation: string): Promise<string> => {
    try {
      const { stdout } = await runGit(
        cwd,
        args,
        GIT_TIMEOUT_MS,
        limits.maxGitOutputBytes
      );
      outputBytes += Buffer.byteLength(stdout, "utf8");
      if (outputBytes > limits.maxGitOutputBytes) {
        throw new FleetGitStateError(
          "limit_exceeded",
          "Fleet git-state output limit exceeded"
        );
      }
      return stdout;
    } catch (error) {
      if (error instanceof FleetGitStateError) throw error;
      throw new FleetGitStateError(
        "git_failed",
        `Git failed while ${operation}`
      );
    }
  };

  const inside = (
    await git(["rev-parse", "--is-inside-work-tree"], "checking the repository")
  ).trim();
  if (inside !== "true") {
    throw new FleetGitStateError(
      "not_repository",
      "Fleet work must run inside a git worktree"
    );
  }
  const repositoryRoot = (
    await git(["rev-parse", "--show-toplevel"], "resolving the repository root")
  ).trim();
  if (!repositoryRoot) {
    throw new FleetGitStateError(
      "invalid_git_output",
      "Git returned an empty repository root"
    );
  }

  const baseSha = (
    await git(
      ["rev-parse", "--verify", "--quiet", `${requestedBaseSha}^{commit}`],
      "verifying the base commit"
    )
  )
    .trim()
    .toLowerCase();
  if (!isFullCommitId(baseSha) || baseSha !== requestedBaseSha) {
    throw new FleetGitStateError(
      "invalid_git_output",
      "Git did not resolve the exact requested base commit"
    );
  }

  const headSha = (
    await git(
      ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"],
      "resolving the worktree head"
    )
  )
    .trim()
    .toLowerCase();
  if (!isFullCommitId(headSha)) {
    throw new FleetGitStateError(
      "invalid_git_output",
      "Git returned an invalid HEAD commit ID"
    );
  }
  if (requestedHeadSha && headSha !== requestedHeadSha) {
    throw new FleetGitStateError(
      "head_mismatch",
      "Worktree HEAD moved after the Fleet operation was authorized"
    );
  }

  const mergeBase = (
    await git(["merge-base", baseSha, headSha], "checking task ancestry")
  )
    .trim()
    .toLowerCase();
  if (!isFullCommitId(mergeBase)) {
    throw new FleetGitStateError(
      "invalid_git_output",
      "Git returned an invalid merge-base commit ID"
    );
  }
  if (mergeBase !== baseSha) {
    throw new FleetGitStateError(
      "base_not_ancestor",
      "The Fleet task base is not an ancestor of its worktree HEAD"
    );
  }

  const branchOutput = (
    await git(["rev-parse", "--abbrev-ref", "HEAD"], "resolving the branch")
  ).trim();
  const currentBranch = branchOutput === "HEAD" ? null : branchOutput;
  if (!branchOutput || branchOutput.includes("\0")) {
    throw new FleetGitStateError(
      "invalid_git_output",
      "Git returned an invalid current branch"
    );
  }

  const diffOptions = [
    "--find-renames=50%",
    "--no-ext-diff",
    "--no-textconv",
    "--ignore-submodules=none",
  ];
  const committedRaw = await git(
    ["diff", "--name-status", "-z", ...diffOptions, baseSha, headSha, "--"],
    "collecting committed paths"
  );
  const numstatRaw = await git(
    ["diff", "--numstat", "-z", ...diffOptions, baseSha, headSha, "--"],
    "collecting committed diff statistics"
  );
  const stagedRaw = await git(
    ["diff", "--cached", "--name-status", "-z", ...diffOptions, "HEAD", "--"],
    "collecting staged paths"
  );
  const unstagedRaw = await git(
    ["diff", "--name-status", "-z", ...diffOptions, "HEAD", "--"],
    "collecting unstaged paths"
  );
  const untrackedRaw = await git(
    ["ls-files", "--others", "--exclude-standard", "-z", "--"],
    "collecting untracked paths"
  );

  const committed = parseNameStatus(committedRaw, limits.maxPaths);
  const numstat = parseNumstat(numstatRaw, limits.maxPaths);
  const statsByPath = new Map(numstat.map((entry) => [entry.path, entry]));
  const committedChanges: FleetCommittedPathChange[] = committed.map(
    (change) => {
      const stats = statsByPath.get(change.path);
      if (!stats || stats.previousPath !== change.previousPath) {
        throw new FleetGitStateError(
          "invalid_git_output",
          "Git name-status and numstat results did not match"
        );
      }
      return { ...change, ...stats };
    }
  );
  if (statsByPath.size !== committedChanges.length) {
    throw new FleetGitStateError(
      "invalid_git_output",
      "Git returned inconsistent committed path counts"
    );
  }

  const stagedChanges = parseNameStatus(stagedRaw, limits.maxPaths);
  const unstagedChanges = parseNameStatus(unstagedRaw, limits.maxPaths);
  const untrackedPaths = splitNul(untrackedRaw).map(requireFleetGitPath);
  if (untrackedPaths.length > limits.maxPaths) {
    throw new FleetGitStateError(
      "limit_exceeded",
      "Fleet git-state path limit exceeded"
    );
  }

  const committedPaths = uniquePaths(committedChanges);
  const dirtyTrackedPaths = unique([
    ...uniquePaths(stagedChanges),
    ...uniquePaths(unstagedChanges),
  ]);
  const allTouchedPaths = unique([
    ...committedPaths,
    ...dirtyTrackedPaths,
    ...untrackedPaths,
  ]);
  if (allTouchedPaths.length > limits.maxPaths) {
    throw new FleetGitStateError(
      "limit_exceeded",
      "Fleet git-state aggregate path limit exceeded"
    );
  }

  const insertions = committedChanges.reduce(
    (total, change) => total + (change.insertions ?? 0),
    0
  );
  const deletions = committedChanges.reduce(
    (total, change) => total + (change.deletions ?? 0),
    0
  );

  return {
    repositoryRoot,
    baseSha,
    headSha,
    currentBranch,
    committedChanges,
    committedPaths,
    stagedChanges,
    unstagedChanges,
    dirtyTrackedPaths,
    untrackedPaths,
    allTouchedPaths,
    sensitivePaths: findSensitiveFleetPaths(allTouchedPaths),
    summary: {
      committedFiles: committedChanges.length,
      stagedFiles: stagedChanges.length,
      unstagedFiles: unstagedChanges.length,
      untrackedFiles: untrackedPaths.length,
      insertions,
      deletions,
      binaryFiles: committedChanges.filter((change) => change.binary).length,
      renamedFiles: committedChanges.filter(
        (change) => change.kind === "renamed"
      ).length,
      touchedPathSample: allTouchedPaths.slice(0, limits.summaryPaths),
      touchedPathsTruncated: allTouchedPaths.length > limits.summaryPaths,
    },
  };
}
