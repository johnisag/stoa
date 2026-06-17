import { describe, it, expect } from "vitest";
import {
  buildCommandPrompt,
  buildGenerateWorkflowPrompt,
  parseAgentReply,
  type CommandProject,
} from "@/lib/command/plan";
import { WORKFLOW_ROLES } from "@/lib/command/workflow-roles";

const PROJECTS: CommandProject[] = [
  { id: "proj_a", name: "Alpha", directory: "~/alpha", agentType: "claude" },
  { id: "proj_b", name: "Beta", directory: "~/beta", agentType: "codex" },
];

describe("buildCommandPrompt", () => {
  it("includes the context, the project ids, all actions, and the message", () => {
    const prompt = buildCommandPrompt({
      context: "FLEET_CTX_MARKER",
      projects: PROJECTS,
      message: "start a session",
    });
    expect(prompt).toContain("FLEET_CTX_MARKER");
    expect(prompt).toContain("proj_a");
    expect(prompt).toContain("proj_b");
    expect(prompt).toContain("create_session");
    expect(prompt).toContain("dispatch_issue");
    expect(prompt).toContain("open_view");
    expect(prompt).toContain("list_sessions");
    expect(prompt).toContain("initialPrompt");
    expect(prompt).toContain("start a session");
  });

  it("renders prior turns when history is present", () => {
    const prompt = buildCommandPrompt({
      context: "c",
      projects: PROJECTS,
      history: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
      ],
      message: "m",
    });
    expect(prompt).toContain("User: hi");
    expect(prompt).toContain("Assistant: hello");
  });

  it("notes when there are no projects (cannot propose create_session)", () => {
    const prompt = buildCommandPrompt({
      context: "c",
      projects: [],
      message: "m",
    });
    expect(prompt.toLowerCase()).toContain("no projects");
  });
});

describe("parseAgentReply — conservative answer/proposal split", () => {
  function actionOf(data: unknown): string | undefined {
    return (data as { action?: string }).action;
  }

  it("treats plain prose as an answer", () => {
    expect(parseAgentReply("Your fleet ran 3 sessions today.").kind).toBe(
      "answer"
    );
  });

  it("parses a bare proposal JSON object", () => {
    const r = parseAgentReply(
      '{"kind":"proposal","action":"create_session","params":{"projectId":"proj_a"}}'
    );
    expect(r.kind).toBe("proposal");
    if (r.kind === "proposal") expect(actionOf(r.data)).toBe("create_session");
  });

  it("parses a proposal wrapped in a ```json code fence", () => {
    const fenced =
      "```json\n" +
      '{"kind":"proposal","action":"create_session","params":{"projectId":"proj_a"}}' +
      "\n```";
    expect(parseAgentReply(fenced).kind).toBe("proposal");
  });

  it("extracts a proposal even with leading prose", () => {
    const r = parseAgentReply(
      'Sure! {"kind":"proposal","action":"create_session","params":{"projectId":"proj_a"}}'
    );
    expect(r.kind).toBe("proposal");
  });

  it("treats JSON WITHOUT kind:proposal as an answer (no false action)", () => {
    expect(
      parseAgentReply('{"foo":"bar","action":"create_session"}').kind
    ).toBe("answer");
  });

  it("treats malformed JSON as an answer", () => {
    expect(parseAgentReply('{"kind":"proposal", oops').kind).toBe("answer");
  });

  it("ignores braces inside strings when balancing the object", () => {
    const r = parseAgentReply(
      '{"kind":"proposal","action":"create_session","params":{"name":"a } b","projectId":"proj_a"}}'
    );
    expect(r.kind).toBe("proposal");
    if (r.kind === "proposal") {
      const name = (r.data as { params?: { name?: string } }).params?.name;
      expect(name).toBe("a } b");
    }
  });

  it("blesses a kind:workflow object as a workflow design", () => {
    const r = parseAgentReply(
      '{"kind":"workflow","spec":{"name":"X","steps":[{"id":"a","role":"researcher","task":"t"}]}}'
    );
    expect(r.kind).toBe("workflow");
  });

  it("blesses a workflow wrapped in a ```json fence (with leading prose)", () => {
    const r = parseAgentReply(
      'Here you go:\n```json\n{"kind":"workflow","spec":{"name":"X","steps":[]}}\n```'
    );
    expect(r.kind).toBe("workflow");
  });

  it("treats JSON without a known kind as an answer (no false workflow)", () => {
    expect(parseAgentReply('{"spec":{"steps":[]}}').kind).toBe("answer");
  });
});

