/**
 * Agent detection manifests — a data-driven pattern system inspired by Herdr's
 * TOML manifests (src/detect/manifests/<agent>.toml).
 *
 * Each manifest defines the screen-content patterns that identify a specific
 * agent's state. Patterns are DATA, not code — they can be overridden at
 * runtime (user-level manifests) without a code change or deploy, and new
 * agents can be added without touching the status detector.
 *
 * Manifest format (JSON):
 * {
 *   "id": "claude",
 *   "version": 1,
 *   "waiting": ["\\[Y/n\\]", "\\[y/N\\]", "Allow\\?"],
 *   "running": ["esc to interrupt", "⠋", "⠙", ...],
 *   "error": ["Error code: \\d{3}.*invalid_request_error"],
 *   "idle": ["\\$\\s*$", ">\\s*$"]
 * }
 *
 * Patterns are RegExp source strings (the manifest stores the pattern as a
 * string; the loader compiles them). This matches Herdr's approach.
 *
 * Resolution order:
 *   1. User override: ~/.stoa/detection/<id>.json
 *   2. Bundled default: data/detection/<id>.json (shipped with Stoa)
 *   3. Hardcoded fallback: the arrays in lib/status-detector.ts
 *
 * The hardcoded fallback ensures Stoa works identically even if no manifest
 * files exist — the manifests are an enhancement layer, not a dependency.
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { homeDir } from "../platform";

/** A single agent's detection manifest. */
export interface AgentManifest {
  /** The agent id (e.g. "claude", "codex", "hermes"). */
  id: string;
  /** Manifest format version (bump on incompatible schema changes). */
  version: number;
  /** RegExp source strings for waiting/blocker patterns. */
  waiting: string[];
  /** RegExp source strings for running/working patterns. */
  running: string[];
  /** RegExp source strings for error patterns. */
  error: string[];
  /** RegExp source strings for idle chrome patterns. */
  idle: string[];
}

/** Compiled manifest — patterns pre-compiled to RegExp for performance. */
export interface CompiledManifest {
  id: string;
  waiting: RegExp[];
  running: RegExp[];
  error: RegExp[];
  idle: RegExp[];
  /** Where this manifest was loaded from. */
  source: "user-override" | "bundled" | "fallback";
}

/**
 * The hardcoded fallback patterns. These mirror the arrays already in
 * lib/status-detector.ts. If no manifest file exists for an agent, these
 * are used directly — Stoa works identically to before.
 *
 * Each entry is the RegExp SOURCE (string), not a compiled RegExp, so the
 * manifest format is consistent between bundled defaults and user overrides.
 */
const FALLBACK_MANIFESTS: Record<string, AgentManifest> = {
  default: {
    id: "default",
    version: 1,
    waiting: [
      "\\[Y/n\\]",
      "\\[y/N\\]",
      "Allow\\?",
      "Approve\\?",
      "Continue\\?",
      "Press Enter to",
      "waiting for input",
      "\\(yes/no\\)",
      "Do you want to",
      "Enter to confirm.*Esc to cancel",
      ">\\s*1\\.\\s*Yes",
      "Yes, allow all",
      "allow all edits",
      "allow all commands",
    ],
    running: [
      "esc to interrupt",
      "\\(esc to interrupt\\)",
      "· esc to interrupt",
      "⠋|⠙|⠹|⠸|⠼|⠴|⠦|⠧|⠇|⠏",
    ],
    error: [
      "\\bError code: \\d{3}\\b[^\\n]*\\binvalid_request_error\\b",
      "You're out of (extra )?usage",
      "\\bquota (exceeded|exhausted)\\b",
      "\\binsufficient[_ ](quota|credit|balance)\\b",
    ],
    idle: ["\\$\\s*$", ">\\s*$", "%\\s*$"],
  },
};

/** The user-override directory: ~/.stoa/detection/<id>.json */
export function userManifestDir(): string {
  return join(homeDir(), ".stoa", "detection");
}

/** The bundled manifest directory: data/detection/<id>.json */
export function bundledManifestDir(): string {
  return join(process.cwd(), "data", "detection");
}

