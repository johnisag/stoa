import { EventEmitter } from "events";
import type {
  StreamMessage,
  StreamMessageSystem,
  StreamMessageAssistant,
  StreamMessageContent,
  StreamMessageResult,
  ClientEvent,
  TextContent,
  ToolUseContent,
} from "./types";

export class StreamParser extends EventEmitter {
  private buffer = "";
  private sessionId: string;

  constructor(sessionId: string) {
    super();
    this.sessionId = sessionId;
  }

  // Process incoming data chunk
  write(chunk: string): void {
    this.buffer += chunk;

    // Normalize line endings so NDJSON splits cleanly on every platform, WITHOUT
    // splitting a still-incomplete record. Convert CRLF → LF and lone CR → LF —
    // but hold back a TRAILING CR, which may be the first half of a CRLF whose LF
    // lands in the next chunk, or the tail of an unfinished record. Converting it
    // now would split that partial record early and emit a spurious parse error.
    const trailingCR = this.buffer.endsWith("\r");
    if (trailingCR) this.buffer = this.buffer.slice(0, -1);
    this.buffer = this.buffer.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    if (trailingCR) this.buffer += "\r";

    // Cap unterminated-line buffering so a malformed stream can't grow forever.
    if (this.buffer.length > StreamParser.MAX_BUFFER) {
      console.error(
        `[stream-parser] buffer exceeded ${StreamParser.MAX_BUFFER} chars; dropping`
      );
      this.buffer = this.buffer.slice(-StreamParser.MAX_BUFFER / 2);
    }

    // Process complete lines (NDJSON format)
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() || ""; // Keep incomplete line in buffer

    for (const line of lines) {
      if (line.trim()) {
        this.parseLine(line);
      }
    }
  }

  // Flush any remaining buffer
  end(): void {
    if (this.buffer.trim()) {
      this.parseLine(this.buffer);
    }
    this.buffer = "";
  }

  private parseLine(line: string): void {
    try {
      const message: StreamMessage = JSON.parse(line);
      // One message can yield MULTIPLE client events — an assistant message can
      // carry both text and in-line tool_use blocks.
      for (const event of this.transformToClientEvent(message)) {
        this.emit("event", event);
      }
    } catch (err) {
      console.error("Failed to parse stream line:", line, err);
      this.emit("parse_error", { type: "parse_error", line, error: err });
    }
  }

  static readonly MAX_BUFFER = 4 * 1024 * 1024; // 4 MiB

  private transformToClientEvent(message: StreamMessage): ClientEvent[] {
    const timestamp = new Date().toISOString();

    switch (message.type) {
      // Handle system init event
      case "system": {
        const sysMsg = message as StreamMessageSystem;
        if (sysMsg.subtype === "init") {
          return [
            {
              type: "init",
              sessionId: this.sessionId,
              timestamp,
              data: { claudeSessionId: sysMsg.session_id || "" },
            },
          ];
        }
        return [];
      }

      // Handle assistant message (actual Claude response). Claude emits tool calls
      // as `tool_use` blocks INSIDE the content array (not as top-level messages),
      // so surface BOTH the text and a tool_start per tool_use block — otherwise
      // all tool activity is invisible to clients.
      case "assistant": {
        const assistantMsg = message as StreamMessageAssistant;
        const msg = assistantMsg.message;
        if (!msg?.content) return [];

        const events: ClientEvent[] = [];

        const textBlocks = msg.content
          .filter((c) => c.type === "text" && c.text)
          .map((c) => c.text || "");
        if (textBlocks.length > 0) {
          events.push({
            type: "text",
            sessionId: this.sessionId,
            timestamp,
            data: {
              role: msg.role || "assistant",
              text: textBlocks.join(""),
              content: msg.content.filter(
                (c): c is TextContent => c.type === "text" && !!c.text
              ),
            },
          });
        }

        for (const c of msg.content) {
          if (c.type === "tool_use") {
            const tool = c as unknown as ToolUseContent;
            events.push({
              type: "tool_start",
              sessionId: this.sessionId,
              timestamp,
              data: { toolName: tool.name, input: tool.input },
            });
          }
        }

        return events;
      }

      // Legacy message format (if used)
      case "message": {
        const content = (message as StreamMessageContent).content;
        if (!content) return [];

        const textBlocks = content
          .filter(
            (c): c is TextContent =>
              c.type === "text" && typeof c.text === "string"
          )
          .map((c) => c.text);

        if (textBlocks.length > 0) {
          return [
            {
              type: "text",
              sessionId: this.sessionId,
              timestamp,
              data: {
                role: (message as StreamMessageContent).role,
                text: textBlocks.join(""),
                content,
              },
            },
          ];
        }
        return [];
      }

      case "tool_use":
        return [
          {
            type: "tool_start",
            sessionId: this.sessionId,
            timestamp,
            data: {
              toolName: message.tool_name,
              input: message.tool_input,
            },
          },
        ];

      case "tool_result":
        return [
          {
            type: "tool_end",
            sessionId: this.sessionId,
            timestamp,
            data: {
              toolName: message.tool_name,
              output: message.output,
              status: message.status,
            },
          },
        ];

      case "result": {
        const resultMsg = message as StreamMessageResult;
        if (resultMsg.subtype === "success" || resultMsg.status === "success") {
          return [
            {
              type: "complete",
              sessionId: this.sessionId,
              timestamp,
              data: {
                durationMs: resultMsg.duration_ms,
                output: resultMsg.result || resultMsg.output,
              },
            },
          ];
        }
        return [
          {
            type: "error",
            sessionId: this.sessionId,
            timestamp,
            data: {
              error: resultMsg.error || "Unknown error",
            },
          },
        ];
      }

      default:
        return [];
    }
  }
}
