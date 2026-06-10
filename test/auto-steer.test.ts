import { describe, it, expect } from "vitest";
import {
  detectPrompt,
  nextAutoAnswerAction,
  type PromptState,
} from "../lib/auto-steer";

describe("detectPrompt — classification", () => {
  it("returns null when there's no prompt on screen", () => {
    expect(detectPrompt("")).toBeNull();
    expect(
      detectPrompt("building the project…\ncompiled 42 modules")
    ).toBeNull();
    // A prompt-like word in normal output (not an actual prompt) shouldn't trip.
    expect(detectPrompt("I will now continue with the refactor.")).toBeNull();
  });

  it("classifies Enter-acceptable prompts as continue", () => {
    expect(detectPrompt("Press Enter to continue")?.kind).toBe("continue");
    expect(detectPrompt("Press Enter to confirm, Esc to cancel")?.kind).toBe(
      "continue"
    );
    expect(detectPrompt("Overwrite the file? [Y/n]")?.kind).toBe("continue");
  });

  it("classifies a highlighted-Yes permission menu as affirmative", () => {
    const screen =
      "Bash(npm run build)\nDo you want to proceed?\n❯ 1. Yes\n  2. No";
    expect(detectPrompt(screen)?.kind).toBe("affirmative");
    expect(
      detectPrompt("> 1. Yes\n  2. No, tell Claude what to do")?.kind
    ).toBe("affirmative");
  });

  it("escalates a default-No prompt (never flip No to Yes)", () => {
    expect(detectPrompt("Delete this file? [y/N]")?.kind).toBe("negative");
  });

  it("escalates blanket / standing-permission grants", () => {
    expect(
      detectPrompt("Do you want to proceed?\n  2. Yes, allow all edits")?.kind
    ).toBe("blanket");
    expect(
      detectPrompt("Allow this command? Yes, and don't ask again")?.kind
    ).toBe("blanket");
    expect(detectPrompt("❯ 1. Yes\n  2. Yes, allow all commands")?.kind).toBe(
      "blanket"
    );
  });

  it("escalates a destructive-looking gated command even with a Yes default", () => {
    // The command renders above the prompt; the recent-window scan catches it.
    expect(
      detectPrompt("Bash(rm -rf build)\nDo you want to proceed?\n❯ 1. Yes")
        ?.kind
    ).toBe("destructive");
    expect(detectPrompt("Bash(git push --force)\nProceed? [Y/n]")?.kind).toBe(
      "destructive"
    );
    expect(detectPrompt("Bash(npm install left-pad)\n❯ 1. Yes")?.kind).toBe(
      "destructive"
    );
    expect(detectPrompt("Run: sudo rm /etc/hosts\nContinue? [Y/n]")?.kind).toBe(
      "destructive"
    );
  });

  it("classifies a prompt with no Enter-acceptable shape as freeform", () => {
    // "Allow?" / bare "Continue?" with no [Y/n] default — we don't know Enter accepts.
    expect(detectPrompt("Allow this tool call?")?.kind).toBe("freeform");
    expect(detectPrompt("Continue?")?.kind).toBe("freeform");
    expect(detectPrompt("Run the migration? (yes/no)")?.kind).toBe("freeform");
  });

  it("only looks at the recent window (old scrollback can't trip it)", () => {
    const old =
      "Press Enter to continue\n" + Array(20).fill("work line").join("\n");
    expect(detectPrompt(old)).toBeNull();
  });

  it("captures the matched line for the once-guard signature", () => {
    const p = detectPrompt("Bash(ls)\nDo you want to proceed?\n❯ 1. Yes");
    expect(p?.line).toBe("❯ 1. Yes");
  });
});

describe("nextAutoAnswerAction", () => {
  const waiting = (kind: PromptState["kind"]) => ({
    prompt: { kind, line: "x" },
    status: "waiting",
  });

  it("answers continue + affirmative prompts (Enter accepts the default)", () => {
    expect(nextAutoAnswerAction(waiting("continue"))).toBe("answer");
    expect(nextAutoAnswerAction(waiting("affirmative"))).toBe("answer");
  });

  it("escalates blanket / negative / destructive / freeform", () => {
    for (const kind of [
      "blanket",
      "negative",
      "destructive",
      "freeform",
    ] as const) {
      expect(nextAutoAnswerAction(waiting(kind))).toBe("escalate");
    }
  });

  it("is idle when there's no prompt", () => {
    expect(nextAutoAnswerAction({ prompt: null, status: "waiting" })).toBe(
      "idle"
    );
  });

  it("is idle unless the session is actually blocked (status === waiting)", () => {
    for (const status of ["running", "idle", "error", "dead"]) {
      expect(
        nextAutoAnswerAction({
          prompt: { kind: "continue", line: "x" },
          status,
        })
      ).toBe("idle");
    }
  });
});
