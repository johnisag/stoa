import { describe, expect, it } from "vitest";
import {
  FLEET_REDACTED_VALUE,
  redactAndCapFleetText,
  redactFleetText,
} from "@/lib/fleet/redaction";

describe("Fleet durable-content redaction", () => {
  it("is idempotent for already-redacted named assignments", () => {
    const once = redactFleetText(
      "password=sk-ABCDEFGHIJKLMNOPQRST api_key=[REDACTED]"
    ).text;
    const twice = redactFleetText(once).text;
    expect(once).toBe("password=[REDACTED] api_key=[REDACTED]");
    expect(twice).toBe(once);
  });

  it("redacts named credentials and common token formats", () => {
    const secrets = [
      "api_key=top-secret-value",
      'password: "correct horse battery staple"',
      `Authorization: Bearer ${"a".repeat(32)}`,
      `token ${`stoa_fleet_v1_${"A".repeat(43)}`}`,
      `github=${`ghp_${"b".repeat(36)}`}`,
      `openai=${`sk-${"c".repeat(32)}`}`,
      "url=https://alice:hunter2@example.test/repo.git",
    ].join("\n");

    const result = redactFleetText(secrets);

    expect(result.redacted).toBe(true);
    expect(result.replacementCount).toBeGreaterThanOrEqual(7);
    expect(result.text).not.toContain("top-secret-value");
    expect(result.text).not.toContain("correct horse battery staple");
    expect(result.text).not.toContain("hunter2");
    expect(result.text).not.toContain("stoa_fleet_v1_");
    expect(result.text).toContain(FLEET_REDACTED_VALUE);
  });

  it("redacts complete private-key blocks across lines", () => {
    const key = [
      "before",
      "-----BEGIN PRIVATE KEY-----",
      "not-real-private-material",
      "-----END PRIVATE KEY-----",
      "after",
    ].join("\n");

    expect(redactFleetText(key).text).toBe(
      `before\n${FLEET_REDACTED_VALUE}\nafter`
    );
  });

  it("redacts an unterminated private key through end of input", () => {
    const input = [
      "safe prefix",
      "-----BEGIN OPENSSH PRIVATE KEY-----",
      "partial-secret-material",
    ].join("\n");

    expect(redactFleetText(input).text).toBe(
      `safe prefix\n${FLEET_REDACTED_VALUE}`
    );
  });

  it("preserves exact Git SHA evidence and ordinary prose", () => {
    const sha1 = "a".repeat(40);
    const sha256 = "b".repeat(64);
    const input = `Verified ${sha1} with evidence ${sha256}. No credentials.`;

    expect(redactFleetText(input)).toEqual({
      text: input,
      redacted: false,
      replacementCount: 0,
    });
  });

  it("redacts before a UTF-8 byte cap and never persists a partial secret", () => {
    const secret = `api_key=${"s".repeat(300)}`;
    const result = redactAndCapFleetText(`before ${secret} after 😀`, 32);

    expect(result.redacted).toBe(true);
    expect(result.truncated).toBe(true);
    expect(result.text).toContain("api_key=[REDACTED]");
    expect(result.text).not.toContain("ssss");

    const unicode = redactAndCapFleetText("😀😀", 5);
    expect(unicode.text).toBe("😀");
    expect(Buffer.byteLength(unicode.text, "utf8")).toBeLessThanOrEqual(5);
  });
});
