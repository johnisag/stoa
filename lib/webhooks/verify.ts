/**
 * Webhook signature verification helpers.
 *
 * All comparisons use timingSafeEqual to prevent timing-based secret extraction.
 * The raw request body MUST be read before JSON-parsing; signatures are computed
 * over the exact bytes the sender signed.
 */

import { createHmac, timingSafeEqual } from "crypto";

/** Read STOA_WEBHOOK_SECRET from the environment. Returns null if unset/empty. */
export function getWebhookSecret(): string | null {
  const s = process.env.STOA_WEBHOOK_SECRET;
  return s && s.length > 0 ? s : null;
}

/**
 * Verify a native Stoa signature.
 *
 * The sender computes: HMAC-SHA256(secret, body) → hex
 * and sends it in `X-Stoa-Signature`.
 */
export function verifyStoaSignature(
  body: string,
  signature: string,
  secret: string
): boolean {
  if (!signature) return false;
  const a = createHmac("sha256", secret).update(body).digest();
  const b = Buffer.from(signature, "hex");
  // Guard on decoded buffer lengths: invalid hex in `signature` produces a shorter
  // buffer than 32 bytes; timingSafeEqual throws on length mismatch, so check first.
  if (b.length !== 32 || a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Verify a GitHub webhook signature.
 *
 * GitHub sends: `sha256=<hex>` in `X-Hub-Signature-256`.
 * We strip the prefix and do the same HMAC-SHA256 comparison.
 */
export function verifyGitHubSignature(
  body: string,
  signature: string,
  secret: string
): boolean {
  if (!signature) return false;
  const hex = signature.startsWith("sha256=") ? signature.slice(7) : signature;
  if (hex.length === 0) return false;
  const a = createHmac("sha256", secret).update(body).digest();
  const b = Buffer.from(hex, "hex");
  if (b.length !== 32 || a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
