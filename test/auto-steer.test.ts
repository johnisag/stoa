import { describe, it, expect } from "vitest";
import {
  detectPrompt,
  nextAutoAnswerAction,
  promptSignature,
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

  it("classifies a highlighted single-shot Yes menu as affirmative (any real glyph)", () => {
    const screen =
      "Bash(npm run build)\nDo you want to proceed?\n❯ 1. Yes\n  2. No";
    expect(detectPrompt(screen)?.kind).toBe("affirmative");
    expect(
      detectPrompt("› 1. Yes\n  2. No, tell Claude what to do")?.kind
    ).toBe("affirmative");
    expect(detectPrompt("❯ 1. Yes, proceed\n  2. No")?.kind).toBe(
      "affirmative"
    );
  });

  it("does NOT treat the ASCII '>' input box / redirect as a menu cursor", () => {
    // A half-typed message in the input box must never submit itself on Enter.
    expect(detectPrompt("> 1. yes go ahead with the refactor")?.kind).not.toBe(
      "affirmative"
    );
  });

  it("escalates a QUALIFIED highlighted Yes (allowlist is fail-closed)", () => {
    // The structural safety: only a BARE single-shot yes is accepted. New standing-
    // grant phrasings a provider invents fall through to escalate automatically.
    for (const opt of [
      "Yes, allow always",
      "Yes, without asking for approval",
      "Yes, auto-approve from now on",
      "Yes, allow for this session",
      "Yes, and remember my choice",
    ]) {
      expect(detectPrompt(`❯ 1. ${opt}\n  2. No`)?.kind).not.toBe(
        "affirmative"
      );
    }
  });

  it("answers the REAL Claude Code menu (highlighted single-shot Yes) even though a blanket option exists below it", () => {
    // The value fix: option 2 being "allow all / don't ask again" must NOT veto the
    // whole prompt — Enter selects the HIGHLIGHTED option 1, the safe single-shot.
    const cc =
      "Bash(npm run test)\nDo you want to proceed?\n❯ 1. Yes\n  2. Yes, and don't ask again for npm run test commands\n  3. No, and tell Claude what to do differently";
    expect(detectPrompt(cc)?.kind).toBe("affirmative");
  });

  it("escalates when the cursor sits ON the blanket / No option (Enter would select it)", () => {
    // Highlight on the standing-grant option → Enter would grant it → escalate.
    expect(
      detectPrompt("  1. Yes\n❯ 2. Yes, and don't ask again\n  3. No")?.kind
    ).toBe("blanket");
    // Highlight on the No option → Enter would answer No → escalate.
    expect(
      detectPrompt("  1. Yes\n❯ 2. No, and tell Claude what to do")?.kind
    ).toBe("negative");
  });

  it("escalates a default-No prompt (never flip No to Yes)", () => {
    expect(detectPrompt("Delete this file? [y/N]")?.kind).toBe("negative");
  });

  it("escalates a folder/workspace-trust prompt even with a highlighted Yes", () => {
    expect(
      detectPrompt(
        "Do you trust the files in this folder?\n❯ 1. Yes, proceed\n  2. No"
      )?.kind
    ).not.toBe("affirmative");
  });

  it("escalates folder-trust even when the trust question scrolled above the menu", () => {
    const screen =
      "Do you trust the files in this folder?\n" +
      Array(8).fill("  (explanation line)").join("\n") +
      "\n❯ 1. Yes\n  2. No";
    expect(detectPrompt(screen)?.kind).not.toBe("affirmative");
  });

  it("escalates blanket / standing-permission grants in non-menu prompts", () => {
    expect(
      detectPrompt("Do you want to proceed?\n  2. Yes, allow all edits")?.kind
    ).toBe("blanket");
    expect(
      detectPrompt("Allow this command? Yes, and don't ask again")?.kind
    ).toBe("blanket");
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
    // Windows deletions (this product runs natively on Windows).
    expect(detectPrompt("Bash(rd /s /q build)\n❯ 1. Yes")?.kind).toBe(
      "destructive"
    );
    expect(detectPrompt("Bash(del /f /q dist)\n❯ 1. Yes")?.kind).toBe(
      "destructive"
    );
    // Infra teardown the POSIX-y denylist would have missed before.
    expect(
      detectPrompt("Bash(terraform destroy -auto-approve)\n❯ 1. Yes")?.kind
    ).toBe("destructive");
    expect(detectPrompt("Bash(gh repo delete acme/app)\n❯ 1. Yes")?.kind).toBe(
      "destructive"
    );
    // A command split across a wrapped line still escalates (newline-healed scan),
    // INCLUDING the terminal's padding spaces at the wrap boundary.
    expect(detectPrompt("Bash(git push --fo\nrce)\nProceed? [Y/n]")?.kind).toBe(
      "destructive"
    );
    expect(
      detectPrompt("Bash(git push --fo   \nrce)\nProceed? [Y/n]")?.kind
    ).toBe("destructive");
    // Force via short flag / refspec (the long --force isn't the only form).
    expect(detectPrompt("Bash(git push -f origin main)\n❯ 1. Yes")?.kind).toBe(
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

describe("promptSignature", () => {
  it("is stable across a volatile countdown (no Enter re-spam)", () => {
    const a = promptSignature({
      kind: "continue",
      line: "Press Enter (auto in 5s)",
    });
    const b = promptSignature({
      kind: "continue",
      line: "Press Enter (auto in 3s)",
    });
    expect(a).toBe(b);
  });

  it("distinguishes different prompts on the same session", () => {
    const yes = promptSignature({ kind: "affirmative", line: "❯ 1. Yes" });
    const cont = promptSignature({
      kind: "continue",
      line: "Press Enter to continue",
    });
    expect(yes).not.toBe(cont);
  });
});
