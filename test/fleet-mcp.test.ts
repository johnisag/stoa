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
  it("reports the modern protocol boundary without advertising draft/deprecated extensions", async () => {
    const result = await handleToolCall({
      params: { name: "fleet_get_capabilities", arguments: {} },
    });
    const capabilities = JSON.parse(text(result));

    expect(capabilities).toMatchObject({
      sdk: { package: "@modelcontextprotocol/server", major: 2 },
      protocol: { preferred: "2026-07-28", legacyFallback: true },
      fleetState: { authority: "stoa-sqlite" },
      extensions: {
        tasks: { advertised: false },
        subscriptions: { advertised: false },
        sampling: { advertised: false },
      },
    });
    expect(capabilities.tools.capabilityReads).toContain(
      "fleet_supervisor_snapshot"
    );
  });

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

  it("rejects a direct Fleet mutation without a scoped capability", async () => {
    const fetchMock = vi.fn<FetchMock>();
    vi.stubGlobal("fetch", fetchMock);
    const result = await handleToolCall({
      params: { name: "fleet_create_run", arguments: { goal: "unsafe" } },
    });
    expect(text(result)).toContain("capabilityToken is required");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("routes Fleet reads through an exact reusable read capability", async () => {
    const fetchMock = vi.fn<FetchMock>(async () =>
      response({ result: { runs: [{ id: "run-1", status: "running" }] } })
    );
    vi.stubGlobal("fetch", fetchMock);
    const token = `stoa_fleet_v1_${"R".repeat(43)}`;
    const result = await handleToolCall({
      params: {
        name: "fleet_list_runs",
        arguments: { capabilityToken: token },
      },
    });
    expect(JSON.parse(text(result))).toMatchObject({
      runs: [{ id: "run-1" }],
    });
    expect(fetchMock.mock.calls[0]?.[0]).toContain(
      "/api/fleet/capabilities/action"
    );
    expect(
      JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))
    ).toMatchObject({
      token,
      scope: {
        action: "fleet:read",
        runId: "*",
        taskId: null,
        workerId: null,
        attempt: null,
        boundHash: null,
      },
      payload: { resource: "runs" },
    });
    expect(text(result)).not.toContain(token);
  });

  it("does not expose Fleet snapshots without a read capability", async () => {
    const fetchMock = vi.fn<FetchMock>();
    vi.stubGlobal("fetch", fetchMock);
    const result = await handleToolCall({
      params: { name: "fleet_get_run", arguments: { runId: "run-1" } },
    });
    expect(text(result)).toContain("capabilityToken is required");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("routes a bounded supervisor snapshot through an exact-run read capability", async () => {
    const snapshotHash = "a".repeat(64);
    const fetchMock = vi.fn<FetchMock>(async () =>
      response({
        result: {
          runId: "run-1",
          snapshot: { advisoryOnly: true, snapshotHash, recommendations: [] },
        },
      })
    );
    vi.stubGlobal("fetch", fetchMock);
    const token = `stoa_fleet_v1_${"S".repeat(43)}`;

    const result = await handleToolCall({
      params: {
        name: "fleet_supervisor_snapshot",
        arguments: { capabilityToken: token, runId: "run-1" },
      },
    });

    expect(JSON.parse(text(result))).toMatchObject({
      runId: "run-1",
      snapshot: { advisoryOnly: true, snapshotHash },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toContain(
      "/api/fleet/capabilities/action"
    );
    expect(
      JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))
    ).toMatchObject({
      token,
      scope: {
        version: 1,
        action: "fleet:read",
        runId: "run-1",
        taskId: null,
        workerId: null,
        attempt: null,
        boundHash: null,
      },
      payload: { resource: "supervisor" },
    });
    expect(text(result)).not.toContain(token);
  });

  it("routes an exact capability mutation through only the action boundary", async () => {
    const fetchMock = vi.fn<FetchMock>(async () =>
      response({ result: { run: { id: "run-1" } } })
    );
    vi.stubGlobal("fetch", fetchMock);
    const token = `stoa_fleet_v1_${"A".repeat(43)}`;
    const result = await handleToolCall({
      params: {
        name: "fleet_approve_run",
        arguments: {
          capabilityToken: token,
          runId: "run-1",
          boundHashKind: "plan",
          boundHashValue: "a".repeat(64),
        },
      },
    });
    expect(JSON.parse(text(result))).toMatchObject({ run: { id: "run-1" } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toContain(
      "/api/fleet/capabilities/action"
    );
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body).toMatchObject({
      token,
      scope: {
        version: 1,
        action: "fleet:approve",
        runId: "run-1",
        taskId: null,
        workerId: null,
        attempt: null,
        boundHash: { kind: "plan", value: "a".repeat(64) },
      },
    });
    expect(text(result)).not.toContain(token);
  });

  it("keeps scheduler, worker-kill, and cleanup operations unexposed", async () => {
    const fetchMock = vi.fn<FetchMock>();
    vi.stubGlobal("fetch", fetchMock);
    for (const name of [
      "fleet_tick_run",
      "fleet_cleanup_run",
      "fleet_kill_worker",
    ]) {
      const result = await handleToolCall({ params: { name, arguments: {} } });
      expect(text(result)).toContain("not exposed through MCP");
    }
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
