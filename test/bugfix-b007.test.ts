/**
 * Regression for B007 — mcp/orchestration-server.ts URL-encodes interpolated ids.
 *
 * Every apiCall that puts a worker/conductor/run id into the URL path or query
 * must wrap it in encodeURIComponent (get_pipeline already did; the others did
 * not). An id containing a reserved char (#, &, /, space) otherwise corrupts the
 * request — e.g. `#` truncates the path at a fragment, `&` injects a query param.
 *
 * Drives the REAL request handler from the server module: we mock the MCP SDK's
 * Server to capture the registered CallToolRequestSchema handler, no-op the stdio
 * transport so the module's main() is harmless, and stub fetch to record the URL.
 */
import { describe, it, expect, beforeEach, beforeAll, vi } from "vitest";

// Capture the CallToolRequestSchema handler the module registers, and no-op the
// transport/connect so importing the module doesn't try to talk over stdio.
const handlers = vi.hoisted(
  () => new Map<unknown, (req: unknown) => Promise<unknown>>()
);
vi.mock("@modelcontextprotocol/sdk/server/index.js", () => ({
  Server: class {
    setRequestHandler(schema: unknown, fn: (req: unknown) => Promise<unknown>) {
      handlers.set(schema, fn);
    }
    async connect() {}
  },
}));
vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({
  StdioServerTransport: class {},
}));

// Deterministic conductor id (no marker lookup against the real cwd).
vi.mock("../lib/conductor-marker", () => ({
  resolveConductorSessionId: () => null,
  pickConductorId: (supplied: string | undefined) => supplied ?? null,
}));

import { CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";

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

// Import after the mocks are in place; this registers the handler. Done inside
// beforeAll (not at top level) so it runs within the vitest runner context.
beforeAll(async () => {
  await import("../mcp/orchestration-server");
});

function callTool(name: string, args: Record<string, unknown>) {
  const handler = handlers.get(CallToolRequestSchema);
  if (!handler) throw new Error("CallToolRequestSchema handler not registered");
  return handler({ params: { name, arguments: args } });
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
});
