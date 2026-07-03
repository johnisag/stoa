/**
 * MCP elicitation (#48) — the fail-closed schema for an agent's structured
 * request for operator input. An MCP tool (`request_operator_input`) describes a
 * small form as a FLAT list of primitive fields (string / number / boolean /
 * enum, the 2025-11 spec's primitive set); Stoa renders it in the operator's
 * confirm surface and returns typed answers.
 *
 * Everything here is an ALLOWLIST — an untrusted/confused agent cannot smuggle a
 * hostile schema (nested objects, unknown types, oversized/injected keys) past
 * validateFields, and coerceAnswer re-clamps every submitted value server-side
 * so the browser form is never trusted. Pure (no I/O) → unit-tested.
 */

export type ElicitFieldType = "string" | "number" | "boolean" | "enum";

export interface ElicitField {
  /** Stable identifier (also the answer key). Safe-charset only. */
  key: string;
  type: ElicitFieldType;
  /** Human label / hint shown next to the control. */
  description?: string;
  /** Allowed values — REQUIRED for `enum`, ignored otherwise. */
  enumValues?: string[];
}

/** A validated, well-formed elicitation request. */
export interface ElicitRequest {
  message: string;
  fields: ElicitField[];
}

/** One coerced answer value — always one of the primitive types. */
export type ElicitValue = string | number | boolean;

// Caps — a hostile/confused agent can't flood or bloat the form.
export const MAX_FIELDS = 12;
export const MAX_KEY_LEN = 64;
export const MAX_MESSAGE_LEN = 2000;
export const MAX_DESCRIPTION_LEN = 500;
export const MAX_STRING_ANSWER_LEN = 4000;
export const MAX_ENUM_VALUES = 24;
export const MAX_ENUM_VALUE_LEN = 200;

const KEY_RE = /^[A-Za-z0-9_.-]+$/;
// Reserved property names — a field keyed like this is a validate/coerce
// inconsistency (its accept path can never succeed) and pointlessly touches the
// prototype chain, so reject it up front.
const RESERVED_KEYS: ReadonlySet<string> = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);
const FIELD_TYPES: ReadonlySet<string> = new Set([
  "string",
  "number",
  "boolean",
  "enum",
]);

export type ValidateResult =
  { ok: true; request: ElicitRequest } | { ok: false; error: string };

/**
 * Validate a raw tool payload into a well-formed ElicitRequest, or reject with a
 * reason. Rejects anything not on the allowlist: missing/oversized message,
 * non-array/empty/too-many fields, bad keys, unknown types, duplicate keys, and
 * an enum without a valid (non-empty, bounded) value list.
 */
