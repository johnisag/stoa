/**
 * Webhook signature verification helpers.
 *
 * Two flavours:
 *   - verifyStoaSignature  — native Stoa events (X-Stoa-Signature: <hex>)
 *                            Also requires X-Stoa-Timestamp (Unix seconds) and
 *                            includes it in the HMAC input to prevent replay attacks.
 *   - verifyGitHubSignature — GitHub webhooks  (X-Hub-Signature-256: sha256=<hex>)
 *
 * Both use HMAC-SHA256 + timingSafeEqual so the check is constant-time.
 */

import { createHmac, timingSafeEqual } from "crypto";

/** Returns the webhook secret from env, or null if unset / empty. */
export function getWebhookSecret(): string | null {
  const v = process.env.STOA_WEBHOOK_SECRET;
  return v && v.length > 0 ? v : null;
}

/** Maximum clock skew tolerated for native Stoa timestamp validation (5 min). */
const TIMESTAMP_TOLERANCE_S = 300;

/** SHA-256 hex strings are always exactly 64 lowercase hex characters. */
const HEX_64_RE = /^[0-9a-f]{64}$/i;

function hmacHex(secret: string, data: string): string {
  return createHmac("sha256", secret).update(data).digest("hex");
}

function safeCompareHex(expected: string, candidate: string): boolean {
  // Validate candidate is a proper 64-char hex string before Buffer conversion.
  // Buffer.from(str, "hex") silently truncates on invalid chars, which would
  // produce a different-length buffer and cause timingSafeEqual to throw.
  if (!HEX_64_RE.test(candidate)) return false;
  try {
    return timingSafeEqual(
      Buffer.from(expected, "hex"),
      Buffer.from(candidate, "hex")
    );
  } catch {
    return false;
  }
}

/**
 * Verify a native Stoa webhook signature.
 *
 * Expects:
 *   X-Stoa-Timestamp: <unix-seconds>  — must be within 5 minutes of now.
 *   X-Stoa-Signature: <hex>           — HMAC-SHA256(<timestamp>.<body>, secret)
 *
 * The timestamp is included in the HMAC input so replay attacks are
 * impossible even if a signed payload is captured from logs.
 *
 * @param body      Raw request body string.
 * @param signature Hex digest from the X-Stoa-Signature header.
 * @param secret    The shared HMAC secret.
 * @param timestamp Value of the X-Stoa-Timestamp header (Unix seconds as string).
 */
export function verifyStoaSignature(
  body: string,
  signature: string,
  secret: string,
  timestamp: string
): boolean {
  if (!signature || !timestamp) return false;

  // Validate and check timestamp to reject stale / replayed requests.
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  if (Math.abs(Date.now() / 1000 - ts) > TIMESTAMP_TOLERANCE_S) return false;

  // HMAC input: "<timestamp>.<body>" — same convention as Stripe / Svix.
  const expected = hmacHex(secret, `${timestamp}.${body}`);
  return safeCompareHex(expected, signature);
}

/**
 * Verify a GitHub-style HMAC signature.
 *
 * GitHub sends `X-Hub-Signature-256: sha256=<hex>`.  We also accept a bare
 * hex string (no prefix) so native callers can reuse this path.
 *
 * @param body      Raw request body string.
 * @param signature Value of the X-Hub-Signature-256 header.
 * @param secret    The shared HMAC secret.
 */
export function verifyGitHubSignature(
  body: string,
  signature: string,
  secret: string
): boolean {
  if (!signature) return false;
  // Strip the optional "sha256=" prefix.
  const hex = signature.startsWith("sha256=")
    ? signature.slice("sha256=".length)
    : signature;
  // After stripping, an empty string means the header was just "sha256=" with
  // nothing following — that's invalid.
  if (!hex) return false;
  const expected = hmacHex(secret, body);
  return safeCompareHex(expected, hex);
}
