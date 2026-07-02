import { describe, it, expect, afterEach } from "vitest";
import {
  compactMemoryEnabled,
  customCompactPrompt,
  buildCompactCommand,
  buildCompactMemoryMarkdown,
  buildReinjectMessage,
  nextReinjectAction,
  COMPACT_MEMORY_FILE,
  REINJECT_MIN_DELAY_MS,
  REINJECT_MAX_WAIT_MS,
} from "../lib/compact-memory";
import type { TranscriptEntry } from "../lib/summarize";

// #25 remainder — the external-memory half of compaction control.

const ESC = String.fromCharCode(27);

describe("compactMemoryEnabled / customCompactPrompt (env parsing)", () => {
  const prevMem = process.env.STOA_COMPACT_MEMORY;
  const prevPrompt = process.env.STOA_AUTO_COMPACT_PROMPT;
  afterEach(() => {
    if (prevMem === undefined) delete process.env.STOA_COMPACT_MEMORY;
    else process.env.STOA_COMPACT_MEMORY = prevMem;
    if (prevPrompt === undefined) delete process.env.STOA_AUTO_COMPACT_PROMPT;
    else process.env.STOA_AUTO_COMPACT_PROMPT = prevPrompt;
  });

  it("memory flush is opt-in: only '1' arms it", () => {
    delete process.env.STOA_COMPACT_MEMORY;
    expect(compactMemoryEnabled()).toBe(false);
    process.env.STOA_COMPACT_MEMORY = "true";
    expect(compactMemoryEnabled()).toBe(false);
    process.env.STOA_COMPACT_MEMORY = "1";
    expect(compactMemoryEnabled()).toBe(true);
  });

  it("no/blank prompt env → null (the bare /compact ships unchanged)", () => {
    delete process.env.STOA_AUTO_COMPACT_PROMPT;
    expect(customCompactPrompt()).toBeNull();
    process.env.STOA_AUTO_COMPACT_PROMPT = "   ";
    expect(customCompactPrompt()).toBeNull();
  });

  it("sanitizes the prompt to ONE line: newlines collapsed, controls stripped, capped", () => {
    process.env.STOA_AUTO_COMPACT_PROMPT =
      "keep file paths\nand next steps" + ESC;
    const p = customCompactPrompt();
    expect(p).toBe("keep file paths and next steps");
    expect(p).not.toContain(ESC); // the control BYTE is gone (no keystrokes)
    process.env.STOA_AUTO_COMPACT_PROMPT = "x".repeat(1000);
    expect(customCompactPrompt()!.length).toBeLessThanOrEqual(400);
  });
});

describe("buildCompactCommand", () => {
  it("bare /compact without a prompt (byte-identical to shipped behavior)", () => {
    expect(buildCompactCommand(null)).toBe("/compact");
  });

  it("appends the custom steering prompt", () => {
    expect(buildCompactCommand("keep next steps")).toBe(
      "/compact keep next steps"
    );
  });
});

