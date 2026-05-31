/**
 * Conversation export — pure, deterministic formatters that turn a session +
 * its stored messages into Markdown or JSON for download.
 *
 * Kept free of Date.now()/IO so the output is a deterministic function of its
 * inputs (easy to unit-test). The route layer adds download headers; this module
 * only builds the string.
 *
 * `Message.content` is a JSON-encoded array of content blocks (e.g.
 * `[{ "type": "text", "text": "..." }]`, and possibly tool_use/tool_result
 * blocks). We render text verbatim and represent non-text blocks compactly,
 * tolerating malformed/legacy content (a non-JSON string is used as-is).
 */

import type { Message, Session } from "./db";

export type ExportFormat = "md" | "json";

interface ContentBlock {
  type?: string;
  text?: string;
  name?: string;
  [key: string]: unknown;
}

/** Parse a stored `content` string into blocks; tolerate non-JSON/legacy values. */
function parseBlocks(content: string): ContentBlock[] {
  try {
    const parsed = JSON.parse(content);
    if (Array.isArray(parsed)) return parsed as ContentBlock[];
    // A bare string or object that happens to be valid JSON — wrap as text.
    if (typeof parsed === "string") return [{ type: "text", text: parsed }];
    return [parsed as ContentBlock];
  } catch {
    // Not JSON (older rows stored a raw string) — treat the whole thing as text.
    return [{ type: "text", text: content }];
  }
}

/** Flatten content blocks to a plain-text/markdown string. */
function blocksToText(content: string): string {
  return parseBlocks(content)
    .map((b) => {
      // A blocks array may contain non-object/null elements (arbitrary stored
      // JSON) — never deref blindly.
      if (b == null || typeof b !== "object") {
        return "\n```json\n" + JSON.stringify(b, null, 2) + "\n```\n";
      }
      if (typeof b.text === "string" && (b.type === "text" || b.type == null)) {
        return b.text;
      }
      if (b.type === "tool_use") {
        // Strip backticks so a tool name can't break the inline code span.
        const name = String(b.name ?? "?").replace(/`/g, "");
        return `\n\`[tool: ${name}]\`\n`;
      }
      if (b.type === "tool_result") return `\n\`[tool result]\`\n`;
      // Unknown block — keep its JSON so nothing is silently lost.
      return "\n```json\n" + JSON.stringify(b, null, 2) + "\n```\n";
    })
    .join("")
    .trim();
}

const ROLE_HEADING: Record<Message["role"], string> = {
  user: "User",
  assistant: "Assistant",
};

/** Render a session + messages as a Markdown transcript. */
export function conversationToMarkdown(
  session: Session,
  messages: Message[]
): string {
  const lines: string[] = [];
  lines.push(`# ${session.name || session.id}`);
  lines.push("");
  lines.push(`- **Agent:** ${session.agent_type}`);
  lines.push(`- **Model:** ${session.model || "(default)"}`);
  lines.push(`- **Directory:** ${session.working_directory}`);
  lines.push(`- **Created:** ${session.created_at}`);
  if (session.system_prompt) {
    lines.push("");
    lines.push("## System prompt");
    lines.push("");
    lines.push(session.system_prompt.trim());
  }
  lines.push("");
  lines.push("---");

  if (messages.length === 0) {
    lines.push("");
    lines.push("_No messages recorded for this session._");
    return lines.join("\n") + "\n";
  }

  for (const m of messages) {
    lines.push("");
    lines.push(`## ${ROLE_HEADING[m.role] ?? m.role}`);
    lines.push("");
    lines.push(blocksToText(m.content));
  }
  return lines.join("\n") + "\n";
}

/** Render a session + messages as a pretty-printed JSON document. */
export function conversationToJSON(
  session: Session,
  messages: Message[]
): string {
  return (
    JSON.stringify(
      {
        session: {
          id: session.id,
          name: session.name,
          agent_type: session.agent_type,
          model: session.model || null,
          working_directory: session.working_directory,
          created_at: session.created_at,
          system_prompt: session.system_prompt,
        },
        messages: messages.map((m) => ({
          role: m.role,
          timestamp: m.timestamp,
          duration_ms: m.duration_ms,
          content: parseBlocks(m.content),
        })),
      },
      null,
      2
    ) + "\n"
  );
}

/** Slugify a session name into a safe, cross-platform download filename stem. */
export function exportFileStem(session: Session): string {
  const base = (session.name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  // Empty or unusable (all-punctuation) names both fall back to a recognizable
  // session-<id> stem rather than a bare id.
  return base || `session-${session.id}`;
}

/** Build the full export document + its download metadata for a format. */
export function buildExport(
  session: Session,
  messages: Message[],
  format: ExportFormat
): { body: string; contentType: string; filename: string } {
  if (format === "json") {
    return {
      body: conversationToJSON(session, messages),
      contentType: "application/json; charset=utf-8",
      filename: `${exportFileStem(session)}.json`,
    };
  }
  return {
    body: conversationToMarkdown(session, messages),
    contentType: "text/markdown; charset=utf-8",
    filename: `${exportFileStem(session)}.md`,
  };
}
