import { describe, it, expect, vi } from "vitest";

// Pin resolveBinary to null so buildAskArgs falls back to the BARE name, making
// the argv assertions deterministic and identical on every OS (the real
// resolveBinary would otherwise return an absolute .cmd path on Windows). isWindows
// is left as the real value — buildAskArgs/buildAskPrompt don't read it, and the
// route's spawn (which does) is not exercised here. We never spawn a real agent.
vi.mock("@/lib/platform", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/platform")>();
  return { ...actual, resolveBinary: () => null };
});

import { buildAskArgs, buildAskPrompt } from "@/lib/ask";

const PROMPT = "What is happening in my fleet?";

describe("buildAskArgs — per-provider non-interactive argv (cross-platform guard)", () => {
  it("claude: `claude -p`, prompt on stdin", () => {
    const plan = buildAskArgs("claude", PROMPT);
    expect(plan.binary).toBe("claude");
    expect(plan.args).toEqual(["-p"]);
    // Prompt is piped on stdin, NOT placed in argv.
    expect(plan.input).toBe(PROMPT);
    expect(plan.args).not.toContain(PROMPT);
  });

  it("codex: `codex exec`, prompt on stdin", () => {
    const plan = buildAskArgs("codex", PROMPT);
    expect(plan.binary).toBe("codex");
    expect(plan.args).toEqual(["exec"]);
    expect(plan.input).toBe(PROMPT);
    expect(plan.args).not.toContain(PROMPT);
  });

  it("both providers carry the prompt on STDIN, never in argv (injection-safe)", () => {
    // The prompt embeds untrusted fleet context; under shell:isWindows an argv
    // prompt would be command-injectable. So it must always be `input`, never an
    // arg. (Hermes — which only had an argv `-z` mode — is deferred for exactly
    // this reason.)
    for (const provider of ["claude", "codex"] as const) {
      const plan = buildAskArgs(provider, PROMPT);
      expect(plan.input).toBe(PROMPT);
      expect(plan.args).not.toContain(PROMPT);
    }
  });

  it("never adds a --dangerously-* / bypass flag (read-only Q&A)", () => {
    for (const provider of ["claude", "codex"] as const) {
      const { args } = buildAskArgs(provider, PROMPT);
      for (const arg of args) {
        expect(arg).not.toMatch(/dangerous|bypass|yolo|--fork/i);
      }
    }
  });

  it("threads a catalog model into argv per provider, prompt still on stdin", () => {
    // The model is a fixed CATALOG token (validated server-side), so it's safe in
    // argv even though the prompt never is.
    const claude = buildAskArgs("claude", PROMPT, "opus");
    expect(claude.args).toEqual(["-p", "--model", "opus"]);
    expect(claude.input).toBe(PROMPT);
    expect(claude.args).not.toContain(PROMPT);

    const codex = buildAskArgs("codex", PROMPT, "gpt-5.4");
    expect(codex.args).toEqual(["exec", "-c", "model=gpt-5.4"]);
    expect(codex.input).toBe(PROMPT);
    expect(codex.args).not.toContain(PROMPT);
  });

  it("omits the model flag when no model is given (agent's own default)", () => {
    expect(buildAskArgs("claude", PROMPT).args).toEqual(["-p"]);
    expect(buildAskArgs("codex", PROMPT).args).toEqual(["exec"]);
  });
});

describe("buildAskPrompt — grounds the question in the gathered context", () => {
  it("includes the preamble, the context, and the question", () => {
    const out = buildAskPrompt({
      context: "FLEET_CONTEXT_MARKER",
      question: "Which sessions need me?",
    });
    expect(out).toContain("Stoa's built-in assistant");
    expect(out).toContain("FLEET_CONTEXT_MARKER");
    expect(out).toContain("Which sessions need me?");
    // The instruction to stay grounded + tool-free must survive.
    expect(out).toMatch(/ONLY the CONTEXT/i);
    expect(out).toMatch(/Do not run commands or use tools/i);
  });

  it("renders prior history turns as labelled User/Assistant lines", () => {
    const out = buildAskPrompt({
      context: "CTX",
      history: [
        { role: "user", content: "earlier question" },
        { role: "assistant", content: "earlier answer" },
      ],
      question: "follow-up question",
    });
    expect(out).toContain("User: earlier question");
    expect(out).toContain("Assistant: earlier answer");
    expect(out).toContain("follow-up question");
    // History appears before the final question block.
    expect(out.indexOf("earlier question")).toBeLessThan(
      out.indexOf("follow-up question")
    );
  });

  it("omits the history section when no history is given", () => {
    const out = buildAskPrompt({ context: "CTX", question: "q" });
    expect(out).not.toContain("CONVERSATION SO FAR");
  });

  it("sanitizes control bytes out of the question (defense-in-depth)", () => {
    // ESC + CR injected into the question must not survive into the prompt. The
    // control bytes are built from char codes so this source file carries none.
    const ESC = String.fromCharCode(27);
    const CR = String.fromCharCode(13);
    const dirty = "list" + ESC + "[31m" + CR + "sessions";
    const out = buildAskPrompt({ context: "CTX", question: dirty });
    expect(out).not.toContain(ESC);
    expect(out).not.toContain(CR);
    // The visible text still survives — only the control bytes are stripped.
    expect(out).toContain("sessions");
  });
});
