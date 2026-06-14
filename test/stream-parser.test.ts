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
