/**
 * Regression for B007 — mcp/orchestration-server.ts URL-encodes interpolated ids.
 *
 * Every apiCall that puts a worker/conductor/run id into the URL path or query
 * must wrap it in encodeURIComponent (get_pipeline already did; the others did
 * not). An id containing a reserved char (#, &, /, space) otherwise corrupts the
 * request — e.g. `#` truncates the path at a fragment, `&` injects a query param.
 *
 * We call the exported tool handler directly with a stubbed global fetch and
 * assert the URLs it constructs.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// Deterministic conductor id (no marker lookup against the real cwd).
vi.mock("../lib/conductor-marker", () => ({
  resolveConductorSessionId: () => null,
  pickConductorId: (supplied: string | undefined) => supplied ?? null,
}));

import { handleToolCall } from "../mcp/orchestration-tools";

// Record every fetched URL; return a benign JSON body so each handler branch
// completes without throwing.
const fetchedUrls: string[] = [];
const fetchMock = vi.fn(async (url: string | URL) => {
  fetchedUrls.push(String(url));
  return {
    json: async () => ({
      workers: [],
      summary: {
        total: 0,
        pending: 0,
        running: 0,
        waiting: 0,
        completed: 0,
        failed: 0,
      },
      output: "(no output)",
      run: { id: "r", status: "running", steps: {} },
    }),
  } as unknown as Response;
});
vi.stubGlobal("fetch", fetchMock);

function callTool(name: string, args: Record<string, unknown>) {
  return handleToolCall({ params: { name, arguments: args } });
}

// An id with reserved URL chars: `#` (fragment), `&`+`=` (query injection),
// `/` (path), and a space — all of which must survive as %-escapes.
const NASTY = "w/1 a&b=c#frag";
const ENCODED = encodeURIComponent(NASTY);

beforeEach(() => {
  fetchedUrls.length = 0;
  fetchMock.mockClear();
});

describe("B007 — interpolated ids are URL-encoded", () => {
  it("encodes conductorId in list_workers query", async () => {
    await callTool("list_workers", { conductorId: NASTY });
    expect(fetchedUrls).toHaveLength(1);
    expect(fetchedUrls[0]).toContain(`conductorId=${ENCODED}`);
    expect(fetchedUrls[0]).not.toContain(NASTY);
  });

  it("encodes conductorId in get_workers_summary query", async () => {
    await callTool("get_workers_summary", { conductorId: NASTY });
    expect(fetchedUrls[0]).toContain(`conductorId=${ENCODED}`);
    expect(fetchedUrls[0]).toContain("summary=true");
    expect(fetchedUrls[0]).not.toContain(NASTY);
  });

  it("encodes workerId in get_worker_output path", async () => {
    await callTool("get_worker_output", { workerId: NASTY });
    expect(fetchedUrls[0]).toContain(`/workers/${ENCODED}?lines=`);
    expect(fetchedUrls[0]).not.toContain(NASTY);
  });

  it("encodes workerId in send_to_worker path", async () => {
    await callTool("send_to_worker", { workerId: NASTY, message: "hi" });
    expect(fetchedUrls[0]).toContain(`/workers/${ENCODED}`);
    expect(fetchedUrls[0]).not.toContain(NASTY);
  });

  it("encodes workerId in complete_worker path", async () => {
    await callTool("complete_worker", { workerId: NASTY });
    expect(fetchedUrls[0]).toContain(`/workers/${ENCODED}`);
    expect(fetchedUrls[0]).not.toContain(NASTY);
  });

  it("encodes workerId in kill_worker path (and keeps the cleanup query)", async () => {
    await callTool("kill_worker", { workerId: NASTY, cleanupWorktree: true });
    expect(fetchedUrls[0]).toContain(`/workers/${ENCODED}?cleanup=true`);
    expect(fetchedUrls[0]).not.toContain(NASTY);
  });

  it("still encodes runId in get_pipeline (unchanged baseline)", async () => {
    await callTool("get_pipeline", { runId: NASTY });
    expect(fetchedUrls[0]).toContain(`/pipelines/${ENCODED}`);
    expect(fetchedUrls[0]).not.toContain(NASTY);
  });

  it("rejects a missing runId before requesting an undefined pipeline", async () => {
    const result = await callTool("get_pipeline", {});
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("runId is required");
    expect(fetchedUrls).toHaveLength(0);
  });

  it("does not misclassify rendered worker output beginning with Error", async () => {
    fetchMock.mockResolvedValueOnce({
      json: async () => ({
        output: "Error: compiler diagnostic from the agent",
      }),
    } as unknown as Response);
    const result = await callTool("get_worker_output", {
      workerId: "worker-1",
    });
    expect(result.content[0]?.text).toBe(
      "Error: compiler diagnostic from the agent"
    );
    expect(result.isError).toBeUndefined();
  });

  it("still marks a worker-output API failure as a tool error", async () => {
    fetchMock.mockResolvedValueOnce({
      json: async () => ({ error: "worker not found" }),
    } as unknown as Response);
    const result = await callTool("get_worker_output", { workerId: "missing" });
    expect(result.content[0]?.text).toContain("worker not found");
    expect(result.isError).toBe(true);
  });

  it("does not treat a memory key named Error as a failed tool", async () => {
    fetchMock.mockResolvedValueOnce({
      json: async () => ({ entry: { value: "a legitimate note" } }),
    } as unknown as Response);
    const result = await callTool("memory_get", { key: "Error" });
    expect(result.content[0]?.text).toBe("Error: a legitimate note");
    expect(result.isError).toBeUndefined();
  });
});
