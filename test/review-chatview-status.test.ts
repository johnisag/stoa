import { describe, it, expect } from "vitest";

import { applyToolEnd } from "@/components/ChatView";

// Regression test for R3 (chatview-status-coerce): applyToolEnd previously did
// `status as "completed" | "error"`, a blind cast. The wire status from a
// successful tool is the literal "success" (StreamMessageToolResult.status is
// "success" | "error"), never "completed". The off-union "success" then made
// ToolCallDisplay's {pending,running,completed,error}[status] map return
// undefined, rendering <StatusIcon /> as undefined → React "Element type is
// invalid" crash on the happy path. The fix coerces any non-error status to the
// valid display union value "completed".

const running = (name: string) =>
  ({ name, input: {}, status: "running" }) as const;

describe("applyToolEnd coerces wire status to the display union", () => {
  it('maps a "success" wire status to "completed"', () => {
    const result = applyToolEnd([running("Bash")], "Bash", "ok", "success");
    expect(result[0].status).toBe("completed");
    expect(result[0].output).toBe("ok");
  });

  it('keeps an "error" wire status as "error"', () => {
    const result = applyToolEnd([running("Grep")], "Grep", "boom", "error");
    expect(result[0].status).toBe("error");
    expect(result[0].output).toBe("boom");
  });

  it('maps any other non-error status (e.g. "completed") to "completed"', () => {
    const result = applyToolEnd([running("Read")], "Read", "x", "completed");
    expect(result[0].status).toBe("completed");
  });
});
