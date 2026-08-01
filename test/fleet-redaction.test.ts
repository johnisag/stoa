import { describe, expect, it } from "vitest";
import { FLEET_REDACTED_VALUE, redactFleetText } from "@/lib/fleet/redaction";

describe("Fleet durable-content redaction", () => {
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
});