/**
 * Load and compile a manifest for an agent id. Resolution order:
 *   1. User override (~/.stoa/detection/<id>.json)
 *   2. Bundled default (data/detection/<id>.json)
 *   3. Hardcoded fallback (FALLBACK_MANIFESTS.default)
 *
 * Returns null if the manifest file exists but is malformed (fail-closed:
 * don't silently use partial patterns). A missing file falls through to the
 * next source.
 */
export function loadManifest(agentId: string): CompiledManifest {
  // 1. User override
  const userPath = join(userManifestDir(), `${agentId}.json`);
  const userResult = tryLoadManifestFile(userPath, agentId, "user-override");
  if (userResult !== null) return userResult;

  // 2. Bundled default
  const bundledPath = join(bundledManifestDir(), `${agentId}.json`);
  const bundledResult = tryLoadManifestFile(bundledPath, agentId, "bundled");
  if (bundledResult !== null) return bundledResult;

  // 3. Hardcoded fallback
  const fallback = FALLBACK_MANIFESTS.default;
  return compileManifest(fallback, "fallback");
}

/**
 * Try to load and compile a manifest from a file path. Returns null if the
 * file doesn't exist (fall through to next source) or is malformed (fail-
 * closed: log and fall through).
 */
function tryLoadManifestFile(
  path: string,
  expectedId: string,
  source: "user-override" | "bundled"
): CompiledManifest | null {
  if (!existsSync(path)) return null;

  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null; // I/O error — fall through to next source
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.warn(
      `[detection] malformed manifest at ${path}, falling through to defaults:`,
      err
    );
    return null;
  }

  const manifest = validateManifest(parsed, expectedId);
  if (!manifest) {
    console.warn(
      `[detection] invalid manifest schema at ${path}, falling through to defaults`
    );
    return null;
  }

  return compileManifest(manifest, source);
}

/**
 * Validate a parsed JSON object against the AgentManifest schema. Returns the
 * typed manifest if valid, null otherwise. Fail-closed: any structural issue
 * (missing fields, wrong types, invalid regex) → null.
 */
export function validateManifest(
  raw: unknown,
  expectedId: string
): AgentManifest | null {
  if (typeof raw !== "object" || raw === null) return null;
  const obj = raw as Record<string, unknown>;

  if (obj.id !== expectedId) return null;
  if (typeof obj.version !== "number" || !Number.isInteger(obj.version))
    return null;

  const waiting = validatePatternArray(obj.waiting);
  const running = validatePatternArray(obj.running);
  const error = validatePatternArray(obj.error);
  const idle = validatePatternArray(obj.idle);

  if (!waiting || !running || !error || !idle) return null;

  // Validate that all patterns compile as RegExp.
  for (const source of [...waiting, ...running, ...error, ...idle]) {
    try {
      new RegExp(source);
    } catch {
      return null; // invalid regex — fail-closed
    }
  }

  return {
    id: expectedId,
    version: obj.version,
    waiting,
    running,
    error,
    idle,
  };
}

function validatePatternArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.every((v) => typeof v === "string") ? (value as string[]) : null;
}

function compileManifest(
  manifest: AgentManifest,
  source: "user-override" | "bundled" | "fallback"
): CompiledManifest {
  return {
    id: manifest.id,
    waiting: manifest.waiting.map((s) => new RegExp(s, "i")),
    running: manifest.running.map((s) => new RegExp(s, "i")),
    error: manifest.error.map((s) => new RegExp(s, "i")),
    idle: manifest.idle.map((s) => new RegExp(s, "m")),
    source,
  };
}

/**
 * In-memory manifest cache. Manifests are loaded once and cached for the
 * process lifetime. A `reload()` clears the cache so manifests can be hot-
 * reloaded (future: via an API route or file watcher).
 */
const manifestCache = new Map<string, CompiledManifest>();

/** Get the compiled manifest for an agent id (cached). */
export function getManifest(agentId: string): CompiledManifest {
  let cached = manifestCache.get(agentId);
  if (!cached) {
    cached = loadManifest(agentId);
    manifestCache.set(agentId, cached);
  }
  return cached;
}

/** Clear the manifest cache so the next getManifest() re-reads from disk. */
export function reloadManifests(): void {
  manifestCache.clear();
}
