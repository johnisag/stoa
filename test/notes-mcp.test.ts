/**
 * Agent-facing notes tools on the orchestration MCP server. Mocks the HTTP layer
 * (the handlers fetch /api/notes) and locks: notes_list/get/write/delete hit the
 * right method + path (encoded id), notes_write creates without an id and updates
 * WITH one, a missing note reads sanely, and a bad id throws before any request.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { handleToolCall } from "../mcp/orchestration-tools";

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({ json: async () => ({}) });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const call = (name: string, args: Record<string, unknown>) =>
  handleToolCall({ params: { name, arguments: args } });
const text = (r: { content: { text: string }[] }) => r.content[0].text;

function firstFetch() {
  const [url, opts] = fetchMock.mock.calls[0] as [
    string,
    RequestInit | undefined,
  ];
  return {
    url,
    method: opts?.method ?? "GET",
    body: opts?.body ? JSON.parse(opts.body as string) : undefined,
  };
}

describe("notes_list", () => {
  it("formats id + title + a one-line preview", async () => {
    fetchMock.mockResolvedValueOnce({
      json: async () => ({
        notes: [
          { id: "abcdef0123", title: "Contract", content: "line\ntwo" },
          { id: "feed0000", title: "", content: "x" },
        ],
      }),
    });
    const out = text(await call("notes_list", {}));
    expect(out).toContain("abcdef01"); // 8-char id prefix
    expect(out).toContain("Contract: line two"); // multi-line collapsed
    expect(out).toContain("(untitled)"); // empty title placeholder
    expect(out).not.toContain("line\ntwo");
  });

  it("says so when there are no notes", async () => {
    fetchMock.mockResolvedValueOnce({ json: async () => ({ notes: [] }) });
    expect(text(await call("notes_list", {}))).toMatch(/no notes/i);
  });
});

describe("notes_get", () => {
  it("GETs the encoded id and returns the rendered note", async () => {
    fetchMock.mockResolvedValueOnce({
      json: async () => ({ note: { title: "T", content: "body" } }),
    });
    const r = await call("notes_get", { id: "a b" });
    const f = firstFetch();
    expect(f.method).toBe("GET");
    expect(f.url).toContain("/api/notes/a%20b");
    expect(text(r)).toBe("# T\n\nbody");
  });

  it("reports a missing note (no throw)", async () => {
    fetchMock.mockResolvedValueOnce({
      json: async () => ({ error: "not found" }),
    });
    expect(text(await call("notes_get", { id: "x" }))).toMatch(
      /No note with id/
    );
  });

  it("throws for a missing id before any request", async () => {
    const r = await call("notes_get", {});
    expect(text(r)).toMatch(/id is required/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("notes_write", () => {
  it("POSTs to /api/notes (create) when no id is given", async () => {
    fetchMock.mockResolvedValueOnce({
      json: async () => ({ note: { id: "new-1" } }),
    });
    const r = await call("notes_write", { title: "T", content: "C" });
    const f = firstFetch();
    expect(f.method).toBe("POST");
    expect(f.url).toContain("/api/notes");
    expect(f.body).toEqual({ title: "T", content: "C" });
    expect(text(r)).toContain("Created note new-1");
  });

  it("PATCHes /api/notes/[id] (update) when an id is given", async () => {
    fetchMock.mockResolvedValueOnce({
      json: async () => ({ note: { id: "abc" } }),
    });
    const r = await call("notes_write", { id: "abc", content: "C2" });
    const f = firstFetch();
    expect(f.method).toBe("PATCH");
    expect(f.url).toContain("/api/notes/abc");
    expect(text(r)).toContain("Updated note abc");
  });

  it("surfaces an update to a missing note", async () => {
    fetchMock.mockResolvedValueOnce({
      json: async () => ({ error: "not found" }),
    });
    expect(text(await call("notes_write", { id: "ghost" }))).toMatch(/Error:/);
  });
});

describe("notes_delete", () => {
  it("DELETEs the encoded id and reports removal", async () => {
    fetchMock.mockResolvedValueOnce({ json: async () => ({ removed: true }) });
    const r = await call("notes_delete", { id: "abc" });
    const f = firstFetch();
    expect(f.method).toBe("DELETE");
    expect(f.url).toContain("/api/notes/abc");
    expect(text(r)).toContain("Deleted note abc");
  });

  it("reports when there was nothing to delete", async () => {
    fetchMock.mockResolvedValueOnce({ json: async () => ({ removed: false }) });
    expect(text(await call("notes_delete", { id: "abc" }))).toMatch(/No note/);
  });
});