describe("buildCompactMemoryMarkdown", () => {
  const entries: TranscriptEntry[] = [
    { role: "user", text: "fix the bug in server.ts" },
    { role: "assistant", text: "Found it — the tick misses the guard." },
    { role: "user", text: "ship it" },
  ];

  it("renders metadata + the conversation in order", () => {
    const md = buildCompactMemoryMarkdown({
      sessionName: "worker-1",
      model: "claude-sonnet-4-6",
      contextPct: 0.87,
      nowIso: "2026-07-02T03:00:00.000Z",
      entries,
    });
    expect(md).toContain("# Pre-compact memory — worker-1");
    expect(md).toContain("- Model: claude-sonnet-4-6");
    expect(md).toContain("~87%");
    expect(md).toContain("2026-07-02T03:00:00.000Z");
    // Order preserved oldest → newest.
    expect(md.indexOf("fix the bug")).toBeLessThan(md.indexOf("Found it"));
    expect(md.indexOf("Found it")).toBeLessThan(md.indexOf("ship it"));
  });

  it("is TAIL-biased under the cap: the newest entries survive", () => {
    const many: TranscriptEntry[] = Array.from({ length: 50 }, (_, i) => ({
      role: "user" as const,
      text: `entry-${i} ` + "pad".repeat(100),
    }));
    const md = buildCompactMemoryMarkdown({
      sessionName: "s",
      model: null,
      contextPct: 0.9,
      nowIso: "2026-07-02T03:00:00.000Z",
      entries: many,
      maxChars: 2000,
    });
    expect(md).toContain("entry-49"); // newest kept
    expect(md).not.toContain("entry-0 "); // oldest dropped first
  });

  it("strips control BYTES from entry text (printable residue is harmless)", () => {
    const md = buildCompactMemoryMarkdown({
      sessionName: "s",
      model: null,
      contextPct: 0.85,
      nowIso: "2026-07-02T03:00:00.000Z",
      entries: [{ role: "assistant", text: "red" + ESC + "text" }],
    });
    expect(md).not.toContain(ESC);
    expect(md).toContain("redtext");
  });

  it("degrades to a valid document with no entries", () => {
    const md = buildCompactMemoryMarkdown({
      sessionName: "s",
      model: null,
      contextPct: 0.85,
      nowIso: "2026-07-02T03:00:00.000Z",
      entries: [],
    });
    expect(md).toContain("(no conversation captured)");
  });
});

describe("buildReinjectMessage", () => {
  it("is one line and points at the memory file", () => {
    const msg = buildReinjectMessage();
    expect(msg).toContain(COMPACT_MEMORY_FILE);
    expect(msg).not.toContain("\n");
  });
});

describe("nextReinjectAction", () => {
  const base = {
    pendingSinceMs: 0,
    isIdle: true,
    hasPrompt: false,
    contextPct: 0.3,
    threshold: 0.85,
  };

  it("waits out the settle delay before anything else", () => {
    expect(
      nextReinjectAction({ ...base, nowMs: REINJECT_MIN_DELAY_MS - 1 })
    ).toBe("wait");
    expect(nextReinjectAction({ ...base, nowMs: REINJECT_MIN_DELAY_MS })).toBe(
      "inject"
    );
  });

  it("waits while the context is still over threshold (compaction not landed)", () => {
    expect(
      nextReinjectAction({
        ...base,
        nowMs: REINJECT_MIN_DELAY_MS,
        contextPct: 0.9,
      })
    ).toBe("wait");
  });

  it("treats an unknown occupancy after the delay as landed", () => {
    expect(
      nextReinjectAction({
        ...base,
        nowMs: REINJECT_MIN_DELAY_MS,
        contextPct: null,
      })
    ).toBe("inject");
  });

  it("respects the canonical idle-AND-no-prompt boundary", () => {
    expect(
      nextReinjectAction({
        ...base,
        nowMs: REINJECT_MIN_DELAY_MS,
        isIdle: false,
      })
    ).toBe("wait");
    expect(
      nextReinjectAction({
        ...base,
        nowMs: REINJECT_MIN_DELAY_MS,
        hasPrompt: true,
      })
    ).toBe("wait");
  });

  it("expires a pointer that never found a boundary", () => {
    expect(
      nextReinjectAction({
        ...base,
        nowMs: REINJECT_MAX_WAIT_MS + 1,
        isIdle: false,
      })
    ).toBe("expire");
  });

  it("honors custom delay/wait overrides", () => {
    expect(
      nextReinjectAction({ ...base, nowMs: 5, minDelayMs: 10, maxWaitMs: 100 })
    ).toBe("wait");
    expect(
      nextReinjectAction({ ...base, nowMs: 11, minDelayMs: 10, maxWaitMs: 100 })
    ).toBe("inject");
    expect(
      nextReinjectAction({
        ...base,
        nowMs: 101,
        minDelayMs: 10,
        maxWaitMs: 100,
      })
    ).toBe("expire");
  });
});
