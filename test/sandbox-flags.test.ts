/**
 * #27 launch-tier flag semantics — the bypass-flag decision shared by the pty
 * (buildAgentArgs) and tmux (buildFlags) paths. Two invariants a maintainer must
 * not break:
 *   1. ADDITIVITY — a legacy autoApprove call is byte-identical to the derived
 *      approvalMode, so pre-#27 behavior is unchanged.
 *   2. FAIL-CLOSED — "sandboxed-auto" pushes the bypass flag ONLY when a sandbox
 *      is active; without one it withholds the flag (Codex keeps its own sandbox).
 */
import { describe, it, expect } from "vitest";
import {
  buildAgentArgs,
  shouldBypassPrompts,
  getProviderDefinition,
} from "@/lib/providers";

const CLAUDE_FLAG = getProviderDefinition("claude").autoApproveFlag!;
const CODEX_FLAG = getProviderDefinition("codex").autoApproveFlag!;

describe("shouldBypassPrompts", () => {
  it("full-bypass → true; prompt → false", () => {
    expect(shouldBypassPrompts({ approvalMode: "full-bypass" })).toBe(true);
    expect(shouldBypassPrompts({ approvalMode: "prompt" })).toBe(false);
  });

  it("sandboxed-auto → only when sandboxActive", () => {
    expect(
      shouldBypassPrompts({
        approvalMode: "sandboxed-auto",
        sandboxActive: true,
      })
    ).toBe(true);
    expect(
      shouldBypassPrompts({
        approvalMode: "sandboxed-auto",
        sandboxActive: false,
      })
    ).toBe(false);
    expect(shouldBypassPrompts({ approvalMode: "sandboxed-auto" })).toBe(false);
  });

  it("derives from legacy booleans when approvalMode is unset", () => {
    expect(shouldBypassPrompts({ autoApprove: true })).toBe(true);
    expect(shouldBypassPrompts({ skipPermissions: true })).toBe(true);
    expect(shouldBypassPrompts({ autoApprove: false })).toBe(false);
    expect(shouldBypassPrompts({})).toBe(false);
  });
});

describe("buildAgentArgs — additivity (pre-#27 byte-identical)", () => {
  it("legacy autoApprove:true === approvalMode:'full-bypass'", () => {
    expect(buildAgentArgs("claude", { autoApprove: true })).toEqual(
      buildAgentArgs("claude", { approvalMode: "full-bypass" })
    );
  });
  it("legacy autoApprove:false === approvalMode:'prompt'", () => {
    expect(buildAgentArgs("claude", { autoApprove: false })).toEqual(
      buildAgentArgs("claude", { approvalMode: "prompt" })
    );
  });
});

describe("buildAgentArgs — the bypass flag per mode", () => {
  it("pushes the flag for full-bypass, withholds for prompt", () => {
    expect(
      buildAgentArgs("claude", { approvalMode: "full-bypass" }).args
    ).toContain(CLAUDE_FLAG);
    expect(
      buildAgentArgs("claude", { approvalMode: "prompt" }).args
    ).not.toContain(CLAUDE_FLAG);
  });

  it("sandboxed-auto pushes the flag ONLY when a sandbox is active", () => {
    expect(
      buildAgentArgs("claude", {
        approvalMode: "sandboxed-auto",
        sandboxActive: true,
      }).args
    ).toContain(CLAUDE_FLAG);
    expect(
      buildAgentArgs("claude", {
        approvalMode: "sandboxed-auto",
        sandboxActive: false,
      }).args
    ).not.toContain(CLAUDE_FLAG);
  });

  it("CODEX: sandboxed-auto without an active sandbox withholds the sandbox-DISABLING flag (keeps its own sandbox)", () => {
    // The Codex trap: its bypass flag disables Codex's own sandbox. Pushing it
    // with no OS wrap = fully unsandboxed. Fail-closed handles it uniformly.
    expect(
      buildAgentArgs("codex", {
        approvalMode: "sandboxed-auto",
        sandboxActive: false,
      }).args
    ).not.toContain(CODEX_FLAG);
    // With a real OS wrap (sandboxActive) the flag is fine — bwrap is the control.
    expect(
      buildAgentArgs("codex", {
        approvalMode: "sandboxed-auto",
        sandboxActive: true,
      }).args
    ).toContain(CODEX_FLAG);
  });
});
