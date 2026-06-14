/**
 * Regression for B017: DevServerCard parsed the JSON-encoded `ports` column
 * with a bare `JSON.parse(server.ports || "[]")` in the render body. A
 * malformed DB value ("null", partial JSON, a non-array, a JSON object) either
 * threw — crashing the card and the whole parent list during render — or
 * returned a non-array that later blew up on `ports[0]`.
 *
 * The fix extracts a pure `parsePorts` helper that never throws and always
 * returns a clean numeric array. These tests cover the malformed shapes that
 * previously crashed and confirm the happy path still works.
 */
import { describe, it, expect } from "vitest";
import { parsePorts } from "@/components/DevServers/DevServerCard";

describe("parsePorts — B017 defensive JSON parsing", () => {
  it("parses a well-formed JSON port array", () => {
    expect(parsePorts("[3000, 5173]")).toEqual([3000, 5173]);
  });

  it("returns [] for null/undefined/empty string", () => {
    expect(parsePorts(null)).toEqual([]);
    expect(parsePorts(undefined)).toEqual([]);
    expect(parsePorts("")).toEqual([]);
  });

  it('returns [] for the literal "null" (previously parsed to a non-array)', () => {
    // JSON.parse("null") === null, which is not an array; old code would then
    // crash on ports[0]. The helper must coerce this to [].
    expect(parsePorts("null")).toEqual([]);
  });

  it("returns [] for partial/invalid JSON instead of throwing", () => {
    expect(() => parsePorts("[3000,")).not.toThrow();
    expect(parsePorts("[3000,")).toEqual([]);
    expect(parsePorts("not json")).toEqual([]);
  });

  it("returns [] for a JSON object (valid JSON, wrong shape)", () => {
    expect(parsePorts('{"port":3000}')).toEqual([]);
  });

  it("filters out non-number entries from a mixed array", () => {
    expect(parsePorts('[3000, "8080", null, 5173]')).toEqual([3000, 5173]);
  });
});
