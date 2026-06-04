/**
 * Sanitize an untrusted string before it goes into a user-facing notification —
 * the Web Push body (lib/push) or the in-app toast/Notification title
 * (hooks/useNotifications). Session names are user/agent-controlled and can carry
 * terminal artifacts: ANSI escape codes, box-drawing borders (│ ─ ┌ ┘ █), and
 * control chars. A Windows notification renders those as "strange cut vertical
 * lines" / tofu, not the glyph — so a name derived from a captured prompt-box
 * line turns the whole toast into garbage. We strip those, collapse whitespace,
 * and cap the length so a notification always reads as clean text.
 *
 * Pure + node-free so it runs identically on the server (push path) and the
 * client (in-app path) — and is trivially unit-testable.
 *
 * Implemented as a code-point scan (not a regex with literal control bytes) so
 * the source stays plain ASCII and the intent of each range is explicit.
 *
 * NOTE: legitimate printable Unicode (accents, CJK, emoji — "café", "日本語",
 * "🚀") is kept; toasts render those fine. We strip only the genuinely garbling
 * ranges, not all non-ASCII, so an international session name still shows.
 */

const ESC = 0x1b;
const BEL = 0x07;

/** True for code points that are invisible/junk — dropped entirely (no space). */
function isRemovable(cp: number): boolean {
  return (
    cp === 0x00ad || // soft hyphen
    (cp >= 0x200b && cp <= 0x200f) || // zero-width space/joiners + LRM/RLM marks
    (cp >= 0x202a && cp <= 0x202e) || // bidi embeddings/overrides (U+202E flips text)
    cp === 0x2060 || // word joiner
    (cp >= 0x2066 && cp <= 0x2069) || // bidi isolates
    cp === 0xfeff || // BOM / zero-width no-break space
    cp === 0xfffd // Unicode replacement char (already-mojibake'd input)
  );
}

/** True for code points that garble a toast — replaced with a space separator. */
function isSeparator(cp: number): boolean {
  return (
    cp <= 0x1f || // C0 control chars (incl. tab/newline; ESC handled separately)
    (cp >= 0x7f && cp <= 0x9f) || // DEL + C1 control chars
    cp === 0x2028 || // line separator (renders as a break, splits the toast)
    cp === 0x2029 || // paragraph separator
    (cp >= 0x2500 && cp <= 0x259f) // box-drawing + block elements (the "lines")
  );
}

export function sanitizeNotificationText(
  raw: string,
  opts: { maxLen?: number; fallback?: string } = {}
): string {
  const { maxLen = 80, fallback = "" } = opts;
  if (typeof raw !== "string") return fallback;

  // Code-point aware (Array.from splits on code points, so astral chars/emoji
  // stay intact instead of being torn into lone surrogates).
  const chars = Array.from(raw);
  let out = "";
  for (let i = 0; i < chars.length; i++) {
    const cp = chars[i].codePointAt(0) ?? 0;

    // Drop a whole ANSI escape sequence: CSI (ESC [ … final 0x40-0x7E), OSC
    // (ESC ] … BEL | ESC \), or a lone/other ESC. Leaves a space in its place.
    if (cp === ESC) {
      const next = chars[i + 1]?.codePointAt(0);
      if (next === 0x5b) {
        i++; // consume '['
        while (i + 1 < chars.length) {
          const c = chars[i + 1].codePointAt(0) ?? 0;
          i++;
          if (c >= 0x40 && c <= 0x7e) break; // CSI final byte
        }
      } else if (next === 0x5d) {
        i++; // consume ']'
        while (i + 1 < chars.length) {
          const c = chars[i + 1].codePointAt(0) ?? 0;
          i++;
          if (c === BEL) break;
          if (c === ESC && chars[i + 1]?.codePointAt(0) === 0x5c) {
            i++; // consume the '\' of the ST terminator
            break;
          }
        }
      } else if (
        next !== undefined &&
        next !== ESC &&
        next >= 0x20 &&
        next <= 0x7e
      ) {
        i++; // two-char escape (e.g. ESC c = RIS) — drop ESC + its final byte
      }
      // else: lone ESC / ESC+ESC / ESC+control — drop only this ESC; the next
      // iteration re-evaluates what follows (a second ESC starts a fresh seq, so
      // "ESC ESC [0m" doesn't leak the "[0m"). ESC at end-of-string lands here too.
      out += " ";
      continue;
    }

    if (isSeparator(cp)) {
      out += " ";
      continue;
    }
    if (isRemovable(cp)) continue;
    out += chars[i];
  }

  const cleaned = out.replace(/ +/g, " ").trim();
  if (!cleaned) return fallback;
  // Cap by CODE POINT, not UTF-16 unit — a plain slice could bisect a surrogate
  // pair and leave a lone surrogate (tofu) at the boundary.
  const cp = Array.from(cleaned);
  return cp.length > maxLen ? cp.slice(0, maxLen).join("").trim() : cleaned;
}
