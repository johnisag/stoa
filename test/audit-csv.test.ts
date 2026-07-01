import { describe, it, expect } from "vitest";
import { eventsToCsv, csvField, type AuditCsvRow } from "@/lib/audit/csv";
import type { SessionEvent } from "@/lib/db/types";

const ev = (over: Partial<AuditCsvRow>): AuditCsvRow => ({
  id: 1,
  session_key: "claude-abc",
  event_type: "input_text" as SessionEvent["event_type"],
  payload: null,
  created_at: 0,
  ...over,
});

describe("csvField — RFC-4180 escaping", () => {
  it("passes through a plain value unquoted", () => {
    expect(csvField("hello")).toBe("hello");
    expect(csvField(42)).toBe("42");
    expect(csvField(null)).toBe("");
    expect(csvField(undefined)).toBe("");
  });

  it("quote-wraps and doubles quotes for comma/quote/newline", () => {
    expect(csvField("a,b")).toBe('"a,b"');
    expect(csvField('she said "hi"')).toBe('"she said ""hi"""');
    expect(csvField("line1\nline2")).toBe('"line1\nline2"');
    expect(csvField("cr\rlf")).toBe('"cr\rlf"');
  });
});

describe("csvField — CSV formula-injection guard (OWASP)", () => {
  it("prefixes a leading = + - @ with a single quote so it can't evaluate", () => {
    expect(csvField("=SUM(A1:A9)")).toBe("'=SUM(A1:A9)");
    expect(csvField("+1+1")).toBe("'+1+1");
    expect(csvField("-2+3")).toBe("'-2+3");
    expect(csvField("@cmd")).toBe("'@cmd");
  });

  it("neutralizes a leading tab/CR (spreadsheet formula leads) too", () => {
    expect(csvField("\t=evil")).toBe("'\t=evil");
    expect(csvField("\r=evil")).toBe(`"'\r=evil"`); // guard THEN quote (contains CR)
  });

  it("guards a dangerous lead that ALSO needs quoting (e.g. a comma)", () => {
    // =cmd(),x → guard to '=cmd(),x → then quote-wrap for the comma
    expect(csvField("=cmd(),x")).toBe(`"'=cmd(),x"`);
  });

  it("leaves a safe value that merely CONTAINS = alone", () => {
    expect(csvField("a=b")).toBe("a=b");
  });
});

describe("eventsToCsv", () => {
  it("emits a header row then one CRLF-joined line per event", () => {
    const csv = eventsToCsv([
      ev({ id: 7, event_type: "session_create", created_at: 0 }),
    ]);
    const lines = csv.split("\r\n");
    expect(lines[0]).toBe(
      "id,created_at,created_at_iso,session_key,session_name,event_type,payload"
    );
    expect(lines[1]).toContain(
      "7,0,1970-01-01T00:00:00.000Z,claude-abc,,session_create,"
    );
    expect(lines).toHaveLength(2);
  });

  it("renders session_name when enriched, empty when absent", () => {
    const withName = eventsToCsv([ev({ session_name: "My Agent" })]);
    expect(withName.split("\r\n")[1]).toContain(",My Agent,");
    const without = eventsToCsv([ev({ session_name: null })]);
    expect(without.split("\r\n")[1]).toContain("claude-abc,,input_text");
  });

  it("escapes a hostile payload (formula + comma + quote) safely in one cell", () => {
    const csv = eventsToCsv([
      ev({ event_type: "input_text", payload: '=HYPERLINK("x"),y' }),
    ]);
    const row = csv.split("\r\n")[1];
    // formula-guarded ('=…) AND quote-wrapped (comma) AND internal quotes doubled
    expect(row).toContain(`"'=HYPERLINK(""x""),y"`);
  });

  it("empty input → header only", () => {
    expect(eventsToCsv([]).split("\r\n")).toHaveLength(1);
  });
});
