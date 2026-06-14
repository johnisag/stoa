import { EventEmitter } from "events";
import type {
  StreamMessage,
  StreamMessageSystem,
  StreamMessageAssistant,
  StreamMessageContent,
  StreamMessageResult,
  ClientEvent,
  TextContent,
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

    // Normalize CRLF and lone CR to LF so NDJSON splits cleanly on all platforms.
    this.buffer = this.buffer.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

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
      const event = this.transformToClientEvent(message);
      if (event) {
        this.emit("event", event);
      }
    } catch (err) {
      console.error("Failed to parse stream line:", line, err);
      this.emit("parse_error", { type: "parse_error", line, error: err });
    }
  }

  static readonly MAX_BUFFER = 4 * 1024 * 1024; // 4 MiB

  private transformToClientEvent(message: StreamMessage): ClientEvent | null {
    const timestamp = new Date().toISOString();

    switch (message.type) {
      // Handle system init event
      case "system": {
        const sysMsg = message as StreamMessageSystem;
        if (sysMsg.subtype === "init") {
          return {
            type: "init",
            sessionId: this.sessionId,
            timestamp,
            data: { claudeSessionId: sysMsg.session_id || "" },
          };
        }
        return null;
      }

      // Handle assistant message (actual Claude response)
      case "assistant": {
        const assistantMsg = message as StreamMessageAssistant;
        const msg = assistantMsg.message;
        if (!msg?.content) return null;

        const textBlocks = msg.content
          .filter((c) => c.type === "text" && c.text)
          .map((c) => c.text || "");

        if (textBlocks.length > 0) {
          return {
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
          };
        }
        return null;
      }

      // Legacy message format (if used)
      case "message": {
        const content = (message as StreamMessageContent).content;
        if (!content) return null;

        const textBlocks = content
          .filter(
            (c): c is TextContent =>
              c.type === "text" && typeof c.text === "string"
          )
          .map((c) => c.text);

        if (textBlocks.length > 0) {
          return {
            type: "text",
            sessionId: this.sessionId,
            timestamp,
            data: {
              role: (message as StreamMessageContent).role,
              text: textBlocks.join(""),
              content,
            },
          };
        }
        return null;
      }

      case "tool_use":
        return {
          type: "tool_start",
          sessionId: this.sessionId,
          timestamp,
          data: {
            toolName: message.tool_name,
            input: message.tool_input,
          },
        };

      case "tool_result":
        return {
          type: "tool_end",
          sessionId: this.sessionId,
          timestamp,
          data: {
            toolName: message.tool_name,
            output: message.output,
            status: message.status,
          },
        };

      case "result": {
        const resultMsg = message as StreamMessageResult;
        if (resultMsg.subtype === "success" || resultMsg.status === "success") {
          return {
            type: "complete",
            sessionId: this.sessionId,
            timestamp,
            data: {
              durationMs: resultMsg.duration_ms,
              output: resultMsg.result || resultMsg.output,
            },
          };
        } else {
          return {
            type: "error",
            sessionId: this.sessionId,
            timestamp,
            data: {
              error: resultMsg.error || "Unknown error",
            },
          };
        }
      }

      default:
        return null;
    }
  }
}
