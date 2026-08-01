import { afterEach, describe, expect, it } from "vitest";
import {
  InMemoryTransport,
  type JSONRPCMessage,
} from "@modelcontextprotocol/server";
import { createOrchestrationServer } from "@/mcp/orchestration-server";

describe("MCP SDK v2 orchestration server", () => {
  const connected: Array<{ close(): Promise<void> }> = [];

  afterEach(async () => {
    await Promise.all(connected.splice(0).map((item) => item.close()));
  });

  it("negotiates a legacy client through the v2 server and advertises Fleet tools", async () => {
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const server = createOrchestrationServer();
    connected.push(clientTransport, serverTransport, server);
    const responses = new Map<string | number, JSONRPCMessage>();
    clientTransport.onmessage = (message) => {
      if ("id" in message && message.id != null)
        responses.set(message.id, message);
    };
    await clientTransport.start();
    await server.connect(serverTransport);

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
    await new Promise((resolveWait) => setTimeout(resolveWait, 0));
    expect(responses.get(1)).toMatchObject({
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
    await new Promise((resolveWait) => setTimeout(resolveWait, 0));
    const listed = responses.get(2) as {
      result?: { tools?: Array<{ name?: string }> };
    };
    const names = listed.result?.tools?.map((tool) => tool.name) ?? [];
    expect(names).toContain("fleet_request_action");
    expect(names).not.toContain("fleet_create_run");
    expect(names).not.toContain("fleet_plan_run");
    expect(names).not.toContain("fleet_approve_run");
    expect(names).not.toContain("fleet_tick_run");
    expect(names).not.toContain("fleet_cleanup_run");
  });
});
