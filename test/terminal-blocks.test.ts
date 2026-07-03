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
    // Root prompt: a bare "# cmd" is EXCLUDED (markdown H1 collision); the real
    // root prompt renders glued to a host/path, which matches.
    expect(classifyBoundaryLine("root@box:/# whoami")).toEqual({
      kind: "shell",
      label: "whoami",
    });
    // zsh: the `%` sigil glued to the path token (a bare " % " with a space is
    // deliberately NOT matched — it collides with " 50 % off" prose).
    expect(classifyBoundaryLine("user@host:~/proj% git status")).toEqual({
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
    // Empty Windows pwsh prompt — the `>` is glued to a drive path, so it counts
    // (a LONE `>` does not — that's a redirect / blockquote).
    expect(classifyBoundaryLine("PS C:\\proj>")).toEqual({
      kind: "shell",
      label: "(prompt)",
    });
  });

  it("recognizes the agent input box '> ' prompt ONLY inside box chrome", () => {
    expect(classifyBoundaryLine("│ > fix the failing test")).toEqual({
      kind: "agent",
      label: "fix the failing test",
    });
    // A bare "> …" with NO box border is a markdown quote / diff line / redirect,
    // NOT an agent turn — it must not open a block (this is the primary-surface
    // over-split the heuristic exists to avoid).
    expect(classifyBoundaryLine("> explain this stack trace")).toBeNull();
    expect(classifyBoundaryLine("> a quoted markdown line")).toBeNull();
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

  it("does NOT invent boundaries from sigils in markdown / prose (the primary surface)", () => {
    // Stoa's main surface is markdown-heavy agent output. NONE of these are
    // prompts — a space-delimited or leading sigil in prose must stay interior.
    for (const line of [
      "# Authentication", // markdown H1
      "## Security notes", // markdown H2
      "> Note: tokens expire in 5 % of cases", // blockquote + prose %
      "> a quoted line", // blockquote
      "- validate > sign > store", // prose with >
      "You can pipe output: cat creds > out.txt", // redirect in prose
      "run at 10 % capacity now", // prose %
      "The cost is $ 5 today", // prose $
      "if x # 3 then", // prose #
      "50 % off today", // prose %
      "cat a.txt > b.txt", // bare redirect line
      "email me @ 50 % done", // @ + % in prose
      "issue # 42 is open", // prose #
    ]) {
      expect(classifyBoundaryLine(line), line).toBeNull();
    }
  });

  it("does NOT treat a `:`-glued token in prose as a prompt (URLs, ratios, times)", () => {
    // `:` is pervasive in prose, so it is NOT a glued-prompt marker — only @ ~ \\
    // are. These all contain a `:`-glued sigil that must stay interior output.
    for (const line of [
      "Server running at http://localhost:3000> open in browser",
      "Dev server ready on http://127.0.0.1:5173> press q to quit",
      "Map<K:V> keyed by id", // generic type
      "Events fire at 12:30> daily and 18:45> nightly", // time>
      "ratio 16:9% bigger than before", // ratio%
      "success rate is 95:5% and climbing", // ratio%
      "[2024-06-01T12:00:00Z]> request completed", // timestamp>
      "foo:bar> as a separator", // colon-glued >
      "at 10:30% capacity, we scale", // time%
    ]) {
      expect(classifyBoundaryLine(line), line).toBeNull();
    }
  });

  it("does NOT treat an <user@host> email token as a prompt (git author lines, trailers)", () => {
    // git log/show/blame + commit trailers are ubiquitous in agent output. The
    // `@` marker + trailing `>` of `<addr@host>` must NOT read as a glued prompt.
    for (const line of [
      "Author: Ada Lovelace <ada@example.com>",
      "Signed-off-by: Bob <bob@team.dev>",
      "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>", // our own trailer
      "Reviewed-by: Ann <ann@x.io> and merged by Carol", // email + trailing words
      "  1234567 (Ada <ada@x.io>  2 weeks ago) fix", // git blame line
      '  "author": "Me <me@site.dev>",', // package.json author field
    ]) {
      expect(classifyBoundaryLine(line), line).toBeNull();
    }
  });

  it("keeps a `git log` buffer as ONE block (no bogus per-author boundaries)", () => {
    const gitlog = [
      "commit 9f3a1c2 (HEAD -> main)",
      "Author: Ada Lovelace <ada@example.com>",
      "Date:   Mon Jun 1 12:00:00 2026 +0000",
      "",
      "    feat: add the thing",
      "",
      "    Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>",
      "",
      "commit 1a2b3c4",
      "Author: Bob Smith <bob@team.dev>",
      "Date:   Sun May 31 09:00:00 2026 +0000",
      "",
      "    fix: the other thing",
    ];
    const blocks = parseTerminalBlocks(gitlog);
    // No prompt anywhere → the whole buffer is a single "Output" block.
    expect(blocks).toEqual<TerminalBlock[]>([
      {
        startLine: 0,
        endLine: gitlog.length - 1,
        label: "Output",
        kind: "start",
      },
    ]);
  });

  it("recognizes the Fedora/RHEL/Arch bracket prompt [user@host cwd]$", () => {
    expect(classifyBoundaryLine("[john@fedora stoa]$ npm test")).toEqual({
      kind: "shell",
      label: "npm test",
    });
    // A plain bracket (no @) or a timestamp bracket is NOT a prompt.
    expect(classifyBoundaryLine("[note] $ 5 remaining")).toBeNull();
    expect(classifyBoundaryLine("[2024-06-01]> done")).toBeNull();
  });

  it("documents the accepted default-prompt misses (no over-split is worth it)", () => {
    // KNOWN, DELIBERATE misses — catching them safely conflicts with the prose
    // exclusions above. Locked so a future maintainer sees they are intentional.
    for (const knownMiss of [
      "stoa % npm test", // macOS zsh default `cwd %` (vs "50 % off")
      "johns-mac:stoa john$ npm test", // classic macOS `host:cwd user$`
      "bash-5.1$ ls", // marker-less default PS1
      "myhost% ls", // bare `host%`
      "pi@raspberrypi:~ $ sudo reboot", // Raspberry Pi OS `~ $` (space before $)
      "me@HOST MINGW64 ~/proj $ git status", // Git Bash default (space before $)
    ]) {
      expect(classifyBoundaryLine(knownMiss), knownMiss).toBeNull();
    }
  });

  it("keeps a whole markdown-heavy agent turn as ONE block (no over-split)", () => {
    const turn = [
      "╭─────────────────────────────╮",
      "│ > explain the auth flow      │",
      "╰─────────────────────────────╯",
      "● Here's the flow:",
      "# Authentication",
      "> Note: tokens expire in 5 % of cases",
      "- validate > sign > store",
      "You can pipe output: cat creds > out.txt",
      "## Security",
      "issue # 42 tracks the rotation",
      "Done.",
    ];
    const blocks = parseTerminalBlocks(turn);
    // Exactly ONE agent boundary (the boxed user message); everything else is its
    // output — no bogus blocks minted from headings/quotes/redirects.
    const agentBlocks = blocks.filter((b) => b.kind === "agent");
    expect(agentBlocks).toHaveLength(1);
    expect(agentBlocks[0].label).toBe("explain the auth flow");
    // A leading "start" block for the top border, then the one agent block = 2.
    expect(blocks).toHaveLength(2);
    assertContiguous(blocks, turn.length);
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
    // Lines 1-2 ("> stoa@1.0.0" / "> vitest run") are npm OUTPUT — a bare "> " with
    // no box border is correctly NOT a boundary, so they stay INSIDE the "npm test"
    // block (which therefore spans lines 0-5, up to the next real prompt).
    expect(blocks[0]).toEqual({
      startLine: 0,
      endLine: 5,
      label: "npm test",
      kind: "shell",
    });
    // Exactly three real prompts → three blocks (no bogus splits from npm's "> ").
    expect(blocks).toHaveLength(3);
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
