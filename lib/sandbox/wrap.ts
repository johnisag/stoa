/**
 * The single sandbox argv transform (#27) — PURE. Given an already-resolved
 * spawn (binary + args), the requested mode, and the policy, returns how to
 * actually launch it.
 *
 * ADDITIVITY (the load-bearing invariant, locked by tests): for any mode other
 * than "sandboxed-auto" — OR when the OS primitive is absent / off-platform — it
 * returns a PASS-THROUGH (`argsPrefix: []`, `file` unchanged), so a launch is
 * byte-identical to pre-#27. Only "sandboxed-auto" WITH a detected primitive
 * actually wraps.
 *
 * FAIL-SAFE: detection failure or a wrap-build error never throws — it degrades
 * to a pass-through with `downgraded: true` and a reason (mirrors the
 * `resolveBinary() || name` idiom). The caller decides the flag semantics
 * separately (see providers.buildAgentArgs), so a downgrade to pass-through here
 * pairs with the caller NOT pushing the bypass flag when no sandbox is active —
 * i.e. the whole thing fails CLOSED, never to unattended-and-unconfined.
 */

import { detectSandboxTool, type DetectedSandbox } from "./detect";
import { buildBwrapArgs } from "./linux";
import type { ApprovalMode, SandboxPolicy, SandboxWrap } from "./types";

export interface WrapDeps {
  platform?: NodeJS.Platform;
  /** Injectable primitive detector (defaults to the real detectSandboxTool). */
  detect?: (platform: NodeJS.Platform) => DetectedSandbox | null;
}

export function wrapSpawnForSandbox(
  spawn: { file: string; args: string[] },
  mode: ApprovalMode,
  policy: SandboxPolicy,
  deps: WrapDeps = {}
): SandboxWrap {
  const platform = deps.platform ?? process.platform;
  const passThrough = (
    downgraded: boolean,
    reason?: string,
    effectiveMode: ApprovalMode = mode
  ): SandboxWrap => ({
    file: spawn.file,
    argsPrefix: [],
    effectiveMode,
    downgraded,
    tool: "none",
    reason,
  });

  // Only the sandboxed tier wraps; prompt/full-bypass are byte-identical to today.
  if (mode !== "sandboxed-auto") return passThrough(false);

  const detected = (deps.detect ?? detectSandboxTool)(platform);
  if (!detected) {
    // No OS primitive — degrade to a pass-through. The caller pairs this with
    // dropping the bypass flag, so the effective mode is the safer "prompt".
    return passThrough(
      true,
      `no OS sandbox primitive on ${platform}`,
      "prompt"
    );
  }

  try {
    // Only bwrap ships in PR1; a future darwin/sandbox-exec builder slots here.
    const { file, argsPrefix } = buildBwrapArgs(detected.path, policy);
    return {
      file,
      argsPrefix,
      effectiveMode: "sandboxed-auto",
      downgraded: false,
      tool: detected.tool,
    };
  } catch (err) {
    return passThrough(
      true,
      `sandbox wrap failed: ${err instanceof Error ? err.message : String(err)}`,
      "prompt"
    );
  }
}
