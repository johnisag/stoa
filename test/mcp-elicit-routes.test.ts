/**
 * MCP elicitation routes (#48) — drive the real route handlers against the real
 * in-memory store. Covers: localhost-gated create + fail-closed validation, the
 * operator answer path (accept coerces + validates server-side), and the TOCTOU
 * guard (a second/stale answer is refused with 409).
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  POST as createElicit,
  GET as listElicit,
} from "@/app/api/mcp/elicit/route";
import { GET as pollElicit } from "@/app/api/mcp/elicit/[id]/route";
import { POST as answerElicit } from "@/app/api/mcp/elicit/[id]/answer/route";
import { _resetElicitStore } from "@/lib/mcp/elicit-store";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function req(body: unknown, opts?: { local?: boolean }): any {
  const h = new Map<string, string>();
  if (opts?.local) h.set("x-stoa-remote-addr", "127.0.0.1");
  return {
    headers: { get: (k: string) => h.get(k.toLowerCase()) ?? null },
    json: async () => body,
  };
}
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

const REQ = {
  conductorId: "sess-1",
  message: "Pick a target",
  fields: [
    { key: "target", type: "enum", enumValues: ["staging", "prod"] },
    { key: "count", type: "number" },
  ],
};

beforeEach(() => _resetElicitStore());

async function create(body: unknown, local = true) {
  const res = await createElicit(req(body, { local }));
  return { status: res.status, body: await res.json() };
}

describe("POST /api/mcp/elicit (create)", () => {
  it("rejects a non-localhost caller", async () => {
    const res = await createElicit(req(REQ, { local: false }));
    expect(res.status).toBe(403);
  });

  it("creates a pending request from localhost and lists it", async () => {
    const c = await create(REQ);
    expect(c.status).toBe(201);
    expect(typeof c.body.elicitationId).toBe("string");

    const listRes = await listElicit();
    const list = await listRes.json();
    expect(list.elicitations).toHaveLength(1);
    expect(list.elicitations[0]).toMatchObject({
      message: "Pick a target",
      conductorId: "sess-1",
    });
  });

  it("fails closed on a malformed schema (400)", async () => {
    const c = await create({
      conductorId: "s",
      message: "m",
      fields: [{ key: "a", type: "object" }], // unknown type
    });
    expect(c.status).toBe(400);
  });

  it("requires a conductorId (400)", async () => {
    const c = await create({
      message: "m",
      fields: [{ key: "a", type: "string" }],
    });
    expect(c.status).toBe(400);
  });
});

describe("POST /api/mcp/elicit/[id]/answer", () => {
  it("accepts a coerced answer, then the poll sees it answered", async () => {
    const c = await create(REQ);
    const id = c.body.elicitationId;

    const ans = await answerElicit(
      req({ action: "accept", values: { target: "prod", count: "7" } }),
      ctx(id)
    );
    expect(ans.status).toBe(200);

    const pollRes = await pollElicit(req({}, { local: true }), ctx(id));
    const poll = await pollRes.json();
    expect(poll).toMatchObject({
      status: "answered",
      action: "accept",
      content: { target: "prod", count: 7 }, // "7" coerced to number
    });
  });

  it("rejects an out-of-enum / blank-number answer (400, server re-validates)", async () => {
    const c = await create(REQ);
    const id = c.body.elicitationId;
    const bad = await answerElicit(
      req({ action: "accept", values: { target: "evil", count: "" } }),
      ctx(id)
    );
    expect(bad.status).toBe(400);
  });

  it("refuses a second answer with 409 (TOCTOU / answer-once)", async () => {
    const c = await create(REQ);
    const id = c.body.elicitationId;
    const first = await answerElicit(req({ action: "cancel" }), ctx(id));
    expect(first.status).toBe(200);
    const second = await answerElicit(req({ action: "decline" }), ctx(id));
    expect(second.status).toBe(409);
  });

  it("refuses answering an unknown id (409) and a bad action (400)", async () => {
    const unknown = await answerElicit(
      req({ action: "accept", values: {} }),
      ctx("nope")
    );
    expect(unknown.status).toBe(409);
    const c = await create(REQ);
    const badAction = await answerElicit(
      req({ action: "sudo" }),
      ctx(c.body.elicitationId)
    );
    expect(badAction.status).toBe(400);
  });
});
