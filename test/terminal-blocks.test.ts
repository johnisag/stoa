import { describe, it, expect } from "vitest";
import {
  parseTerminalBlocks,
  classifyBoundaryLine,
  blockIndexForLine,
  nextBlockLine,
  truncateLabel,
  type TerminalBlock,
} from "@/lib/terminal-blocks";

describe("classifyBoundaryLine", () => {
  it("recognizes bash/sh/zsh/pwsh/starship prompt sigils with a command", () => {
    expect(classifyBoundaryLine("$ ls -la")).toEqual({
      kind: "shell",
      label: "ls -la",
    });
    expect(classifyBoundaryLine("# whoami")).toEqual({
      kind: "shell",
      label: "whoami",
    });
    expect(classifyBoundaryLine("user@host ~ % git status")).toEqual({
      kind: "shell",
      label: "git status",
    });
    expect(classifyBoundaryLine("PS C:\\proj> npm run dev")).toEqual({
      kind: "shell",
      label: "npm run dev",
    });
    expect(classifyBoundaryLine("❯ vitest run")).toEqual({
      kind: "shell",
      label: "vitest run",
    });
    // A starship/oh-my-zsh prompt with git decoration: with no OSC integration
    // we can't know where the decoration ends and the command begins, so the
    // whole post-sigil remainder is the label. Recognizing it as a shell boundary
    // (the load-bearing part) is what matters.
    expect(classifyBoundaryLine("➜  repo git:(main) ✗ echo hi")).toEqual({
      kind: "shell",
      label: "repo git:(main) ✗ echo hi",
    });
  });

  it("recognizes an empty prompt (no command typed) as a boundary", () => {
    expect(classifyBoundaryLine("$ ")).toEqual({
      kind: "shell",
      label: "(prompt)",
    });
    // Right-trimmed empty prompt (translateToString drops the trailing space).
    expect(classifyBoundaryLine("user@host:~$")).toEqual({
      kind: "shell",
      label: "(prompt)",
    });
  });

  it("recognizes the agent input box '> ' prompt inside box chrome", () => {
    expect(classifyBoundaryLine("│ > fix the failing test")).toEqual({
      kind: "agent",
      label: "fix the failing test",
    });
    expect(classifyBoundaryLine("> explain this stack trace")).toEqual({
      kind: "agent",
      label: "explain this stack trace",
    });
  });

  it("does NOT treat ordinary output as a boundary", () => {
    expect(classifyBoundaryLine("Compiling module foo...")).toBeNull();
    expect(
      classifyBoundaryLine("  at Object.<anonymous> (index.ts:5)")
    ).toBeNull();
    // A price / a regex anchor is not a prompt (no sigil+space, no bare sigil).
    expect(classifyBoundaryLine("Total: $5.00 due")).toBeNull();
    expect(classifyBoundaryLine("match /foo$/g")).toBeNull();
    expect(classifyBoundaryLine("")).toBeNull();
    expect(classifyBoundaryLine("   ")).toBeNull();
  });

  it("does not mistake a shell redirect '>' mid-line for a prompt boundary label", () => {
    // "cat file > out.txt" ends with ".txt", not a sigil — so the FIRST sigil
    // ($ at start) wins and the rest, including the redirect, is the command.
    const hit = classifyBoundaryLine("$ cat file > out.txt");
    expect(hit).toEqual({ kind: "shell", label: "cat file > out.txt" });
  });

  it("recognizes a GLUED PS1 prompt where the sigil hugs the path", () => {
    expect(classifyBoundaryLine("user@host:~/proj$ npm test")).toEqual({
      kind: "shell",
      label: "npm test",
    });
    expect(classifyBoundaryLine("C:\\Users\\me> dir")).toEqual({
      kind: "shell",
      label: "dir",
    });
  });

  it("does not treat prose ending in a lone glyph as an empty prompt", () => {
    // No prompt-prefix marker in the last token → not a prompt.
    expect(classifyBoundaryLine("it costs 5%")).toBeNull();
    expect(classifyBoundaryLine("fix TODO #")).toBeNull();
    // A word with a glued '>' but no @:~\\ marker is NOT a glued prompt.
    expect(classifyBoundaryLine("value> unexpected")).toBeNull();
  });

  it("treats a lone prompt sigil (empty starship prompt) as a boundary", () => {
    expect(classifyBoundaryLine("❯")).toEqual({
      kind: "shell",
      label: "(prompt)",
    });
  });
});

describe("parseTerminalBlocks — a bash session", () => {
  const screen = [
    "user@host:~/proj$ npm test",
    "> stoa@1.0.0 test",
    "> vitest run",
    "",
    "  Test Files  42 passed",
    "  Tests  310 passed",
    "user@host:~/proj$ git status",
    "On branch main",
    "nothing to commit, working tree clean",
    "user@host:~/proj$ ",
  ];

  it("splits into one block per prompt line, contiguous and covering the buffer", () => {
    const blocks = parseTerminalBlocks(screen);
    // Note: lines 1-2 ("> stoa@1.0.0" / "> vitest run") ARE npm output but read
    // as agent-prompt boundaries — an inherent ambiguity of the "> " heuristic
    // with no OSC integration. We assert the boundaries the parser actually finds
    // and that the ranges stay contiguous + complete (the navigation invariant).
    expect(blocks[0]).toEqual({
      startLine: 0,
      endLine: 0,
      label: "npm test",
      kind: "shell",
    });
    // Contiguity + full coverage is the load-bearing invariant for navigation.
    assertContiguous(blocks, screen.length);
    // The two git-related prompts are found.
    const labels = blocks.map((b) => b.label);
    expect(labels).toContain("git status");
    expect(labels).toContain("(prompt)"); // trailing empty prompt
  });
});

