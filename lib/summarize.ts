// Pure helpers for summarizing a session transcript. No I/O and no node
// builtins, so they are unit-testable and safe to share between the
// fork-and-summarize POST and the read-only digest GET. The route owns the side
// effects (reading the JSONL off disk, spawning `claude -p`, the fork); this
// file owns the parsing, the prompt text, and the post-processing.

/**
 * Flatten a Claude Code session JSONL transcript into a plain "User: ... /
 * Assistant: ..." conversation. Mirrors the extraction the summarize route used
 * inline: user messages (string or stringified content) and assistant TEXT
 * blocks only -- tool calls and thinking are dropped. Malformed lines are
 * skipped. Returns "" when nothing usable is found.
 */
export function parseClaudeTranscript(jsonl: string): string {
  const lines = jsonl.trim().split("\n");
  const messages: string[] = [];

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);

      // User messages -- content is either a raw string or a structured array.
      if (entry.type === "user" && entry.message?.content) {
        const content =
          typeof entry.message.content === "string"
            ? entry.message.content
            : JSON.stringify(entry.message.content);
        messages.push(`User: ${content}`);
      }

      // Assistant text responses (skip tool calls and thinking).
      if (entry.type === "assistant" && Array.isArray(entry.message?.content)) {
        const textBlocks = entry.message.content
          .filter((block: { type: string }) => block.type === "text")
          .map((block: { text: string }) => block.text)
          .join("\n");
        if (textBlocks) {
          messages.push(`Assistant: ${textBlocks}`);
        }
      }
    } catch {
      // Skip malformed lines
    }
  }

  return messages.join("\n\n");
}

/**
 * The text of the LAST assistant turn in a parsed Claude Code transcript, as the
 * agent's own markdown (not the hard-wrapped terminal render). `entries` is the
 * array of parsed JSONL objects (one per line). Mirrors parseClaudeTranscript's
 * extraction: only assistant TEXT blocks count (tool calls + thinking are
 * dropped) and sidechain (Task sub-agent) turns are skipped so the result is the
 * main thread's reply, not a sub-agent's. Walks from the end and returns the
 * first qualifying turn's joined text, or "" when none is found. Pure →
 * unit-testable; the route owns reading the JSONL and parsing the lines.
 */
export function lastAssistantText(entries: unknown[]): string {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i] as {
      type?: string;
      isSidechain?: boolean;
      message?: { content?: unknown };
    } | null;
    if (!entry || entry.type !== "assistant" || entry.isSidechain) continue;
    const content = entry.message?.content;
    if (!Array.isArray(content)) continue;
    const text = content
      .filter(
        (block): block is { type: string; text: string } =>
          !!block &&
          typeof block === "object" &&
          (block as { type?: unknown }).type === "text" &&
          typeof (block as { text?: unknown }).text === "string"
      )
      .map((block) => block.text)
      .join("\n");
    if (text.trim()) return text;
  }
  return "";
}

/** The instruction handed to `claude -p` over the conversation (on stdin). */
export function buildSummaryPrompt(): string {
  return `Summarize this Claude Code conversation in under 300 words. Focus on: what was built, key files changed, current state, and any pending work. Be specific.`;
}

// C0 control chars + DEL, but NOT tab (0x09) or newline (0x0a) -- a digest
// legitimately contains those. The range is split around tab/newline so they
// survive while CR, ESC, and the rest are neutralized. Built from an escaped
// string so the source carries no raw control bytes.
const DIGEST_CONTROL_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f]/g;

/**
 * Clean a generated digest for display/transport. Normalizes newlines, strips C0
 * control chars and DEL (keeping the LF + tab a digest legitimately needs), and
 * trims the ends. Defense-in-depth: the digest is read-only here, but the same
 * text could later be injected into a prompt where a stray ESC/CR is a
 * keystroke-injection vector (see lib/path-display.ts).
 */
export function sanitizeDigest(text: string): string {
  return text
    .replace(/\r\n?/g, "\n") // normalize CRLF / lone CR to LF
    .replace(DIGEST_CONTROL_CHARS, "")
    .trim();
}
