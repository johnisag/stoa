/**
 * Unit tests for the best_of_n action validator in lib/command/actions.ts.
 *
 * Mirrors the structure of test/command-actions.test.ts. All pure — no DB, no
 * spawning, no file I/O.
 */
import { describe, it, expect } from "vitest";
import {
  validateBestOfNParams,
  validateProposal,
  describeProposal,
} from "@/lib/command/actions";

const VALID_BASE = {
  task: "Fix the login bug",
  n: 2,
  projectId: "proj_1",
  conductorSessionId: "session-uuid-abc",
} as const;

describe("validateBestOfNParams — per-field rules", () => {
  it("accepts n=2 with task + projectId + conductorSessionId", () => {
    const res = validateBestOfNParams({ ...VALID_BASE });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.params.n).toBe(2);
      expect(res.params.task).toBe("Fix the login bug");
      expect(res.params.projectId).toBe("proj_1");
      expect(res.params.conductorSessionId).toBe("session-uuid-abc");
    }
  });

  it("accepts n=3", () => {
    const res = validateBestOfNParams({ ...VALID_BASE, n: 3 });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.params.n).toBe(3);
  });

  it("rejects n=1 (below minimum)", () => {
    const res = validateBestOfNParams({ ...VALID_BASE, n: 1 });
    expect(res.ok).toBe(false);
  });

  it("rejects n=4 (above maximum)", () => {
    const res = validateBestOfNParams({ ...VALID_BASE, n: 4 });
    expect(res.ok).toBe(false);
  });

  it("rejects n=0", () => {
    const res = validateBestOfNParams({ ...VALID_BASE, n: 0 });
    expect(res.ok).toBe(false);
  });

  it("rejects n as a string (type-level enforcement)", () => {
    const res = validateBestOfNParams({
      ...VALID_BASE,
      n: "3" as unknown as number,
    });
    expect(res.ok).toBe(false);
  });

  it("rejects missing task", () => {
    const { task: _t, ...rest } = VALID_BASE;
    const res = validateBestOfNParams(rest);
    expect(res.ok).toBe(false);
  });

  it("rejects empty task", () => {
    const res = validateBestOfNParams({ ...VALID_BASE, task: "" });
    expect(res.ok).toBe(false);
  });

  it("rejects whitespace-only task", () => {
    const res = validateBestOfNParams({ ...VALID_BASE, task: "   " });
    expect(res.ok).toBe(false);
  });

  it("strips control bytes from task", () => {
    const dirtyTask = "Fix" + String.fromCharCode(0) + "Bug";
    const res = validateBestOfNParams({ ...VALID_BASE, task: dirtyTask });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.params.task).toBe("FixBug");
  });

  it("rejects missing projectId", () => {
    const { projectId: _p, ...rest } = VALID_BASE;
    const res = validateBestOfNParams(rest);
    expect(res.ok).toBe(false);
  });

  it("rejects empty projectId", () => {
    const res = validateBestOfNParams({ ...VALID_BASE, projectId: "" });
    expect(res.ok).toBe(false);
  });

  it("rejects missing conductorSessionId", () => {
    const { conductorSessionId: _c, ...rest } = VALID_BASE;
    const res = validateBestOfNParams(rest);
    expect(res.ok).toBe(false);
  });

  it("rejects empty conductorSessionId", () => {
    const res = validateBestOfNParams({
      ...VALID_BASE,
      conductorSessionId: "",
    });
    expect(res.ok).toBe(false);
  });
});

describe("validateProposal — best_of_n on the allowlist", () => {
  it("accepts a well-formed best_of_n proposal with n=2", () => {
    const res = validateProposal({ action: "best_of_n", params: VALID_BASE });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.proposal.action).toBe("best_of_n");
      expect(res.proposal.params).toMatchObject({
        task: "Fix the login bug",
        n: 2,
        projectId: "proj_1",
        conductorSessionId: "session-uuid-abc",
      });
    }
  });

  it("accepts a well-formed best_of_n proposal with n=3", () => {
    const res = validateProposal({
      action: "best_of_n",
      params: { ...VALID_BASE, n: 3 },
    });
    expect(res.ok).toBe(true);
  });

  it("rejects best_of_n without projectId", () => {
    const { projectId: _p, ...rest } = VALID_BASE;
    const res = validateProposal({ action: "best_of_n", params: rest });
    expect(res.ok).toBe(false);
  });

  it("rejects best_of_n without task", () => {
    const { task: _t, ...rest } = VALID_BASE;
    const res = validateProposal({ action: "best_of_n", params: rest });
    expect(res.ok).toBe(false);
  });

  it("rejects best_of_n with n=0", () => {
    const res = validateProposal({
      action: "best_of_n",
      params: { ...VALID_BASE, n: 0 },
    });
    expect(res.ok).toBe(false);
  });

  it("rejects best_of_n without conductorSessionId", () => {
    const { conductorSessionId: _c, ...rest } = VALID_BASE;
    const res = validateProposal({ action: "best_of_n", params: rest });
    expect(res.ok).toBe(false);
  });

  it("is on the allowlist — validate does not reject it as unknown", () => {
    // The action name must be accepted (not rejected as unlisted).
    const res = validateProposal({ action: "best_of_n", params: VALID_BASE });
    expect(res.ok).toBe(true);
  });
});

describe("describeProposal — best_of_n human summary", () => {
  it("returns a short human description with n and task", () => {
    const res = validateProposal({ action: "best_of_n", params: VALID_BASE });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const desc = describeProposal(res.proposal, "MyProject");
    expect(desc).toContain("2");
    expect(desc).toContain("Fix the login bug");
    expect(desc).toContain("MyProject");
  });

  it("truncates a long task to 60 chars + ellipsis", () => {
    const longTask = "a".repeat(100);
    const res = validateProposal({
      action: "best_of_n",
      params: { ...VALID_BASE, task: longTask },
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const desc = describeProposal(res.proposal, "");
    expect(desc).toContain("...");
    // The truncated portion is 60 chars + "..." = 63 chars inside the quotes.
    expect(desc.length).toBeLessThan(200);
  });

  it("works without a contextName", () => {
    const res = validateProposal({ action: "best_of_n", params: VALID_BASE });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const desc = describeProposal(res.proposal, "");
    expect(typeof desc).toBe("string");
    expect(desc.length).toBeGreaterThan(0);
  });
});
