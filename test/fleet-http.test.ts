import { describe, expect, it } from "vitest";
import { readCappedJsonBody } from "@/lib/fleet/http";

function requestWithBody(body: string, headers?: HeadersInit): Request {
  return new Request("http://local.test/api/fleet", {
    method: "POST",
    headers,
    body,
  });
}

describe("readCappedJsonBody", () => {
  it("parses JSON bodies within the byte cap", async () => {
    const result = await readCappedJsonBody(
      requestWithBody(JSON.stringify({ ok: true })),
      1024
    );

    expect(result).toEqual({ body: { ok: true } });
  });

  it("rejects bodies over the content-length cap before parsing", async () => {
    const result = await readCappedJsonBody(
      requestWithBody("{}", { "content-length": "2048" }),
      1024
    );

    expect(result).toEqual({ error: "Request body too large", status: 413 });
  });

  it("rejects streamed bodies that exceed the cap", async () => {
    const result = await readCappedJsonBody(
      requestWithBody(JSON.stringify({ body: "x".repeat(128) })),
      32
    );

    expect(result).toEqual({ error: "Request body too large", status: 413 });
  });

  it("rejects invalid JSON", async () => {
    const result = await readCappedJsonBody(requestWithBody("{"), 1024);

    expect(result).toEqual({ error: "Invalid JSON body", status: 400 });
  });
});