export function validateFields(raw: unknown): ValidateResult {
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, error: "request must be an object" };
  }
  const obj = raw as Record<string, unknown>;

  if (typeof obj.message !== "string" || !obj.message.trim()) {
    return { ok: false, error: "message is required" };
  }
  if (obj.message.length > MAX_MESSAGE_LEN) {
    return { ok: false, error: `message exceeds ${MAX_MESSAGE_LEN} chars` };
  }

  if (!Array.isArray(obj.fields) || obj.fields.length === 0) {
    return { ok: false, error: "fields must be a non-empty array" };
  }
  if (obj.fields.length > MAX_FIELDS) {
    return { ok: false, error: `too many fields (max ${MAX_FIELDS})` };
  }

  const seen = new Set<string>();
  const fields: ElicitField[] = [];
  for (const rawField of obj.fields) {
    if (typeof rawField !== "object" || rawField === null) {
      return { ok: false, error: "each field must be an object" };
    }
    const f = rawField as Record<string, unknown>;

    if (typeof f.key !== "string" || !f.key.trim()) {
      return { ok: false, error: "each field needs a non-empty key" };
    }
    if (f.key.length > MAX_KEY_LEN || !KEY_RE.test(f.key)) {
      return {
        ok: false,
        error: `field key "${f.key.slice(0, 32)}" must match ${KEY_RE} and be ≤ ${MAX_KEY_LEN} chars`,
      };
    }
    if (RESERVED_KEYS.has(f.key)) {
      return { ok: false, error: `field key "${f.key}" is reserved` };
    }
    if (seen.has(f.key)) {
      return { ok: false, error: `duplicate field key "${f.key}"` };
    }
    seen.add(f.key);

    if (typeof f.type !== "string" || !FIELD_TYPES.has(f.type)) {
      return {
        ok: false,
        error: `field "${f.key}" has an unsupported type (allowed: string, number, boolean, enum)`,
      };
    }
    const type = f.type as ElicitFieldType;

    const field: ElicitField = { key: f.key, type };

    if (f.description !== undefined) {
      if (typeof f.description !== "string") {
        return {
          ok: false,
          error: `field "${f.key}" description must be a string`,
        };
      }
      field.description = f.description.slice(0, MAX_DESCRIPTION_LEN);
    }

    if (type === "enum") {
      if (
        !Array.isArray(f.enumValues) ||
        f.enumValues.length === 0 ||
        f.enumValues.length > MAX_ENUM_VALUES
      ) {
        return {
          ok: false,
          error: `enum field "${f.key}" needs 1–${MAX_ENUM_VALUES} enumValues`,
        };
      }
      const values: string[] = [];
      for (const v of f.enumValues) {
        if (typeof v !== "string" || !v.trim()) {
          return {
            ok: false,
            error: `enum field "${f.key}" values must be non-empty strings`,
          };
        }
        if (v.length > MAX_ENUM_VALUE_LEN) {
          return { ok: false, error: `enum field "${f.key}" value too long` };
        }
        values.push(v);
      }
      // Reject duplicate options — an ambiguous picker is a malformed schema.
      if (new Set(values).size !== values.length) {
        return {
          ok: false,
          error: `enum field "${f.key}" has duplicate values`,
        };
      }
      field.enumValues = values;
    }

    fields.push(field);
  }

  return { ok: true, request: { message: obj.message, fields } };
}

export type CoerceResult =
  | { ok: true; content: Record<string, ElicitValue> }
  | { ok: false; error: string };

/**
 * Re-clamp operator-submitted values against the validated field set — the
 * browser form is never trusted. Every field must have a well-typed value:
 * strings are length-capped, numbers must be finite, booleans coerced, and an
 * enum value must be one of the declared options. A missing/invalid value fails
 * closed (the whole answer is rejected) rather than silently dropping a field.
 */
export function coerceAnswer(
  fields: ElicitField[],
  rawValues: unknown
): CoerceResult {
  if (typeof rawValues !== "object" || rawValues === null) {
    return { ok: false, error: "values must be an object" };
  }
  const values = rawValues as Record<string, unknown>;
  const content: Record<string, ElicitValue> = {};

  for (const field of fields) {
    const v = values[field.key];
    switch (field.type) {
      case "string": {
        if (typeof v !== "string") {
          return { ok: false, error: `field "${field.key}" must be a string` };
        }
        content[field.key] = v.slice(0, MAX_STRING_ANSWER_LEN);
        break;
      }
      case "number": {
        // Reject empty/whitespace explicitly — Number("") is 0, which would let
        // a blank form field silently answer 0 (the browser sends raw strings).
        if (typeof v === "boolean" || (typeof v === "string" && !v.trim())) {
          return { ok: false, error: `field "${field.key}" must be a number` };
        }
        const n = typeof v === "number" ? v : Number(v);
        if (!Number.isFinite(n)) {
          return { ok: false, error: `field "${field.key}" must be a number` };
        }
        content[field.key] = n;
        break;
      }
      case "boolean": {
        if (typeof v !== "boolean") {
          return { ok: false, error: `field "${field.key}" must be a boolean` };
        }
        content[field.key] = v;
        break;
      }
      case "enum": {
        if (typeof v !== "string" || !(field.enumValues ?? []).includes(v)) {
          return {
            ok: false,
            error: `field "${field.key}" must be one of its allowed values`,
          };
        }
        content[field.key] = v;
        break;
      }
    }
  }

  return { ok: true, content };
}
