/**
 * Agent-facing memory tools on the orchestration MCP server. Mocks the HTTP layer
 * (the handlers fetch /api/memory) and locks: memory_set/get/list/delete hit the
 * right method+path with an encoded key, a missing key reads as "(not set)" not an
 * error, an empty value is passed through (not defaulted), and a bad key throws
 * before any request (requireString).
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

/** The first fetch() invocation, parsed: { url, method, body }. */
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

describe("memory_set", () => {
  it("POSTs {key,value} to /api/memory and confirms", async () => {
    fetchMock.mockResolvedValueOnce({
      json: async () => ({ entry: { key: "k", value: "v" } }),
    });
    const r = await call("memory_set", { key: "k", value: "v" });
    const f = firstFetch();
    expect(f.method).toBe("POST");
    expect(f.url).toContain("/api/memory");
    expect(f.body).toEqual({ key: "k", value: "v" });
    expect(text(r)).toContain('Saved memory "k"');
  });

  it("passes an empty value through (does not default it)", async () => {
    fetchMock.mockResolvedValueOnce({ json: async () => ({ entry: {} }) });
    await call("memory_set", { key: "k", value: "" });
    expect(firstFetch().body).toEqual({ key: "k", value: "" });
  });

  it("throws (Error response) for a missing key before any request", async () => {
    const r = await call("memory_set", { value: "v" });
    expect(text(r)).toMatch(/key is required/);
    expect(fetchMock).not.toHaveBeenCalled(); // never hit the network
  });

  it("surfaces an API error", async () => {
    fetchMock.mockResolvedValueOnce({
      json: async () => ({ error: "value exceeds 100000 characters" }),
    });
    const r = await call("memory_set", { key: "k", value: "x" });
    expect(text(r)).toMatch(/Error: value exceeds/);
  });
});

describe("memory_get", () => {
  it("GETs the URL-encoded key and returns the value", async () => {
    fetchMock.mockResolvedValueOnce({
      json: async () => ({ entry: { key: "a b", value: "hello" } }),
    });
    const r = await call("memory_get", { key: "a b" });
    const f = firstFetch();
    expect(f.method).toBe("GET");
    expect(f.url).toContain("key=a%20b");
    expect(text(r)).toBe("a b: hello");
  });

  it("reads a missing key as '(not set)', not an error", async () => {
    fetchMock.mockResolvedValueOnce({
      json: async () => ({ error: "not found" }),
    });
    const r = await call("memory_get", { key: "missing" });
    expect(text(r)).toBe("missing: (not set)");
  });
});

describe("memory_list", () => {
  it("formats the entries", async () => {
    fetchMock.mockResolvedValueOnce({
      json: async () => ({
        entries: [
          { key: "a", value: "1" },
          { key: "b", value: "2" },
        ],
      }),
    });
    const r = await call("memory_list", {});
    expect(text(r)).toContain("- a: 1");
    expect(text(r)).toContain("- b: 2");
  });

  it("says so when empty", async () => {
    fetchMock.mockResolvedValueOnce({ json: async () => ({ entries: [] }) });
    expect(text(await call("memory_list", {}))).toMatch(/empty/i);
  });

  it("collapses a multi-line value to a one-line preview (list stays scannable)", async () => {
    fetchMock.mockResolvedValueOnce({
      json: async () => ({
        entries: [{ key: "k", value: "line one\nline two\nline three" }],
      }),
    });
    const out = text(await call("memory_list", {}));
    expect(out).toBe("Shared memory:\n- k: line one line two line three");
    expect(out).not.toContain("\nline two"); // not interleaved as fake list items
  });
});

describe("memory_delete", () => {
  it("DELETEs the key and reports removal", async () => {
    fetchMock.mockResolvedValueOnce({ json: async () => ({ removed: true }) });
    const r = await call("memory_delete", { key: "k" });
    const f = firstFetch();
    expect(f.method).toBe("DELETE");
    expect(f.url).toContain("key=k");
    expect(text(r)).toContain('Deleted memory "k"');
  });

  it("reports when there was nothing to delete", async () => {
    fetchMock.mockResolvedValueOnce({ json: async () => ({ removed: false }) });
    expect(text(await call("memory_delete", { key: "k" }))).toMatch(
      /No memory/
    );
  });
});