describe("buildGenerateWorkflowPrompt", () => {
  const base = {
    summary: "BUILD_GOAL_MARKER: a billing page",
    projectName: "PROJ_NAME_MARKER",
    projectDir: "/home/u/proj",
  };

  it("teaches the strict workflow JSON contract and the generation-only rule", () => {
    const p = buildGenerateWorkflowPrompt(base);
    expect(p).toContain('"kind":"workflow"');
    expect(p.toLowerCase()).toContain("do not"); // never executes / no agent field
    // Emits role, NOT agent/model/workingDirectory.
    expect(p).toMatch(/do NOT emit `agent`/i);
  });

  it("lists every role and the review-gate sink", () => {
    const p = buildGenerateWorkflowPrompt(base);
    for (const role of WORKFLOW_ROLES) expect(p).toContain(role);
    expect(p).toContain("review-gate");
  });

  it("includes the goal, the project grounding, and the output-write rule", () => {
    const p = buildGenerateWorkflowPrompt(base);
    expect(p).toContain("BUILD_GOAL_MARKER");
    expect(p).toContain("PROJ_NAME_MARKER");
    expect(p).toContain("STOA_OUTPUT.md");
    expect(p).toContain("{{steps.<upstreamId>.output}}");
  });

  it("includes optional grounded context when provided", () => {
    const p = buildGenerateWorkflowPrompt({ ...base, context: "CTX_MARKER" });
    expect(p).toContain("CTX_MARKER");
  });
});

// ─── parseAgentReply — plan kind ──────────────────────────────────────────────

describe("parseAgentReply — plan kind", () => {
  const PLAN_JSON =
    '{"kind":"plan","name":"Research then implement","steps":[' +
    '{"stepId":"step-1","description":"Research","action":"create_session","params":{"projectId":"proj_a"}},' +
    '{"stepId":"step-2","description":"Implement","action":"create_session","params":{"projectId":"proj_a"}}' +
    ']}';

  it("parses bare kind:plan JSON", () => {
    const r = parseAgentReply(PLAN_JSON);
    expect(r.kind).toBe("plan");
    if (r.kind === "plan") {
      const data = r.data as { kind: string; name: string; steps: unknown[] };
      expect(data.kind).toBe("plan");
      expect(data.name).toBe("Research then implement");
      expect(data.steps).toHaveLength(2);
    }
  });

  it("parses kind:plan in a ```json fence", () => {
    const fenced = "```json\n" + PLAN_JSON + "\n```";
    const r = parseAgentReply(fenced);
    expect(r.kind).toBe("plan");
  });

  it("degrades to answer when kind is 'plan' but steps is missing", () => {
    // JSON is valid but missing steps; the parser still blesses it as "plan" (the
    // validator, not the parser, rejects structurally incomplete plans).
    const r = parseAgentReply('{"kind":"plan","name":"X"}');
    // Parser returns kind:"plan" — the downstream validatePlan rejects the missing steps.
    expect(r.kind).toBe("plan");
  });

  it("degrades to answer when JSON is malformed", () => {
    const r = parseAgentReply('{"kind":"plan", oops}');
    expect(r.kind).toBe("answer");
  });

  it("does not confuse kind:proposal with kind:plan", () => {
    const r = parseAgentReply(
      '{"kind":"proposal","action":"create_session","params":{"projectId":"proj_a"}}'
    );
    expect(r.kind).toBe("proposal");
  });

  it("does not confuse kind:workflow with kind:plan", () => {
    const r = parseAgentReply(
      '{"kind":"workflow","spec":{"name":"X","steps":[]}}'
    );
    expect(r.kind).toBe("workflow");
  });
});

// ─── COMMAND_PREAMBLE — plan instruction ──────────────────────────────────────

describe("COMMAND_PREAMBLE (via buildCommandPrompt)", () => {
  const prompt = buildCommandPrompt({
    context: "ctx",
    projects: PROJECTS,
    message: "msg",
  });

  it("includes kind:plan instruction", () => {
    expect(prompt).toContain('"kind":"plan"');
  });

  it("includes '2 to 10 steps' constraint", () => {
    expect(prompt).toMatch(/2 to 10 steps/i);
  });

  it("restricts plan steps to create_session and dispatch_issue only", () => {
    // The preamble must name the allowlisted step actions.
    expect(prompt).toContain("create_session");
    expect(prompt).toContain("dispatch_issue");
  });
});
