// Pure helpers for AI-drafting a Conventional Commit message from a staged
// diff. No I/O and no node builtins, so they are unit-testable. The route owns
// the side effects (running `git diff --staged`, spawning `claude -p`); this
// file owns the diff-bounding, the prompt text, and post-processing the
// agent's reply into a single clean commit message.

import { formatTerminalTextForAgent } from "./path-display";

/**
 * A large staged diff can blow past the agent's context (and is slow), so we
 * bound it. The agent only needs to see enough to infer intent, not every line.
 */
export const MAX_DIFF_CHARS = 12000;

/**
 * Trim a diff to MAX_DIFF_CHARS (default), appending a clear truncation marker
 * so the agent knows the input was cut and doesn't try to enumerate every file.
 * Pure (no I/O) so it's unit-testable.
 */
export function boundDiff(diff: string, max = MAX_DIFF_CHARS): string {
  if (diff.length <= max) return diff;
  return `${diff.slice(0, max)}\n\n[diff truncated - ${diff.length - max} more characters omitted]`;
}

/**
 * The instruction handed to `claude -p` over the (bounded) staged diff on
 * stdin. Asks for a SINGLE Conventional Commit message and nothing else, so the
 * reply drops straight into the message box.
 */
export function buildCommitPrompt(diff: string): string {
  return [
    "You are writing a git commit message for the staged changes below.",
    "Respond with a SINGLE Conventional Commit message and NOTHING else - no",
    "preamble, no explanation, no code fences, no quotes.",
    "",
    "Format: a `type(scope): subject` header line (type is one of feat, fix,",
    "docs, style, refactor, perf, test, build, ci, chore; scope is optional;",
    "subject is imperative mood, lower-case, no trailing period, under 72",
    "chars). Add a blank line then a short body ONLY if the change needs",
    "explanation.",
    "",
    "Staged diff:",
    boundDiff(diff),
  ].join("\n");
}

/**
 * Clean the agent's reply into a usable commit message: normalize newlines,
 * strip control chars/DEL (keeping LF + tab), peel off any wrapping code fence
 * or surrounding quotes the model added despite instructions, collapse runs of
 * blank lines, and trim. Pure so it's unit-tested. Returns "" for empty/garbage.
 *
 * The control-char strip + CRLF normalize + trim reuse the shared, source-safe
 * `formatTerminalTextForAgent` (the same keystroke-injection guard the terminal
 * uses) so there's ONE sanitizer, not a second one to drift.
 */
export function cleanCommitMessage(raw: string): string {
  let text = formatTerminalTextForAgent(raw);

  // Strip a wrapping ```...``` code fence if the model added one.
  const fence = text.match(/^```[^\n]*\n([\s\S]*?)\n?```$/);
  if (fence) text = fence[1].trim();

  // Strip surrounding quotes (a single line wrapped in " or ').
  if (
    text.length >= 2 &&
    !text.includes("\n") &&
    ((text.startsWith('"') && text.endsWith('"')) ||
      (text.startsWith("'") && text.endsWith("'")))
  ) {
    text = text.slice(1, -1).trim();
  }

  // Collapse 3+ consecutive newlines down to the single blank line that
  // separates a Conventional Commit subject from its body.
  return text.replace(/\n{3,}/g, "\n\n").trim();
}
