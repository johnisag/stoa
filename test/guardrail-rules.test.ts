import { describe, it, expect } from "vitest";
import {
  validateRule,
  validateRules,
  RuleValidationError,
} from "../lib/guardrail-rules";

describe("validateRule", () => {
  const validRule = {
    id: "no-git-push",
    description: "Block all git push",
    pattern: "git\\s+push",
    severity: "block" as const,
  };

  it("accepts a valid rule", () => {
    const result = validateRule(validRule);
    expect(result.id).toBe("no-git-push");
    expect(result.severity).toBe("block");
  });

  it("accepts optional scanLines", () => {
    const result = validateRule({ ...validRule, scanLines: 5 });
    expect(result.scanLines).toBe(5);
  });

  it("throws for non-object", () => {
    expect(() => validateRule(null)).toThrow(RuleValidationError);
    expect(() => validateRule("string")).toThrow(RuleValidationError);
  });

  it("throws for empty or invalid id", () => {
    expect(() => validateRule({ ...validRule, id: "" })).toThrow(
      RuleValidationError
    );
    expect(() => validateRule({ ...validRule, id: "Has Spaces" })).toThrow(
      RuleValidationError
    );
    expect(() => validateRule({ ...validRule, id: "UPPER" })).toThrow(
      RuleValidationError
    );
  });

  it("throws for empty description", () => {
    expect(() => validateRule({ ...validRule, description: "" })).toThrow(
      RuleValidationError
    );
  });

  it("throws for empty or invalid pattern", () => {
    expect(() => validateRule({ ...validRule, pattern: "" })).toThrow(
      RuleValidationError
    );
    expect(() => validateRule({ ...validRule, pattern: "[unclosed" })).toThrow(
      RuleValidationError
    );
  });

  it("throws for invalid severity", () => {
    expect(() => validateRule({ ...validRule, severity: "critical" })).toThrow(
      RuleValidationError
    );
  });

  it("throws for scanLines out of range", () => {
    expect(() => validateRule({ ...validRule, scanLines: 0 })).toThrow(
      RuleValidationError
    );
    expect(() => validateRule({ ...validRule, scanLines: 101 })).toThrow(
      RuleValidationError
    );
    expect(() => validateRule({ ...validRule, scanLines: "abc" })).toThrow(
      RuleValidationError
    );
  });

  it("rejects excessively long fields", () => {
    expect(() => validateRule({ ...validRule, id: "a".repeat(65) })).toThrow(
      RuleValidationError
    );
    expect(() =>
      validateRule({ ...validRule, description: "x".repeat(201) })
    ).toThrow(RuleValidationError);
    expect(() =>
      validateRule({ ...validRule, pattern: "x".repeat(501) })
    ).toThrow(RuleValidationError);
  });
});

describe("validateRules", () => {
  it("accepts an empty array", () => {
    expect(validateRules([])).toEqual([]);
  });

  it("accepts an array of valid rules", () => {
    const rules = [
      { id: "rule-1", description: "Test 1", pattern: "foo", severity: "warn" },
      {
        id: "rule-2",
        description: "Test 2",
        pattern: "bar",
        severity: "block",
      },
    ];
    expect(validateRules(rules)).toHaveLength(2);
  });

  it("throws for non-array", () => {
    expect(() => validateRules({})).toThrow(RuleValidationError);
    expect(() => validateRules("not an array")).toThrow(RuleValidationError);
  });

  it("throws when exceeding MAX_CUSTOM_RULES", () => {
    const rules = Array.from({ length: 51 }, (_, i) => ({
      id: `rule-${i}`,
      description: `Rule ${i}`,
      pattern: "foo",
      severity: "warn",
    }));
    expect(() => validateRules(rules)).toThrow(RuleValidationError);
  });
});
