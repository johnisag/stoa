/**
 * Agent-facing channel tools on the orchestration MCP server. Mocks the HTTP layer
 * (the handlers fetch /api/channels) and locks: channel_send POSTs {from,to,body}
 * with the caller's own session as `from`, channel_inbox PATCHes (consumes) and
 * renders full bodies, channel_history GETs the thread, a missing session id is
 * reported (no request), and a bad arg throws before any request.
 *
 * The caller's own session id is resolved like the conductor id: with no baked
 * CONDUCTOR_SESSION_ID/marker in the test env, an explicit `conductorId` arg
 * stands in (in production the baked id always wins, so an agent can't spoof its
 * own `from`).
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

describe("channel_send", () => {
  it("POSTs {from,to,body} with the caller as from", async () => {
    fetchMock.mockResolvedValueOnce({
      json: async () => ({ message: { id: "m1" } }),
    });
    const r = await call("channel_send", {
      conductorId: ME,
      to: "peer-1",
      message: "hello",
    });
    const f = firstFetch();
    expect(f.method).toBe("POST");
    expect(f.url).toContain("/api/channels");
    expect(f.body).toEqual({ from: ME, to: "peer-1", body: "hello" });
    expect(text(r)).toContain("Message sent to peer-1");
  });

  it("surfaces a send error (e.g. unknown recipient)", async () => {
    fetchMock.mockResolvedValueOnce({
      json: async () => ({ error: 'no session with id "ghost"' }),
    });
    const r = await call("channel_send", {
      conductorId: ME,
      to: "ghost",
      message: "hi",
    });
    expect(text(r)).toMatch(/Error:.*no session/);
  });

  it("throws for a missing message before any request", async () => {
    const r = await call("channel_send", { conductorId: ME, to: "peer-1" });
    expect(text(r)).toMatch(/message is required/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws for a missing to before any request", async () => {
    const r = await call("channel_send", { conductorId: ME, message: "hi" });
    expect(text(r)).toMatch(/to is required/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("errors clearly when the caller's own session id is unknown", async () => {
    const r = await call("channel_send", { to: "peer-1", message: "hi" });
    expect(text(r)).toMatch(/can't determine your own session id/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("channel_inbox", () => {
  it("PATCHes (consumes) and renders full bodies + the FULL sender id to reply to", async () => {
    const senderId = "11111111-2222-3333-4444-555555555555";
    fetchMock.mockResolvedValueOnce({
      json: async () => ({
        messages: [
          {
            from_session_id: senderId,
            body: "line one\nline two",
            created_at: "t",
          },
        ],
      }),
    });
    const r = await call("channel_inbox", { conductorId: ME });
    const f = firstFetch();
    expect(f.method).toBe("PATCH");
    expect(f.body).toEqual({ session: ME });
    const out = text(r);
    expect(out).toContain("1 new message");
    // The FULL sender id must be present — an agent replies with channel_send(to)
    // and a truncated prefix would fail the recipient-existence check.
    expect(out).toContain(`From ${senderId}`);
    expect(out).toContain("line one\nline two"); // full body, not collapsed
  });

  it("says so when the inbox is empty", async () => {
    fetchMock.mockResolvedValueOnce({ json: async () => ({ messages: [] }) });
    expect(text(await call("channel_inbox", { conductorId: ME }))).toMatch(
      /No new messages/
    );
  });
});

describe("channel_history", () => {
  it("GETs the thread for session+peer and labels your own lines", async () => {
    fetchMock.mockResolvedValueOnce({
      json: async () => ({
        messages: [
          { from_session_id: ME, body: "mine" },
          { from_session_id: "peer-1", body: "theirs" },
        ],
      }),
    });
    const r = await call("channel_history", {
      conductorId: ME,
      peer: "peer-1",
    });
    const f = firstFetch();
    expect(f.method).toBe("GET");
    expect(f.url).toContain(`session=${encodeURIComponent(ME)}`);
    expect(f.url).toContain("peer=peer-1");
    const out = text(r);
    expect(out).toContain("you: mine");
    expect(out).toContain("peer-1: theirs"); // short id label, not "you"
  });

  it("reports an empty thread without erroring", async () => {
    fetchMock.mockResolvedValueOnce({ json: async () => ({ messages: [] }) });
    const r = await call("channel_history", {
      conductorId: ME,
      peer: "peer-1",
    });
    expect(text(r)).toMatch(/No messages with peer-1/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("throws for a missing peer before any request", async () => {
    const r = await call("channel_history", { conductorId: ME });
    expect(text(r)).toMatch(/peer is required/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
