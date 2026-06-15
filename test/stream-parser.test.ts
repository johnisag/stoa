import { describe, it, expect, vi } from "vitest";
import { StreamParser } from "@/lib/claude/stream-parser";

describe("StreamParser", () => {
  it("emits an init event from a system init message", () => {
    const parser = new StreamParser("s1");
    const events: unknown[] = [];
    parser.on("event", (e) => events.push(e));
    parser.write(
      JSON.stringify({ type: "system", subtype: "init", session_id: "abc" })
    );
    parser.end();
    expect(events).toHaveLength(1);
    expect((events[0] as { type: string }).type).toBe("init");
    expect(
      (events[0] as { data: { claudeSessionId: string } }).data.claudeSessionId
    ).toBe("abc");
  });

  it("handles CRLF line endings without spurious parse errors", () => {
    const parser = new StreamParser("s1");
    const events: unknown[] = [];
    const errors: unknown[] = [];
    parser.on("event", (e) => events.push(e));
    parser.on("parse_error", (e) => errors.push(e));
    parser.write(
      JSON.stringify({ type: "system", subtype: "init", session_id: "abc" }) +
        "\r\n"
    );
    parser.write(
      JSON.stringify({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
      }) + "\r\n"
    );
    parser.end();
    expect(errors).toHaveLength(0);
    expect(events).toHaveLength(2);
  });

  it("handles lone CR line endings", () => {
    const parser = new StreamParser("s1");
    const events: unknown[] = [];
    const errors: unknown[] = [];
    parser.on("event", (e) => events.push(e));
    parser.on("parse_error", (e) => errors.push(e));
    parser.write(
      JSON.stringify({ type: "system", subtype: "init", session_id: "abc" }) +
        "\r"
    );
    parser.end();
    expect(errors).toHaveLength(0);
    expect(events).toHaveLength(1);
  });

  it("does not split a record when a CRLF straddles two write() chunks", () => {
    // The first chunk ends on a bare CR (the LF lands in the next chunk). A
    // trailing CR must be held back, not eagerly turned into a line break that
    // splits the still-incomplete record and emits a spurious parse error.
    const parser = new StreamParser("s1");
    const events: unknown[] = [];
    const errors: unknown[] = [];
    parser.on("event", (e) => events.push(e));
    parser.on("parse_error", (e) => errors.push(e));
    const line = JSON.stringify({
      type: "system",
      subtype: "init",
      session_id: "abc",
    });
    const half = Math.floor(line.length / 2);
    parser.write(line.slice(0, half) + line.slice(half) + "\r"); // record + bare CR
    parser.write("\n"); // the LF of the CRLF arrives next
    parser.end();
    expect(errors).toHaveLength(0);
    expect(events).toHaveLength(1);
  });

  it("emits tool_start for tool_use blocks inside an assistant message", () => {
    const parser = new StreamParser("s1");
    const events: Array<{ type: string; data?: Record<string, unknown> }> = [];
    parser.on("event", (e) => events.push(e));
    parser.write(
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "running a command" },
            {
              type: "tool_use",
              id: "t1",
              name: "Bash",
              input: { command: "ls" },
            },
          ],
        },
      }) + "\n"
    );
    parser.end();
    const types = events.map((e) => e.type);
    expect(types).toContain("text");
    expect(types).toContain("tool_start");
    const tool = events.find((e) => e.type === "tool_start")!;
    expect(tool.data).toMatchObject({
      toolName: "Bash",
      input: { command: "ls" },
    });
  });

  it("does not crash on a legacy message missing content", () => {
    const parser = new StreamParser("s1");
    const events: unknown[] = [];
    const errors: unknown[] = [];
    parser.on("event", (e) => events.push(e));
    parser.on("parse_error", (e) => errors.push(e));
    parser.write(JSON.stringify({ type: "message", role: "assistant" }));
    parser.end();
    expect(events).toHaveLength(0);
    expect(errors).toHaveLength(0);
  });

  it("does not crash on a legacy message with content missing text", () => {
    const parser = new StreamParser("s1");
    const events: unknown[] = [];
    parser.on("event", (e) => events.push(e));
    parser.write(
      JSON.stringify({
        type: "message",
        role: "assistant",
        content: [{ type: "text" }],
      })
    );
    parser.end();
    expect(events).toHaveLength(0);
  });

  it("emits a parse_error for malformed JSON", () => {
    const parser = new StreamParser("s1");
    const errors: unknown[] = [];
    parser.on("parse_error", (e) => errors.push(e));
    parser.write("not-json");
    parser.end();
    expect(errors).toHaveLength(1);
  });

  it("caps the internal buffer when a line is never terminated", () => {
    const parser = new StreamParser("s1");
    const errors: unknown[] = [];
    parser.on("parse_error", (e) => errors.push(e));
    // Write a lot of unterminated text.
    parser.write("x".repeat(StreamParser.MAX_BUFFER + 1000));
    expect(errors).toHaveLength(0);
  });
});
