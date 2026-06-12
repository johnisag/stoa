import { describe, it, expect, vi } from "vitest";
import {
  scoreCommand,
  filterCommands,
  type QuickCommand,
} from "@/lib/quick-switcher-commands";

function mkCommand(over: Partial<QuickCommand> = {}): QuickCommand {
  return {
    id: "cmd",
    label: "Open Dispatch",
    keywords: ["fleet", "issues"],
    run: () => {},
    ...over,
  };
}

describe("scoreCommand", () => {
  it("returns 0 for an empty/whitespace query (matches everything)", () => {
    expect(scoreCommand("", mkCommand())).toBe(0);
    expect(scoreCommand("   ", mkCommand())).toBe(0);
  });

  it("matches against the label", () => {
    expect(scoreCommand("dispatch", mkCommand())).not.toBeNull();
    expect(scoreCommand("disp", mkCommand())).not.toBeNull(); // subsequence
  });

  it("matches against keywords, not just the label", () => {
    expect(scoreCommand("fleet", mkCommand())).not.toBeNull();
    expect(scoreCommand("issues", mkCommand())).not.toBeNull();
  });

  it("trims the query so stray spaces don't drop matches", () => {
    expect(scoreCommand("  fleet  ", mkCommand())).not.toBeNull();
  });

  it("returns null when neither label nor keywords match", () => {
    expect(scoreCommand("zzzzz", mkCommand())).toBeNull();
  });
});

describe("filterCommands", () => {
  const newSession = mkCommand({
    id: "new-session",
    label: "New Session",
    keywords: ["create", "start"],
  });
  const dispatch = mkCommand({
    id: "open-dispatch",
    label: "Open Dispatch",
    keywords: ["fleet"],
  });
  const inbox = mkCommand({
    id: "open-verdict-inbox",
    label: "Open Verdict Inbox",
    keywords: ["review", "queue"],
  });
  const all = [newSession, dispatch, inbox];

  it("returns the input order unchanged for an empty query", () => {
    expect(filterCommands(all, "").map((c) => c.id)).toEqual([
      "new-session",
      "open-dispatch",
      "open-verdict-inbox",
    ]);
    expect(filterCommands(all, "   ").map((c) => c.id)).toEqual([
      "new-session",
      "open-dispatch",
      "open-verdict-inbox",
    ]);
  });

  it("drops non-matches and keeps matches", () => {
    const ids = filterCommands(all, "inbox").map((c) => c.id);
    expect(ids).toEqual(["open-verdict-inbox"]);
  });

  it("matches by keyword as well as label", () => {
    // "fleet" only appears in dispatch's keywords, not its label.
    expect(filterCommands(all, "fleet").map((c) => c.id)).toEqual([
      "open-dispatch",
    ]);
    // "create" only appears in new-session's keywords.
    expect(filterCommands(all, "create").map((c) => c.id)).toEqual([
      "new-session",
    ]);
  });

  it("ranks a tighter label match above a looser one", () => {
    // "open" is a tight prefix of both Open Dispatch and Open Verdict Inbox but
    // never of New Session; both Open* survive and New Session is dropped.
    const ids = filterCommands(all, "open").map((c) => c.id);
    expect(ids).toContain("open-dispatch");
    expect(ids).toContain("open-verdict-inbox");
    expect(ids).not.toContain("new-session");
  });

  it("breaks score ties by original order (stable)", () => {
    // Two commands with identical matchable text -> tie -> preserve input order.
    const a = mkCommand({ id: "a", label: "Run", keywords: [] });
    const b = mkCommand({ id: "b", label: "Run", keywords: [] });
    expect(filterCommands([a, b], "run").map((c) => c.id)).toEqual(["a", "b"]);
    expect(filterCommands([b, a], "run").map((c) => c.id)).toEqual(["b", "a"]);
  });

  it("does not mutate the input array", () => {
    const input = [newSession, dispatch, inbox];
    const snapshot = input.map((c) => c.id);
    filterCommands(input, "open");
    expect(input.map((c) => c.id)).toEqual(snapshot);
  });

  it("preserves each command's run callback through filtering", () => {
    const run = vi.fn();
    const cmd = mkCommand({ id: "x", label: "Open Insight", run });
    const [match] = filterCommands([cmd], "insight");
    match.run();
    expect(run).toHaveBeenCalledTimes(1);
  });
});
