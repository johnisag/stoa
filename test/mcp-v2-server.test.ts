import { afterEach, describe, expect, it, vi } from "vitest";
import {
  InMemoryTransport,
  type JSONRPCMessage,
} from "@modelcontextprotocol/server";
import { serveOrchestrationStdio } from "@/mcp/orchestration-server";

describe("MCP SDK v2 orchestration server", () => {
  const connected: Array<{ close(): Promise<void> }> = [];

  afterEach(async () => {
    await Promise.all(connected.splice(0).map((item) => item.close()));
  });

  function responseCollector() {
    const responses = new Map<string | number, JSONRPCMessage>();
    return {
      responses,
      onmessage(message: JSONRPCMessage) {
        if ("id" in message && message.id != null)
          responses.set(message.id, message);
      },
    };
  }

  async function waitForResponse(
    responses: Map<string | number, JSONRPCMessage>,
    id: string | number
  ) {
    await vi.waitFor(() => expect(responses.has(id)).toBe(true));
    return responses.get(id);
  }

  it("serves a native 2026-07-28 request without legacy initialization", async () => {
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const handle = serveOrchestrationStdio({ transport: serverTransport });
    connected.push(clientTransport, handle);
    const collector = responseCollector();
    clientTransport.onmessage = collector.onmessage;
    await clientTransport.start();
    const modernMeta = {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientInfo": {
        name: "stoa-modern-test",
        version: "1.0.0",
      },
      "io.modelcontextprotocol/clientCapabilities": {},
    };

    await clientTransport.send({
      jsonrpc: "2.0",
      id: 1,
      method: "server/discover",
      params: {
        _meta: modernMeta,
      },
    });
    expect(await waitForResponse(collector.responses, 1)).toMatchObject({
      result: {
        resultType: "complete",
        supportedVersions: expect.arrayContaining(["2026-07-28"]),
        capabilities: { tools: {} },
      },
    });

    await clientTransport.send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {
        _meta: modernMeta,
      },
    });

    expect(await waitForResponse(collector.responses, 2)).toMatchObject({
      result: {
        resultType: "complete",
        tools: expect.arrayContaining([
          expect.objectContaining({ name: "fleet_get_capabilities" }),
          expect.objectContaining({ name: "fleet_supervisor_snapshot" }),
          expect.objectContaining({ name: "fleet_request_action" }),
        ]),
      },
    });

    await clientTransport.send({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "fleet_create_run",
        arguments: {},
        _meta: modernMeta,
      },
    });
    expect(await waitForResponse(collector.responses, 3)).toMatchObject({
      result: {
        resultType: "complete",
        content: [
          expect.objectContaining({
            text: expect.stringContaining("capabilityToken is required"),
          }),
        ],
      },
    });

    await clientTransport.send({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/list",
      params: {},
    });
    expect(await waitForResponse(collector.responses, 4)).toMatchObject({
      error: {
        code: -32602,
        message: expect.stringContaining("_meta envelope"),
      },
    });
  });

  it("negotiates a legacy client through Stoa's v2 stdio entry", async () => {
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const handle = serveOrchestrationStdio({ transport: serverTransport });
    connected.push(clientTransport, handle);
    const collector = responseCollector();
    clientTransport.onmessage = collector.onmessage;
    await clientTransport.start();

    await clientTransport.send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "stoa-test", version: "1.0.0" },
      },
    });
    expect(await waitForResponse(collector.responses, 1)).toMatchObject({
      result: {
        serverInfo: { name: "stoa-orchestration", version: "2.0.0" },
      },
    });

    await clientTransport.send({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
    await clientTransport.send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    });
    const listed = (await waitForResponse(collector.responses, 2)) as {
      result?: { tools?: Array<{ name?: string }> };
    };
    const names = listed.result?.tools?.map((tool) => tool.name) ?? [];
    expect(names).toContain("fleet_request_action");
    expect(names).toContain("fleet_get_capabilities");
    expect(names).toContain("fleet_list_runs");
    expect(names).toContain("fleet_get_run");
    expect(names).toContain("fleet_supervisor_snapshot");
    expect(names).toContain("fleet_create_run");
    expect(names).toContain("fleet_plan_run");
    expect(names).toContain("fleet_approve_run");
    expect(names).toContain("fleet_merge_run");
    expect(names).not.toContain("fleet_tick_run");
    expect(names).not.toContain("fleet_cleanup_run");
  });
});
