import { afterEach, describe, expect, it, vi } from "vitest";
import { handleToolCall } from "@/mcp/orchestration-tools";

function response(body: unknown) {
  return { json: async () => body } as Response;
}

type FetchMock = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>;

function text(result: Awaited<ReturnType<typeof handleToolCall>>) {
  return result.content[0]?.text ?? "";
}

afterEach(() => vi.unstubAllGlobals());

describe("Fleet MCP tools", () => {
  it("queues an operator request without calling a Fleet endpoint", async () => {
    const fetchMock = vi.fn<FetchMock>(async () =>
      response({ elicitationId: "request-1" })
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await handleToolCall({
      params: {
        name: "fleet_request_action",
        arguments: {
          conductorId: "session-1",
          runId: "run-1",
          action: "approve",
          expectedPlanHash: "abc",
        },
      },
    });

    expect(text(result)).toContain("No Fleet state was changed");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toContain("/api/mcp/elicit");
    expect(fetchMock.mock.calls[0]?.[0]).not.toContain("/api/fleet/");
    expect(
      JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)).message
    ).toContain("accepting this form does not execute it");
  });

  it("rejects direct Fleet calls even when invoked without discovery", async () => {
    const fetchMock = vi.fn<FetchMock>();
    vi.stubGlobal("fetch", fetchMock);
    const result = await handleToolCall({
      params: { name: "fleet_create_run", arguments: { goal: "unsafe" } },
    });
    expect(text(result)).toContain("direct Fleet access is not exposed");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects unsupported request actions before creating elicitation", async () => {
    const fetchMock = vi.fn<FetchMock>();
    vi.stubGlobal("fetch", fetchMock);
    const result = await handleToolCall({
      params: {
        name: "fleet_request_action",
        arguments: {
          conductorId: "session-1",
          runId: "run-1",
          action: "delete_worktrees",
        },
      },
    });
    expect(text(result)).toContain("unsupported Fleet action");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
