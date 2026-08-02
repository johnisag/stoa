import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import path from "path";
import type { AgentType } from "@/lib/providers";
import type { Session } from "@/lib/db";

const state = vi.hoisted(() => ({
  projectDirectory: "",
  session: undefined as Record<string, unknown> | undefined,
  sessions: new Map<string, Record<string, unknown>>(),
  persistedMcpArgs: [] as Array<{ json: string; id: string }>,
}));

const hermes = vi.hoisted(() => ({
  register: vi.fn(),
}));

vi.mock("@/lib/db", () => {
  const fakeDb = {};
  return {
    db: fakeDb,
    getDb: () => fakeDb,
    queries: {
      createSession: () => ({
        run: (
          id: string,
          name: string,
          tmuxName: string | null,
          workingDirectory: string,
          parentSessionId: string | null,
          model: string | null,
          systemPrompt: string | null,
          groupPath: string,
          agentType: AgentType,
          autoApprove: number,
          projectId: string
        ) => {
          const session = {
            id,
            name,
            tmux_name: tmuxName,
            working_directory: workingDirectory,
            parent_session_id: parentSessionId,
            claude_session_id: null,
            model,
            system_prompt: systemPrompt,
            group_path: groupPath,
            project_id: projectId,
            agent_type: agentType,
            auto_approve: Boolean(autoApprove),
            conductor_session_id: null,
            worker_task: null,
            worker_status: null,
            mcp_launch_args: null,
          };
          state.session = session;
          state.sessions.set(id, session);
        },
      }),
      getSession: () => ({
        get: (id: string) => state.sessions.get(id),
      }),
      deleteSession: () => ({
        run: (id: string) => {
          state.sessions.delete(id);
          if (state.session?.id === id) state.session = undefined;
        },
      }),
      updateSessionMcpArgs: () => ({
        run: (json: string, id: string) => {
          state.persistedMcpArgs.push({ json, id });
          const session = state.sessions.get(id);
          if (session) session.mcp_launch_args = json;
        },
      }),
    },
  };
});

vi.mock("@/lib/projects", () => ({
  getProject: (id: string) =>
    id === "mcp-test-project"
      ? {
          id,
          name: "MCP test",
          working_directory: state.projectDirectory,
          default_model: "",
          initial_prompt: null,
        }
      : null,
}));

vi.mock("@/lib/playbooks-server", () => ({
  resolvePlaybookParts: () => ({ pinnedKnowledge: "", playbook: "" }),
}));

vi.mock("@/lib/mcp-config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/mcp-config")>();
  return {
    ...actual,
    ensureHermesMcpRegistered: hermes.register,
  };
});

import { POST as createSession } from "@/app/api/sessions/route";
import { POST as repairMcpConfig } from "@/app/api/sessions/[id]/mcp-config/route";
import { sessionLaunchEnv } from "@/lib/session-launch";