describe("parseTerminalBlocks — a Claude turn", () => {
  const screen = [
    "╭──────────────────────────────────────────╮",
    "│ > refactor the parser to be pure          │",
    "╰──────────────────────────────────────────╯",
    "",
    "● I'll refactor the parser now.",
    "  Reading lib/terminal-blocks.ts...",
    "· Cerebrating… (esc to interrupt)",
    "╭──────────────────────────────────────────╮",
    "│ > now add tests                            │",
    "╰──────────────────────────────────────────╯",
  ];

  it("opens a new block at each user message box", () => {
    const blocks = parseTerminalBlocks(screen);
    const agentBlocks = blocks.filter((b) => b.kind === "agent");
    expect(agentBlocks.map((b) => b.label)).toEqual([
      "refactor the parser to be pure",
      "now add tests",
    ]);
    assertContiguous(blocks, screen.length);
    // The border-only line above the first box is a leading "Output" block.
    expect(blocks[0].kind).toBe("start");
    expect(blocks[0].startLine).toBe(0);
  });
});

describe("parseTerminalBlocks — multi-line output with no prompt", () => {
  const screen = ["Building...", "  module A", "  module B", "Done in 4.2s"];

  it("yields a single 'start' block spanning the whole buffer", () => {
    const blocks = parseTerminalBlocks(screen);
    expect(blocks).toEqual<TerminalBlock[]>([
      { startLine: 0, endLine: 3, label: "Output", kind: "start" },
    ]);
  });
});

describe("parseTerminalBlocks — empty / blank buffers", () => {
  it("returns no blocks for a truly empty buffer", () => {
    expect(parseTerminalBlocks([])).toEqual([]);
  });

  it("returns one 'start' block for an all-blank buffer", () => {
    const blocks = parseTerminalBlocks(["", "", ""]);
    expect(blocks).toEqual<TerminalBlock[]>([
      { startLine: 0, endLine: 2, label: "Output", kind: "start" },
    ]);
  });
});

describe("blockIndexForLine", () => {
  const blocks: TerminalBlock[] = [
    { startLine: 0, endLine: 2, label: "a", kind: "start" },
    { startLine: 3, endLine: 5, label: "b", kind: "shell" },
    { startLine: 6, endLine: 9, label: "c", kind: "shell" },
  ];

  it("finds the block containing a line", () => {
    expect(blockIndexForLine(blocks, 0)).toBe(0);
    expect(blockIndexForLine(blocks, 2)).toBe(0);
    expect(blockIndexForLine(blocks, 3)).toBe(1);
    expect(blockIndexForLine(blocks, 9)).toBe(2);
  });

  it("clamps out-of-range lines to the ends", () => {
    expect(blockIndexForLine(blocks, -5)).toBe(0);
    expect(blockIndexForLine(blocks, 999)).toBe(2);
  });

  it("returns -1 for no blocks", () => {
    expect(blockIndexForLine([], 0)).toBe(-1);
  });
});

describe("nextBlockLine", () => {
  const blocks: TerminalBlock[] = [
    { startLine: 0, endLine: 2, label: "a", kind: "start" },
    { startLine: 3, endLine: 5, label: "b", kind: "shell" },
    { startLine: 6, endLine: 9, label: "c", kind: "shell" },
  ];

  it("jumps to the next block's start", () => {
    expect(nextBlockLine(blocks, 1, 1)).toBe(3);
    expect(nextBlockLine(blocks, 3, 1)).toBe(6);
  });

  it("jumps to the previous block's start", () => {
    expect(nextBlockLine(blocks, 7, -1)).toBe(3);
    expect(nextBlockLine(blocks, 4, -1)).toBe(0);
  });

  it("returns null at the boundaries (nowhere to go)", () => {
    expect(nextBlockLine(blocks, 0, -1)).toBeNull();
    expect(nextBlockLine(blocks, 9, 1)).toBeNull();
    expect(nextBlockLine([], 0, 1)).toBeNull();
  });

  it("returns null in both directions when there is a single block", () => {
    const one: TerminalBlock[] = [
      { startLine: 0, endLine: 4, label: "only", kind: "start" },
    ];
    expect(nextBlockLine(one, 2, 1)).toBeNull();
    expect(nextBlockLine(one, 2, -1)).toBeNull();
  });
});

describe("truncateLabel", () => {
  it("leaves short labels untouched", () => {
    expect(truncateLabel("npm test")).toBe("npm test");
  });

  it("clips long labels with an ellipsis", () => {
    const long = "x".repeat(200);
    const out = truncateLabel(long, 10);
    expect(out).toHaveLength(10);
    expect(out.endsWith("…")).toBe(true);
  });
});

/** Assert blocks are gap-free, non-overlapping and cover [0, total). */
function assertContiguous(blocks: TerminalBlock[], total: number): void {
  expect(blocks.length).toBeGreaterThan(0);
  expect(blocks[0].startLine).toBe(0);
  expect(blocks[blocks.length - 1].endLine).toBe(total - 1);
  for (let i = 1; i < blocks.length; i++) {
    expect(blocks[i].startLine).toBe(blocks[i - 1].endLine + 1);
    expect(blocks[i].endLine).toBeGreaterThanOrEqual(blocks[i].startLine);
  }
}
