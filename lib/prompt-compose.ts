/**
 * Pure helpers for the full-screen prompt composer (send-now mode). Kept free of
 * React/DOM/server imports so they're safe to use from a client component and
 * easy to unit-test. The composer sends straight to the active terminal, so it
 * trims surrounding whitespace and normalizes line endings to LF — a stray CR
 * from a paste would otherwise submit the prompt mid-stream.
 */

/** Trim surrounding whitespace and normalize CRLF/CR line endings to LF. */
export function normalizeForSend(text: string): string {
  return text.replace(/\r\n?/g, "\n").trim();
}

/** Whether `text` has any content worth sending (after normalization). */
export function isSendable(text: string): boolean {
  return normalizeForSend(text).length > 0;
}
