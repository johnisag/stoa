/**
 * Bounded-pattern redaction for Fleet content that is about to become durable.
 *
 * This is defense in depth, not a credential detector or permission boundary.
 * Fleet callers must redact before applying any cap and must avoid collecting
 * secrets in the first place. The rules intentionally target
 * credential-shaped values and named assignments without redacting Git SHAs or
 * ordinary hashes used by Fleet's exact-head evidence.
 */

export const FLEET_REDACTED_VALUE = "[REDACTED]";

export interface FleetRedactionResult {
  text: string;
  redacted: boolean;
  replacementCount: number;
}

export interface FleetCappedRedactionResult extends FleetRedactionResult {
  truncated: boolean;
}

type Replacement = (...match: string[]) => string;

function replaceAndCount(
  input: string,
  pattern: RegExp,
  replacement: string | Replacement
): { text: string; count: number } {
  let count = 0;
  const text = input.replace(pattern, (...args: unknown[]) => {
    count++;
    if (typeof replacement === "string") return replacement;
    const captures = args.slice(0, -2).map(String);
    return replacement(...captures);
  });
  return { text, count };
}

/** Redact credential-shaped content while preserving useful surrounding text. */
export function redactFleetText(value: string): FleetRedactionResult {
  let text = value;
  let replacementCount = 0;
  const apply = (pattern: RegExp, replacement: string | Replacement) => {
    const result = replaceAndCount(text, pattern, replacement);
    text = result.text;
    replacementCount += result.count;
  };

  apply(
    /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    FLEET_REDACTED_VALUE
  );
  apply(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*$/g, FLEET_REDACTED_VALUE);
  apply(/\bstoa_fleet_v1_[A-Za-z0-9_-]{43}\b/g, FLEET_REDACTED_VALUE);
  apply(/\bsk-(?:ant-)?[A-Za-z0-9_-]{16,}\b/g, FLEET_REDACTED_VALUE);
  apply(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, FLEET_REDACTED_VALUE);
  apply(/\bxox[baprs]-[A-Za-z0-9-]{16,}\b/g, FLEET_REDACTED_VALUE);
  apply(/\bAKIA[0-9A-Z]{16}\b/g, FLEET_REDACTED_VALUE);
  apply(/\bAIza[0-9A-Za-z_-]{20,}\b/g, FLEET_REDACTED_VALUE);
  apply(
    /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    FLEET_REDACTED_VALUE
  );
  apply(
    /\bBearer\s+[A-Za-z0-9._~+/-]{16,}={0,2}/gi,
    () => `Bearer ${FLEET_REDACTED_VALUE}`
  );
  apply(
    /(https?:\/\/)([^/\s:@]+):([^@\s/]+)@/gi,
    (_match, scheme) => `${scheme}${FLEET_REDACTED_VALUE}@`
  );

  const secretName =
    "(?:api[_-]?key|access[_-]?token|auth[_-]?token|secret|password|passwd|private[_-]?key|client[_-]?secret)";
  apply(
    new RegExp(`(\\b${secretName}\\b\\s*[:=]\\s*)(["'])(.{6,}?)(\\2)`, "gi"),
    (_match, prefix, quote) =>
      `${prefix}${quote}${FLEET_REDACTED_VALUE}${quote}`
  );
  apply(
    new RegExp(
      `(\\b${secretName}\\b\\s*[:=]\\s*)(?!\\[REDACTED\\])([^\\s,;}{\\]"']{6,})`,
      "gi"
    ),
    (_match, prefix) => `${prefix}${FLEET_REDACTED_VALUE}`
  );

  return {
    text,
    redacted: replacementCount > 0,
    replacementCount,
  };
}

/**
 * Redact the complete value before applying a UTF-8 byte cap. Redacting first is
 * important: truncating a credential-shaped value can otherwise turn it into a
 * partial secret that no longer matches the redaction rules.
 */
export function redactAndCapFleetText(
  value: string,
  maxBytes: number
): FleetCappedRedactionResult {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new Error("Fleet redaction byte cap must be a non-negative integer");
  }
  const redacted = redactFleetText(value);
  const encoded = Buffer.from(redacted.text, "utf8");
  if (encoded.byteLength <= maxBytes) {
    return { ...redacted, truncated: false };
  }
  let end = maxBytes;
  while (end > 0 && (encoded[end] & 0xc0) === 0x80) end--;
  return {
    ...redacted,
    text: encoded.subarray(0, end).toString("utf8"),
    truncated: true,
  };
}
