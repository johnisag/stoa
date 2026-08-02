import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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

  it("pins the split v2 server package without the monolithic v1 SDK", () => {
    const packageJson = JSON.parse(
      readFileSync(join(process.cwd(), "package.json"), "utf8")
    ) as { dependencies?: Record<string, string> };
    const lockfile = JSON.parse(
      readFileSync(join(process.cwd(), "package-lock.json"), "utf8")
    ) as { packages?: Record<string, { version?: string }> };

    expect(packageJson.dependencies?.["@modelcontextprotocol/server"]).toMatch(
      /^2\./
    );
    expect(packageJson.dependencies).not.toHaveProperty(
      "@modelcontextprotocol/sdk"
    );
    expect(
      lockfile.packages?.["node_modules/@modelcontextprotocol/server"]?.version
    ).toMatch(/^2\./);
    expect(lockfile.packages).not.toHaveProperty(
      "node_modules/@modelcontextprotocol/sdk"
    );
  });

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
    const discovery = (await waitForResponse(collector.responses, 1)) as {
      result?: { capabilities?: Record<string, unknown> };
    };
    expect(discovery.result?.capabilities).not.toHaveProperty("tasks");
    expect(discovery.result?.capabilities).not.toHaveProperty("resources");
    expect(discovery.result?.capabilities).not.toHaveProperty("prompts");

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
        isError: true,
        content: [
          expect.objectContaining({
            text: expect.stringContaining("capabilityToken is required"),
          }),
        ],
      },
    });

    await clientTransport.send({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: {
        name: "not_a_stoa_tool",
        arguments: {},
        _meta: modernMeta,
      },
    });
    expect(await waitForResponse(collector.responses, 5)).toMatchObject({
      error: {
        code: -32602,
        message: expect.stringContaining("Unknown tool"),
      },
    });

    await clientTransport.send({
      jsonrpc: "2.0",
      id: 6,
      method: "tasks/get",
      params: { taskId: "unsupported", _meta: modernMeta },
    });
    expect(await waitForResponse(collector.responses, 6)).toMatchObject({
      error: { code: -32601 },
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
        protocolVersion: "2025-11-25",
        serverInfo: { name: "stoa-orchestration", version: "2.0.0" },
        capabilities: { tools: {} },
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
