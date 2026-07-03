/**
 * OS-level sandbox launch tier (#27) — types.
 *
 * Replaces the all-or-nothing "yolo" (auto-approve = full host access) with a
 * tri-state: the operator can suppress an agent's permission prompts WITHOUT
 * also granting it unrestricted filesystem + network access.
 *
 *   - "prompt"         — the agent stops to ask (no bypass flag). Safest.
 *   - "sandboxed-auto" — the bypass flag is pushed (unattended) BUT the process
 *                        is OS-confined (FS scoped to the worktree set, net
 *                        optional). The sane middle for unattended fleets.
 *   - "full-bypass"    — today's behavior: bypass flag + no confinement.
 *
 * The wrapper is a PURE argv transform (see wrap.ts) so it is unit-testable
 * without ever running a real sandbox binary, and it is ADDITIVE — for any mode
 * but "sandboxed-auto" (or when the OS primitive is absent) it is a pass-through,
 * so the launch is byte-identical to pre-#27.
 */

export type ApprovalMode = "prompt" | "sandboxed-auto" | "full-bypass";

const APPROVAL_MODES: ReadonlySet<string> = new Set([
  "prompt",
  "sandboxed-auto",
  "full-bypass",
]);

/**
 * Coerce a persisted/legacy value into an ApprovalMode, FAIL-CLOSED: an unknown /
 * null value becomes the SAFEST mode ("prompt"), never a bypass. The legacy
 * boolean fallback (a row predating the column) is applied by the caller BEFORE
 * this — here an unrecognized string can only ever weaken to "prompt". Pure + no
 * imports, so it is safe to pull into a client component (unlike detect/wrap,
 * which pull in server-only platform helpers).
 */
export function coerceApprovalMode(value: unknown): ApprovalMode {
  return typeof value === "string" && APPROVAL_MODES.has(value)
    ? (value as ApprovalMode)
    : "prompt";
}

/** WHAT to confine — the writable roots + whether network egress is allowed. */
export interface SandboxPolicy {
  /** Directories the agent may write to (its worktree set + git internals + ~/.stoa). */
  rwRoots: string[];
  /** false = cut egress (--unshare-net); true = inherit host net (model/MCP reachable). */
  allowNet: boolean;
}

/** The available OS sandbox primitive on this host (null = none → pass-through). */
export type SandboxTool = "bwrap" | "sandbox-exec";

/**
 * The result of wrapping a spawn. The caller runs
 * `{ file, args: [...argsPrefix, originalFile, ...originalArgs] }`.
 * A pass-through returns `argsPrefix: []` and `file` unchanged.
 */
export interface SandboxWrap {
  /** The binary to actually spawn — the sandbox tool, or the original file. */
  file: string;
  /** Sandbox flags to prepend before the original file+args (empty = pass-through). */
  argsPrefix: string[];
  /** What actually happened (may be DOWNGRADED from the requested mode). */
  effectiveMode: ApprovalMode;
  /** true when "sandboxed-auto" fell back to a pass-through (no primitive/off-platform). */
  downgraded: boolean;
  /** The primitive used, or "none". */
  tool: SandboxTool | "none";
  /** Human-readable reason for a downgrade (for logs/UI). */
  reason?: string;
}
