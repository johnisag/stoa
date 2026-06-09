import { describe, it, expect, beforeEach, vi } from "vitest";

// Regression coverage for the dispatch label fix: `gh issue create` aborts the
// whole issue if a --label doesn't exist on the repo, so ensureLabelsExist
// pre-creates the missing ones. We mock child_process so no real gh runs (CI on
// all three OSes). promisify(execFile) resolves with whatever object the
// callback receives, and rejects with the Error passed as the first arg.
const { state } = vi.hoisted(() => ({
  state: {
    listStdout: "[]",
    listError: null as Error | null,
    createError: null as (Error & { stderr?: string }) | null,
    calls: [] as string[][],
  },
}));

vi.mock("child_process", () => ({
  // resolveBinary("gh") → no match → gh falls back to the bare "gh".
  execFileSync: () => "",
  execFile: (
    _file: string,
    args: string[],
    optsOrCb: unknown,
    cb?: unknown
  ) => {
    const callback = (typeof optsOrCb === "function" ? optsOrCb : cb) as (
      err: Error | null,
      result?: { stdout: string; stderr: string }
    ) => void;
    state.calls.push(args);
    const sub = args[1]; // "list" | "create"
    if (sub === "list") {
      if (state.listError) return callback(state.listError);
      return callback(null, { stdout: state.listStdout, stderr: "" });
    }
    if (sub === "create") {
      if (state.createError) return callback(state.createError);
      return callback(null, { stdout: "", stderr: "" });
    }
    return callback(null, { stdout: "", stderr: "" });
  },
}));

import { ensureLabelsExist } from "../lib/dispatch/create";

const creates = () => state.calls.filter((a) => a[1] === "create");

beforeEach(() => {
  state.listStdout = "[]";
  state.listError = null;
  state.createError = null;
  state.calls.length = 0;
});

describe("ensureLabelsExist", () => {
  it("does nothing (no gh calls) when there are no non-blank labels", async () => {
    expect(await ensureLabelsExist("octo/app", "/cwd", ["", "  "])).toEqual([]);
    expect(state.calls).toHaveLength(0);
  });

  it("creates only the missing labels, after a -- sentinel, and returns them", async () => {
    state.listStdout = JSON.stringify([{ name: "bug" }]);
    const created = await ensureLabelsExist("octo/app", "/cwd", ["bug", "mit"]);
    expect(created).toEqual(["mit"]);
    expect(creates()).toEqual([
      ["label", "create", "--repo", "octo/app", "--", "mit"],
    ]);
  });

  it("creates nothing when every label already exists (case-insensitive)", async () => {
    state.listStdout = JSON.stringify([{ name: "Bug" }, { name: "ready" }]);
    const created = await ensureLabelsExist("octo/app", "/cwd", [
      "bug",
      "READY",
    ]);
    expect(created).toEqual([]);
    expect(creates()).toHaveLength(0);
  });

  it("swallows an 'already exists' create error (race / list failed)", async () => {
    state.listError = new Error("gh list failed"); // forces every label "missing"
    const err = new Error("dupe") as Error & { stderr?: string };
    err.stderr = 'label with name "mit" already exists; use --force to update';
    state.createError = err;
    const created = await ensureLabelsExist("octo/app", "/cwd", ["mit"]);
    expect(created).toEqual([]);
  });

  it("throws a clear error when a label create genuinely fails", async () => {
    const err = new Error("forbidden") as Error & { stderr?: string };
    err.stderr = "HTTP 403: Resource not accessible by integration";
    state.createError = err;
    await expect(
      ensureLabelsExist("octo/app", "/cwd", ["mit"])
    ).rejects.toThrow(/Could not create label 'mit' on octo\/app/);
  });
});