function request(body: Record<string, unknown>): Request {
  return new Request("http://localhost/api/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function routeContext(id: string) {
  return { params: Promise.resolve({ id }) };
}

function setSession(
  id: string,
  agentType: AgentType,
  workingDirectory: string
): void {
  state.session = {
    id,
    name: `${agentType} session`,
    working_directory: workingDirectory,
    agent_type: agentType,
    mcp_launch_args: null,
  };
  state.sessions.set(id, state.session);
}

async function createConductor(agentType: AgentType, workingDirectory: string) {
  state.projectDirectory = workingDirectory;
  state.session = undefined;
  const response = await createSession(
    request({
      name: `${agentType} conductor`,
      workingDirectory,
      projectId: "mcp-test-project",
      agentType,
      enableOrchestration: true,
      useTmux: false,
    }) as never
  );
  return {
    response,
    body: (await response.json()) as {
      session?: { id: string; mcp_launch_args?: string | null };
      error?: string;
    },
  };
}

describe("session routes use provider-native orchestration wiring", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "stoa-mcp-routes-"));
    state.projectDirectory = dir;
    state.session = undefined;
    state.sessions.clear();
    state.persistedMcpArgs = [];
    hermes.register.mockReset();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("session creation writes generic Kilo and Kimi configs plus conductor sentinels", async () => {
    const kiloDir = path.join(dir, "kilo-project");
    const kimiDir = path.join(dir, "kimi-project");
    mkdirSync(kiloDir);
    mkdirSync(kimiDir);

    const kilo = await createConductor("kilo", kiloDir);
    expect(kilo.response.status).toBe(201);
    const kiloConfig = JSON.parse(
      readFileSync(path.join(kiloDir, ".kilo", "kilo.json"), "utf-8")
    );
    expect(kiloConfig.mcp.stoa.environment.CONDUCTOR_SESSION_ID).toBe(
      "{env:STOA_CONDUCTOR_SESSION_ID}"
    );
    expect(kiloConfig.mcp.stoa.type).toBe("local");
    expect(kilo.body.session?.mcp_launch_args).toBe("[]");

    const kimi = await createConductor("kimi", kimiDir);
    expect(kimi.response.status).toBe(201);
    const kimiConfig = JSON.parse(
      readFileSync(path.join(kimiDir, ".kimi-code", "mcp.json"), "utf-8")
    );
    expect(kimiConfig.mcpServers.stoa.env.CONDUCTOR_SESSION_ID).toBe(
      "${STOA_CONDUCTOR_SESSION_ID}"
    );
    expect(kimiConfig.mcpServers.stoa.command).toEqual(expect.any(String));
    expect(kimi.body.session?.mcp_launch_args).toBe("[]");
  });

  it("keeps Claude, Codex, and Hermes session-create strategies intact", async () => {
    const claudeDir = path.join(dir, "claude-project");
    const codexDir = path.join(dir, "codex-project");
    const hermesDir = path.join(dir, "hermes-project");
    mkdirSync(claudeDir);
    mkdirSync(codexDir);
    mkdirSync(hermesDir);

    const claude = await createConductor("claude", claudeDir);
    expect(claude.response.status).toBe(201);
    const claudeConfig = JSON.parse(
      readFileSync(path.join(claudeDir, ".mcp.json"), "utf-8")
    );
    expect(claudeConfig.mcpServers.stoa.env.CONDUCTOR_SESSION_ID).toBe(
      "${STOA_CONDUCTOR_SESSION_ID}"
    );
    expect(claude.body.session?.mcp_launch_args).toBe("[]");

    const codex = await createConductor("codex", codexDir);
    expect(codex.response.status).toBe(201);
    const codexPersisted = state.persistedMcpArgs.find(
      (entry) => entry.id === codex.body.session?.id
    )!;
    expect(JSON.parse(codexPersisted.json).join(" ")).toContain(
      "mcp_servers.stoa"
    );
    expect(existsSync(path.join(codexDir, ".mcp.json"))).toBe(false);

    const hermesResult = await createConductor("hermes", hermesDir);
    expect(hermesResult.response.status).toBe(201);
    expect(hermes.register).toHaveBeenCalledTimes(1);
    expect(hermesResult.body.session?.mcp_launch_args).toBe("[]");
    expect(existsSync(path.join(hermesDir, ".mcp.json"))).toBe(false);
  });

  it("allows two conductors to share a cwd without baking either identity", async () => {
    const cases: Array<{
      agent: "claude" | "kilo" | "kimi";
      relativeConfig: string;
    }> = [
      { agent: "claude", relativeConfig: ".mcp.json" },
      { agent: "kilo", relativeConfig: path.join(".kilo", "kilo.json") },
      {
        agent: "kimi",
        relativeConfig: path.join(".kimi-code", "mcp.json"),
      },
    ];

    for (const testCase of cases) {
      const shared = path.join(dir, `shared-${testCase.agent}`);
      mkdirSync(shared);
      const first = await createConductor(testCase.agent, shared);
      expect(first.response.status).toBe(201);
      const configPath = path.join(shared, testCase.relativeConfig);
      const configAfterFirst = readFileSync(configPath, "utf-8");

      const second = await createConductor(testCase.agent, shared);
      expect(second.response.status).toBe(201);
      expect(second.body.session?.id).not.toBe(first.body.session?.id);
      expect(readFileSync(configPath, "utf-8")).toBe(configAfterFirst);
      expect(first.body.session?.mcp_launch_args).toBe("[]");
      expect(second.body.session?.mcp_launch_args).toBe("[]");
      expect(
        sessionLaunchEnv(
          state.sessions.get(first.body.session!.id) as unknown as Session
        )
      ).toEqual({ STOA_CONDUCTOR_SESSION_ID: first.body.session?.id });
      expect(
        sessionLaunchEnv(
          state.sessions.get(second.body.session!.id) as unknown as Session
        )
      ).toEqual({ STOA_CONDUCTOR_SESSION_ID: second.body.session?.id });
    }

    const hermesDir = path.join(dir, "shared-hermes");
    mkdirSync(hermesDir);
    const firstHermes = await createConductor("hermes", hermesDir);
    const secondHermes = await createConductor("hermes", hermesDir);
    expect(firstHermes.response.status).toBe(201);
    expect(secondHermes.response.status).toBe(201);
    expect(secondHermes.body.session?.id).not.toBe(
      firstHermes.body.session?.id
    );
    expect(firstHermes.body.session?.mcp_launch_args).toBe("[]");
    expect(secondHermes.body.session?.mcp_launch_args).toBe("[]");
    expect(
      sessionLaunchEnv(
        state.sessions.get(firstHermes.body.session!.id) as unknown as Session
      )
    ).toEqual({ STOA_CONDUCTOR_SESSION_ID: firstHermes.body.session?.id });
    expect(
      sessionLaunchEnv(
        state.sessions.get(secondHermes.body.session!.id) as unknown as Session
      )
    ).toEqual({ STOA_CONDUCTOR_SESSION_ID: secondHermes.body.session?.id });
    expect(existsSync(path.join(hermesDir, ".stoa-conductor"))).toBe(false);
  });

  it("the repair endpoint dispatches every provider strategy and fails closed for shell", async () => {
    const kiloDir = path.join(dir, "repair-kilo");
    const kimiDir = path.join(dir, "repair-kimi");
    const claudeDir = path.join(dir, "repair-claude");
    const codexDir = path.join(dir, "repair-codex");
    const hermesDir = path.join(dir, "repair-hermes");
    const shellDir = path.join(dir, "repair-shell");
    mkdirSync(kiloDir);
    mkdirSync(kimiDir);
    mkdirSync(claudeDir);
    mkdirSync(codexDir);
    mkdirSync(hermesDir);
    mkdirSync(shellDir);

    setSession("kilo-id", "kilo", kiloDir);
    expect(
      (await repairMcpConfig(request({}) as never, routeContext("kilo-id")))
        .status
    ).toBe(200);
    expect(
      JSON.parse(
        readFileSync(path.join(kiloDir, ".kilo", "kilo.json"), "utf-8")
      ).mcp.stoa.environment.CONDUCTOR_SESSION_ID
    ).toBe("{env:STOA_CONDUCTOR_SESSION_ID}");
    expect(state.sessions.get("kilo-id")?.mcp_launch_args).toBe("[]");

    setSession("kimi-id", "kimi", kimiDir);
    expect(
      (await repairMcpConfig(request({}) as never, routeContext("kimi-id")))
        .status
    ).toBe(200);
    expect(
      JSON.parse(
        readFileSync(path.join(kimiDir, ".kimi-code", "mcp.json"), "utf-8")
      ).mcpServers.stoa.env.CONDUCTOR_SESSION_ID
    ).toBe("${STOA_CONDUCTOR_SESSION_ID}");
    expect(state.sessions.get("kimi-id")?.mcp_launch_args).toBe("[]");

    setSession("claude-id", "claude", claudeDir);
    expect(
      (await repairMcpConfig(request({}) as never, routeContext("claude-id")))
        .status
    ).toBe(200);
    expect(
      JSON.parse(readFileSync(path.join(claudeDir, ".mcp.json"), "utf-8"))
        .mcpServers.stoa.env.CONDUCTOR_SESSION_ID
    ).toBe("${STOA_CONDUCTOR_SESSION_ID}");
    expect(state.sessions.get("claude-id")?.mcp_launch_args).toBe("[]");

    setSession("codex-id", "codex", codexDir);
    expect(
      (await repairMcpConfig(request({}) as never, routeContext("codex-id")))
        .status
    ).toBe(200);
    expect(
      JSON.parse(
        state.persistedMcpArgs.find((entry) => entry.id === "codex-id")!.json
      ).join(" ")
    ).toContain("mcp_servers.stoa");
    expect(existsSync(path.join(codexDir, ".mcp.json"))).toBe(false);

    setSession("hermes-id", "hermes", hermesDir);
    expect(
      (await repairMcpConfig(request({}) as never, routeContext("hermes-id")))
        .status
    ).toBe(200);
    expect(hermes.register).toHaveBeenCalledTimes(1);
    expect(state.sessions.get("hermes-id")?.mcp_launch_args).toBe("[]");

    setSession("shell-id", "shell", shellDir);
    const shell = await repairMcpConfig(
      request({}) as never,
      routeContext("shell-id")
    );
    expect(shell.status).toBe(400);
    expect(await shell.json()).toEqual({
      error: "Provider shell does not support orchestration",
    });
    expect(existsSync(path.join(shellDir, ".mcp.json"))).toBe(false);
  });

  it("the repair endpoint preserves malformed provider config and returns 409", async () => {
    const configDir = path.join(dir, ".kimi-code");
    const configPath = path.join(configDir, "mcp.json");
    const malformed = '{ "mcpServers": [] }';
    mkdirSync(configDir);
    writeFileSync(configPath, malformed);
    setSession("kimi-malformed", "kimi", dir);
    const response = await repairMcpConfig(
      request({}) as never,
      routeContext("kimi-malformed")
    );
    expect(response.status).toBe(409);
    expect(readFileSync(configPath, "utf-8")).toBe(malformed);
  });

  it("adopts legacy Claude config only for a durable conductor in the same directory", async () => {
    const legacyId = "11111111-1111-4111-8111-111111111111";
    const targetId = "22222222-2222-4222-8222-222222222222";
    const configPath = path.join(dir, ".mcp.json");
    const original = JSON.stringify({
      mcpServers: {
        stoa: {
          command: "npx",
          args: [
            "tsx",
            path.join(process.cwd(), "mcp", "orchestration-server.ts"),
          ],
          env: {
            STOA_URL: "http://localhost:3011",
            CONDUCTOR_SESSION_ID: legacyId,
          },
        },
      },
    });
    writeFileSync(configPath, original);
    setSession(legacyId, "claude", dir);
    setSession(targetId, "claude", dir);

    const unowned = await repairMcpConfig(
      request({}) as never,
      routeContext(targetId)
    );
    expect(unowned.status).toBe(409);
    expect(readFileSync(configPath, "utf-8")).toBe(original);

    state.sessions.get(legacyId)!.mcp_launch_args = "[]";
    const owned = await repairMcpConfig(
      request({}) as never,
      routeContext(targetId)
    );
    expect(owned.status).toBe(200);
    expect(
      JSON.parse(readFileSync(configPath, "utf-8")).mcpServers.stoa.env
        .STOA_MCP_CONFIG_OWNER
    ).toBe("stoa-managed-v1");
  });

  it("session creation preserves malformed Claude config and rolls back the session", async () => {
    const configPath = path.join(dir, ".mcp.json");
    const malformed = "{ definitely-not-json";
    writeFileSync(configPath, malformed);

    const result = await createConductor("claude", dir);
    expect(result.response.status).toBe(409);
    expect(result.body.error).toMatch(/Cannot update Claude MCP config/);
    expect(readFileSync(configPath, "utf-8")).toBe(malformed);
    expect(state.sessions.size).toBe(0);
  });
});
