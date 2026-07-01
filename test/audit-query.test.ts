import { describe, it, expect } from "vitest";
import {
  buildAuditSql,
  parseAuditParams,
  parseAuditFormat,
  AUDIT_EVENT_TYPES,
  AUDIT_LIMIT_DEFAULT,
  AUDIT_LIMIT_MAX,
  type AuditQuery,
} from "@/lib/audit/query";

// The audit read core: every user value must ride as a bound `?` placeholder (no SQL
// injection), unknown event types are dropped, and limit/offset clamp fail-safe.

const base: AuditQuery = { limit: 100, offset: 0 };

describe("buildAuditSql", () => {
  it("no filters → no WHERE, newest-first, LIMIT/OFFSET bound last", () => {
    const { sql, params, countSql, countParams } = buildAuditSql(base);
    expect(sql).not.toContain("WHERE");
    expect(sql).toContain("ORDER BY created_at DESC, id DESC");
    expect(sql).toContain("LIMIT ? OFFSET ?");
    expect(params).toEqual([100, 0]); // only limit+offset
    expect(countSql).toContain("COUNT(*)");
    expect(countSql).not.toContain("LIMIT");
    expect(countParams).toEqual([]); // count has no limit/offset
  });

  it("sessionKey → a bound equality, present in both data and count params", () => {
    const { sql, params, countParams } = buildAuditSql({
      ...base,
      sessionKey: "claude-abc",
    });
    expect(sql).toContain("session_key = ?");
    expect(params).toEqual(["claude-abc", 100, 0]);
    expect(countParams).toEqual(["claude-abc"]);
  });

  it("types → an IN list with one placeholder each (never interpolated)", () => {
    const { sql, params, countParams } = buildAuditSql({
      ...base,
      types: ["session_create", "input_enter"],
    });
    expect(sql).toContain("event_type IN (?, ?)");
    expect(params).toEqual(["session_create", "input_enter", 100, 0]);
    expect(countParams).toEqual(["session_create", "input_enter"]);
  });

  it("since/until → inclusive bounds; full filter param order is stable", () => {
    const { sql, params, countParams } = buildAuditSql({
      sessionKey: "k",
      types: ["input_text"],
      since: 1000,
      until: 2000,
      limit: 50,
      offset: 10,
    });
    expect(sql).toContain("created_at >= ?");
    expect(sql).toContain("created_at <= ?");
    // order: sessionKey, types…, since, until, then (data only) limit, offset
    expect(params).toEqual(["k", "input_text", 1000, 2000, 50, 10]);
    expect(countParams).toEqual(["k", "input_text", 1000, 2000]);
  });

  it("an empty types array is treated as no type filter", () => {
    const { sql } = buildAuditSql({ ...base, types: [] });
    expect(sql).not.toContain("event_type IN");
  });

  it("payloadCap → a substr in the SELECT, bound as the FIRST param", () => {
    const { sql, params, countParams } = buildAuditSql({
      ...base,
      payloadCap: 8192,
    });
    expect(sql).toContain("substr(payload, 1, ?) AS payload");
    expect(params).toEqual([8192, 100, 0]); // cap first, then limit, offset
    expect(countParams).toEqual([]); // count doesn't select payload → no cap param
  });

  it("payloadCap orders ahead of the WHERE params", () => {
    const { params, countParams } = buildAuditSql({
      sessionKey: "k",
      types: ["input_text"],
      since: 5,
      until: 9,
      limit: 20,
      offset: 3,
      payloadCap: 4096,
    });
    expect(params).toEqual([4096, "k", "input_text", 5, 9, 20, 3]);
    expect(countParams).toEqual(["k", "input_text", 5, 9]);
  });
});

describe("parseAuditParams", () => {
  const parse = (qs: string, key?: string) =>
    parseAuditParams(new URLSearchParams(qs), key);

  it("defaults: no filters, default limit, offset 0", () => {
    const { query, emptyByFilter } = parse("");
    expect(query).toEqual({
      sessionKey: undefined,
      types: undefined,
      since: undefined,
      until: undefined,
      limit: AUDIT_LIMIT_DEFAULT,
      offset: 0,
    });
    expect(emptyByFilter).toBe(false);
  });

  it("forces the route-supplied sessionKey onto the query", () => {
    expect(parse("", "claude-x").query.sessionKey).toBe("claude-x");
  });

  it("clamps limit: <1 → 1, over-max → max, NaN → default", () => {
    expect(parse("limit=0").query.limit).toBe(1);
    expect(parse("limit=-5").query.limit).toBe(1);
    expect(parse(`limit=${AUDIT_LIMIT_MAX + 1000}`).query.limit).toBe(
      AUDIT_LIMIT_MAX
    );
    expect(parse("limit=abc").query.limit).toBe(AUDIT_LIMIT_DEFAULT);
  });

  it("clamps offset: negative/NaN → 0", () => {
    expect(parse("offset=-3").query.offset).toBe(0);
    expect(parse("offset=xyz").query.offset).toBe(0);
    expect(parse("offset=25").query.offset).toBe(25);
  });

  it("keeps only VALID event types, drops the rest", () => {
    const { query, emptyByFilter } = parse(
      "types=input_enter,bogus,session_kill,DROP TABLE"
    );
    expect(query.types).toEqual(["input_enter", "session_kill"]);
    expect(emptyByFilter).toBe(false);
  });

  it("types present but ALL invalid → emptyByFilter (asked for nonexistent kinds)", () => {
    const { query, emptyByFilter } = parse("types=nope,not-a-kind");
    expect(query.types).toBeUndefined();
    expect(emptyByFilter).toBe(true);
  });

  it("dedupes repeated valid types (bounds the IN-arity / stmt-cache shapes)", () => {
    expect(parse("types=input_text,input_text,input_text").query.types).toEqual(
      ["input_text"]
    );
    // insertion order preserved, duplicate dropped
    expect(
      parse("types=input_enter,input_text,input_enter").query.types
    ).toEqual(["input_enter", "input_text"]);
  });

  it("parses since/until as epoch millis, ignores non-numeric", () => {
    expect(parse("since=1000&until=2000").query.since).toBe(1000);
    expect(parse("since=1000&until=2000").query.until).toBe(2000);
    expect(parse("since=notanumber").query.since).toBeUndefined();
  });
});

describe("parseAuditFormat", () => {
  it("maps csv/json, defaults to the in-app json envelope", () => {
    expect(parseAuditFormat("csv")).toBe("csv");
    expect(parseAuditFormat("json")).toBe("download-json");
    expect(parseAuditFormat(null)).toBe("json");
    expect(parseAuditFormat("weird")).toBe("json");
  });
});

describe("AUDIT_EVENT_TYPES", () => {
  it("lists every recorded kind (14), no duplicates", () => {
    expect(AUDIT_EVENT_TYPES).toHaveLength(14);
    expect(new Set(AUDIT_EVENT_TYPES).size).toBe(14);
  });
});
