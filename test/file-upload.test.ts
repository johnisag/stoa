import { describe, it, expect } from "vitest";
import { partitionUploads } from "@/lib/file-upload";
import { formatPathsForAgent } from "@/lib/path-display";

// Helpers to build the PromiseSettledResult shapes partitionUploads consumes.
const ok = (value: string | null): PromiseSettledResult<string | null> => ({
  status: "fulfilled",
  value,
});
const rejected = (reason: unknown): PromiseSettledResult<string | null> => ({
  status: "rejected",
  reason,
});

describe("partitionUploads", () => {
  it("collects fulfilled paths and preserves order", () => {
    const { paths, failures } = partitionUploads([
      ok("/a/x.png"),
      ok("/a/y.png"),
      ok("/a/z.png"),
    ]);
    expect(paths).toEqual(["/a/x.png", "/a/y.png", "/a/z.png"]);
    expect(failures).toBe(0);
  });

  it("survives a partial failure: keeps the paths that landed, counts the rest", () => {
    const { paths, failures } = partitionUploads([
      ok("/a/x.png"),
      rejected(new Error("boom")),
      ok("/a/z.png"),
    ]);
    expect(paths).toEqual(["/a/x.png", "/a/z.png"]);
    expect(failures).toBe(1);
  });

  it("treats a resolved null (server returned no path) as a failure", () => {
    const { paths, failures } = partitionUploads([ok(null), ok("/a/y.png")]);
    expect(paths).toEqual(["/a/y.png"]);
    expect(failures).toBe(1);
  });

  it("handles an all-failure batch", () => {
    const { paths, failures } = partitionUploads([rejected("nope"), ok(null)]);
    expect(paths).toEqual([]);
    expect(failures).toBe(2);
  });

  it("handles an empty batch", () => {
    expect(partitionUploads([])).toEqual({ paths: [], failures: 0 });
  });

  it("feeds the surviving paths into one formatPathsForAgent injection", () => {
    // The bulk-attach contract: every successful path goes in as a single
    // space-joined injection, quoting only the path that needs it.
    const { paths } = partitionUploads([
      ok("/a/x.png"),
      rejected(new Error("dropped")),
      ok("/a/my dir/y.png"),
    ]);
    expect(formatPathsForAgent(paths)).toBe('/a/x.png "/a/my dir/y.png" ');
  });
});
