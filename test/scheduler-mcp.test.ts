/**
 * Agent-facing schedule tools on the orchestration MCP server. Mocks the HTTP
 * layer (the handlers fetch /api/schedules) and locks: schedule_create POSTs the
 * fields and defaults the target to the caller's own session, schedule_list
 * renders a scannable summary, schedule_delete hits the encoded id, and a bad arg
 * throws before any request.
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

const ME = "me-session-id";

describe("schedule_create", () => {
  it("POSTs the fields, defaulting the target to the caller's own session", async () => {
    fetchMock.mockResolvedValueOnce({
      json: async () => ({
        schedule: {
          id: "s1",
          recurrence: "daily",
          next_run_at: "2026-06-28T00:00:00.000Z",
        },
      }),
    });
    const r = await call("schedule_create", {
      conductorId: ME,
      prompt: "run tests",
      recurrence: "daily",
    });
    const f = firstFetch();
    expect(f.method).toBe("POST");
    expect(f.url).toContain("/api/schedules");
    expect(f.body).toMatchObject({
      sessionId: ME,
      prompt: "run tests",
      recurrence: "daily",
    });
    expect(text(r)).toContain("Scheduled (repeats daily)");
    expect(text(r)).toContain("s1");
  });

  it("uses an explicit sessionId over the caller's own", async () => {
    fetchMock.mockResolvedValueOnce({
      json: async () => ({
        schedule: { id: "s2", recurrence: null, next_run_at: "t" },
      }),
    });
    await call("schedule_create", {
      conductorId: ME,
      sessionId: "other",
      prompt: "p",
    });
    expect(firstFetch().body).toMatchObject({ sessionId: "other" });
  });

  it("throws for a missing prompt before any request", async () => {
    const r = await call("schedule_create", { conductorId: ME });
    expect(text(r)).toMatch(/prompt is required/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces an API error (e.g. unknown target session)", async () => {
    fetchMock.mockResolvedValueOnce({
      json: async () => ({ error: 'no session with id "x"' }),
    });
    const r = await call("schedule_create", {
      conductorId: ME,
      sessionId: "x",
      prompt: "p",
    });
    expect(text(r)).toMatch(/Error:.*no session with id/);
  });

  it("errors when there's no target session at all", async () => {
    const r = await call("schedule_create", { prompt: "p" });
    expect(text(r)).toMatch(/no target session/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("schedule_list", () => {
  it("renders a scannable summary with the FULL id (for schedule_delete), name + cadence", async () => {
    const fullId = "abcdef01-2345-6789-abcd-ef0123456789";
    fetchMock.mockResolvedValueOnce({
      json: async () => ({
        schedules: [
          {
            id: fullId,
            name: "nightly",
            session_id: "11112222",
            prompt: "nightly run",
            recurrence: "daily",
            next_run_at: "2026-06-28T00:00:00Z",
            enabled: 1,
          },
          {
            id: "feed",
            name: "",
            session_id: "x",
            prompt: "p",
            recurrence: null,
            next_run_at: "t",
            enabled: 0,
          },
        ],
      }),
    });
    const out = text(await call("schedule_list", {}));
    // FULL id, not an 8-char prefix — schedule_delete needs the complete id.
    expect(out).toContain(fullId);
    expect(out).toContain('"nightly"'); // the label
    expect(out).toContain("daily");
    expect(out).toContain("nightly run");
    expect(out).toContain("paused"); // a disabled schedule shows as paused
  });

  it("says so when there are none", async () => {
    fetchMock.mockResolvedValueOnce({ json: async () => ({ schedules: [] }) });
    expect(text(await call("schedule_list", {}))).toMatch(/No schedules/);
  });
});

describe("schedule_delete", () => {
  it("DELETEs the encoded id and reports removal", async () => {
    fetchMock.mockResolvedValueOnce({ json: async () => ({ removed: true }) });
    const r = await call("schedule_delete", { id: "a b" });
    const f = firstFetch();
    expect(f.method).toBe("DELETE");
    expect(f.url).toContain("/api/schedules/a%20b");
    expect(text(r)).toContain("Deleted schedule a b");
  });

  it("reports when there was nothing to delete", async () => {
    fetchMock.mockResolvedValueOnce({ json: async () => ({ removed: false }) });
    expect(text(await call("schedule_delete", { id: "x" }))).toMatch(
      /No schedule/
    );
  });

  it("throws for a missing id before any request", async () => {
    const r = await call("schedule_delete", {});
    expect(text(r)).toMatch(/id is required/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
