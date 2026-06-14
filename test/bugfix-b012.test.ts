import { describe, it, expect } from "vitest";

import { applyToolEnd } from "@/components/ChatView";

// Regression test for B012: ChatView's tool_end handler finalized EVERY
// running tool call whose name matched the event's toolName. Two concurrent
// same-named calls therefore both completed with the same output. The wire
// protocol carries no tool-use id, so the fix correlates by name but only
// finalizes the FIRST still-running matching entry.

const running = (name: string) =>
  ({ name, input: {}, status: "running" }) as const;

describe("applyToolEnd finalizes only one concurrent same-named call", () => {
  it("completes only the first running entry for two same-named calls", () => {
    const calls = [running("Bash"), running("Bash")];

    const result = applyToolEnd(calls, "Bash", "first output", "completed");

    // First entry finalized...
    expect(result[0].status).toBe("completed");
    expect(result[0].output).toBe("first output");
    // ...second still running, untouched (does NOT collapse onto same output).
    expect(result[1].status).toBe("running");
    expect(result[1].output).toBeUndefined();
  });

  it("a second tool_end finalizes the still-running second call", () => {
    const calls = [running("Bash"), running("Bash")];
    const afterFirst = applyToolEnd(calls, "Bash", "out-1", "completed");
    const result = applyToolEnd(afterFirst, "Bash", "out-2", "completed");

    expect(result[0].output).toBe("out-1");
    expect(result[1].status).toBe("completed");
    expect(result[1].output).toBe("out-2");
  });

  it("leaves unrelated and already-completed calls alone", () => {
    const calls = [
      { name: "Read", input: {}, output: "done", status: "completed" as const },
      running("Bash"),
    ];

    const result = applyToolEnd(calls, "Bash", "bash out", "completed");

    // Pre-completed Read untouched.
    expect(result[0]).toEqual(calls[0]);
    // Running Bash finalized.
    expect(result[1].status).toBe("completed");
    expect(result[1].output).toBe("bash out");
  });

  it("maps an error status through", () => {
    const result = applyToolEnd([running("Grep")], "Grep", "boom", "error");
    expect(result[0].status).toBe("error");
    expect(result[0].output).toBe("boom");
  });

  it("returns the list unchanged when nothing matches", () => {
    const calls = [
      { name: "Read", input: {}, output: "x", status: "completed" as const },
    ];
    expect(applyToolEnd(calls, "Bash", "y", "completed")).toBe(calls);
  });

  it("tolerates an undefined call list", () => {
    expect(applyToolEnd(undefined, "Bash", "y", "completed")).toEqual([]);
  });
});
