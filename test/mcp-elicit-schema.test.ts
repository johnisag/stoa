/**
 * MCP elicitation schema (#48) — fail-closed contract. validateFields is an
 * ALLOWLIST: a hostile/confused agent cannot smuggle an over-large or malformed
 * form past it; coerceAnswer re-clamps every submitted value server-side so the
 * browser form is never trusted.
 */
import { describe, it, expect } from "vitest";
import {
  validateFields,
  coerceAnswer,
  MAX_FIELDS,
  MAX_MESSAGE_LEN,
  type ElicitField,
} from "@/lib/mcp/elicit-schema";

describe("validateFields", () => {
  it("accepts a well-formed multi-type request", () => {
    const r = validateFields({
      message: "Pick a deploy target",
      fields: [
        { key: "target", type: "enum", enumValues: ["staging", "prod"] },
        { key: "notes", type: "string", description: "Anything to add?" },
        { key: "count", type: "number" },
        { key: "confirm", type: "boolean" },
      ],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.request.fields).toHaveLength(4);
      expect(r.request.fields[0]).toMatchObject({
        key: "target",
        type: "enum",
        enumValues: ["staging", "prod"],
      });
    }
  });

  it("rejects a missing/blank message", () => {
    expect(validateFields({ fields: [{ key: "a", type: "string" }] }).ok).toBe(
      false
    );
    expect(
      validateFields({ message: "   ", fields: [{ key: "a", type: "string" }] })
        .ok
    ).toBe(false);
  });

  it("rejects an oversized message", () => {
    const r = validateFields({
      message: "x".repeat(MAX_MESSAGE_LEN + 1),
      fields: [{ key: "a", type: "string" }],
    });
    expect(r.ok).toBe(false);
  });

  it("rejects empty / too-many fields", () => {
    expect(validateFields({ message: "m", fields: [] }).ok).toBe(false);
    const many = Array.from({ length: MAX_FIELDS + 1 }, (_, i) => ({
      key: `k${i}`,
      type: "string" as const,
    }));
    expect(validateFields({ message: "m", fields: many }).ok).toBe(false);
  });

  it("rejects a bad key, unknown type, and duplicate keys", () => {
    expect(
      validateFields({ message: "m", fields: [{ key: "a b", type: "string" }] })
        .ok
    ).toBe(false); // space in key
    expect(
      validateFields({ message: "m", fields: [{ key: "a", type: "object" }] })
        .ok
    ).toBe(false); // unknown type
    expect(
      validateFields({
        message: "m",
        fields: [
          { key: "a", type: "string" },
          { key: "a", type: "number" },
        ],
      }).ok
    ).toBe(false); // duplicate key
  });

  it("rejects reserved property-name keys (__proto__/constructor/prototype)", () => {
    for (const key of ["__proto__", "constructor", "prototype"]) {
      expect(
        validateFields({ message: "m", fields: [{ key, type: "string" }] }).ok
      ).toBe(false);
    }
  });

  it("rejects an enum without valid values (and dedupes-check)", () => {
    expect(
      validateFields({ message: "m", fields: [{ key: "a", type: "enum" }] }).ok
    ).toBe(false); // no enumValues
    expect(
      validateFields({
        message: "m",
        fields: [{ key: "a", type: "enum", enumValues: [] }],
      }).ok
    ).toBe(false); // empty
    expect(
      validateFields({
        message: "m",
        fields: [{ key: "a", type: "enum", enumValues: ["x", "x"] }],
      }).ok
    ).toBe(false); // duplicates
  });

  it("truncates an over-long description rather than rejecting", () => {
    const r = validateFields({
      message: "m",
      fields: [{ key: "a", type: "string", description: "d".repeat(9999) }],
    });
    expect(r.ok).toBe(true);
    if (r.ok)
      expect(r.request.fields[0].description!.length).toBeLessThan(9999);
  });
});

describe("coerceAnswer", () => {
  const fields: ElicitField[] = [
    { key: "notes", type: "string" },
    { key: "count", type: "number" },
    { key: "confirm", type: "boolean" },
    { key: "target", type: "enum", enumValues: ["staging", "prod"] },
  ];

  it("coerces each primitive to its declared type", () => {
    const r = coerceAnswer(fields, {
      notes: "hello",
      count: "42", // browser sends strings
      confirm: true,
      target: "prod",
    });
    expect(r.ok).toBe(true);
    if (r.ok)
      expect(r.content).toEqual({
        notes: "hello",
        count: 42,
        confirm: true,
        target: "prod",
      });
  });

  it("rejects a blank number (must not silently become 0)", () => {
    const r = coerceAnswer(fields, {
      notes: "",
      count: "",
      confirm: false,
      target: "staging",
    });
    expect(r.ok).toBe(false);
  });

  it("rejects an out-of-enum value", () => {
    const r = coerceAnswer(fields, {
      notes: "",
      count: 1,
      confirm: false,
      target: "evil",
    });
    expect(r.ok).toBe(false);
  });

  it("rejects a wrong-typed boolean and a non-object payload", () => {
    expect(
      coerceAnswer(fields, {
        notes: "",
        count: 1,
        confirm: "yes",
        target: "prod",
      }).ok
    ).toBe(false);
    expect(coerceAnswer(fields, null).ok).toBe(false);
  });

  it("caps an over-long string answer", () => {
    const r = coerceAnswer([{ key: "notes", type: "string" }], {
      notes: "x".repeat(100000),
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect((r.content.notes as string).length).toBeLessThan(100000);
  });
});
