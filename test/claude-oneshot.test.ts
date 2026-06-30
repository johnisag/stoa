import { describe, it, expect, vi } from "vitest";

// Pin resolveBinary to null so the plan falls back to the BARE name, making the
// argv/binary assertions deterministic and identical on every OS (the real
// resolveBinary would otherwise return an absolute .cmd path on Windows).
// isWindows is left as the REAL value so `shell`/`windowsHide` are asserted
// against the platform the suite runs on (the cross-platform guard). We never
// spawn a real agent.
vi.mock("@/lib/platform", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/platform")>();
  return { ...actual, resolveBinary: () => null };
});

import { buildClaudeOneshotPlan } from "@/lib/claude-oneshot";
import { isWindows } from "@/lib/platform";

describe("buildClaudeOneshotPlan — cross-platform `claude -p` spawn plan", () => {
  it("uses `claude -p` and never carries a prompt in argv", () => {
    const plan = buildClaudeOneshotPlan();
    expect(plan.binary).toBe("claude");
    // args is EXACTLY ["-p"] — the prompt is piped on stdin, never argv. This is
    // both the injection-safety guard (argv under a shell is command-injectable)
    // and the argv-length-limit guard.
    expect(plan.args).toEqual(["-p"]);
  });

  it("spawns through a shell on Windows so the `.cmd` shim is executable (no EINVAL)", () => {
    const plan = buildClaudeOneshotPlan();
    // The whole point of #5: a bare `shell:false` spawn of the Windows `.cmd`
    // shim throws spawn EINVAL. `shell` must track isWindows.
    expect(plan.shell).toBe(isWindows);
    expect(plan.windowsHide).toBe(isWindows);
  });
});
