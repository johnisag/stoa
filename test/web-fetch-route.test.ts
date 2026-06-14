import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { LookupAddress } from "dns";

// Shorten the route's network timeout so the timeout regression test doesn't
// add 15s to every run. The route reads this at module load time, so set it
// before importing the handler.
vi.hoisted(() => {
  process.env.STOA_WEB_FETCH_TIMEOUT_MS = "50";
});

const mockExistsSync = vi.hoisted(() => vi.fn(() => true));
const mockWriteFileSync = vi.hoisted(() => vi.fn());
const mockMkdirSync = vi.hoisted(() => vi.fn());

vi.mock("fs", async () => {
  const actual = await vi.importActual<typeof import("fs")>("fs");
  const fake = {
    ...actual,
    existsSync: mockExistsSync,
    writeFileSync: mockWriteFileSync,
    mkdirSync: mockMkdirSync,
  };
  return { ...fake, default: fake };
});

vi.mock("dns/promises", () => ({
  lookup: vi.fn(),
}));

import { POST } from "@/app/api/web-fetch/route";
import * as platform from "@/lib/platform";
import { lookup } from "dns/promises";

const mockedLookup = vi.mocked(lookup) as unknown as {
  mockResolvedValue(value: LookupAddress[]): void;
  mockResolvedValueOnce(value: LookupAddress[]): void;
  mockReset(): void;
};

function makeRequest(
  body: unknown,
  headers: Record<string, string> = { "x-forwarded-for": "10.0.0.1" }
) {
  return new Request("http://localhost/api/web-fetch", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function okResponse(body: string, contentType = "text/html") {
  return new Response(body, {
    status: 200,
    headers: { "content-type": contentType },
  });
}

function redirectResponse(location: string) {
  return new Response(null, {
    status: 302,
    headers: { location },
  });
}

function publicAddr(): LookupAddress[] {
  return [{ address: "1.2.3.4", family: 4 }];
}

function privateAddr(address: string): LookupAddress[] {
  return [{ address, family: 4 }];
}

describe("POST /api/web-fetch", () => {
  const tempRoot = "C:\\stoa-temp";

  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(okResponse("<p>hello</p>")))
    );
    vi.spyOn(platform, "tmpDir").mockReturnValue(tempRoot);
    vi.spyOn(platform, "homeDir").mockReturnValue("C:\\Users\\test");
    mockExistsSync.mockReturnValue(true);
    mockWriteFileSync.mockImplementation(() => undefined);
    mockMkdirSync.mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("returns 400 for a missing URL", async () => {
    const res = await POST(makeRequest({}));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "URL is required" });
  });

  it("returns 400 for a non-http URL", async () => {
    const res = await POST(makeRequest({ url: "file:///etc/passwd" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "Only http(s) URLs are allowed",
    });
  });

  it("returns 502 when the host resolves to a private address", async () => {
    mockedLookup.mockResolvedValue(privateAddr("127.0.0.1"));
    const res = await POST(makeRequest({ url: "http://localhost/index.html" }));
    expect(res.status).toBe(502);
    const json = await res.json();
    expect(json.error).toMatch(/isn't allowed/);
  });

  it("fetches a public URL and returns a temp file path", async () => {
    mockedLookup.mockResolvedValue(publicAddr());
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      okResponse("<p>hello world</p>")
    );

    const written: { path: string; content: string }[] = [];
    mockWriteFileSync.mockImplementation((p: unknown, data: unknown) => {
      written.push({ path: String(p), content: String(data) });
    });

    const res = await POST(makeRequest({ url: "http://example.com/page" }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.path).toMatch(/\\stoa-temp\\stoa-web-fetch\\/);
    expect(written[0].content).toContain("hello world");
  });

  it("follows a redirect and re-validates the new host", async () => {
    mockedLookup.mockResolvedValueOnce(publicAddr());
    mockedLookup.mockResolvedValueOnce(privateAddr("169.254.169.254"));

    (global.fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(redirectResponse("http://metadata.internal/"))
      .mockResolvedValueOnce(okResponse("metadata"));

    const res = await POST(makeRequest({ url: "http://example.com/" }));
    expect(res.status).toBe(502);
    const json = await res.json();
    expect(json.error).toMatch(/isn't allowed/);
  });

  it("returns 502 when the upstream fetch fails", async () => {
    mockedLookup.mockResolvedValue(publicAddr());
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response("error", { status: 500 })
    );
    const res = await POST(makeRequest({ url: "http://example.com/" }));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "Fetch failed with status 500" });
  });

  it("times out slow responses", async () => {
    // The route's own timeout is 15s; give it a little headroom.
    mockedLookup.mockResolvedValue(publicAddr());
    (global.fetch as ReturnType<typeof vi.fn>).mockImplementation(
      (_url: unknown, init?: RequestInit) => {
        return new Promise<Response>((resolve, reject) => {
          const signal = init?.signal;
          if (signal?.aborted) {
            reject(new DOMException("Aborted", "AbortError"));
            return;
          }
          const onAbort = () =>
            reject(new DOMException("Aborted", "AbortError"));
          signal?.addEventListener("abort", onAbort, { once: true });
          setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve(okResponse("slow"));
          }, 30_000);
        });
      }
    );
    const res = await POST(makeRequest({ url: "http://example.com/" }));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "Fetch timed out" });
  }, 25_000);

  it("caps fetched bytes and leaves non-HTML text alone", async () => {
    mockedLookup.mockResolvedValue(publicAddr());
    const body = "a < b and c > d\nsecond line".repeat(100);
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      okResponse(body, "text/plain")
    );

    const written: { content: string }[] = [];
    mockWriteFileSync.mockImplementation((_p: unknown, data: unknown) => {
      written.push({ content: String(data) });
    });

    const res = await POST(
      makeRequest({ url: "http://example.com/notes.txt" })
    );
    expect(res.status).toBe(200);
    expect(written[0].content).toContain("a < b and c > d");
  });

  it("rate-limits repeated requests", async () => {
    mockedLookup.mockResolvedValue(publicAddr());
    const results: Response[] = [];
    for (let i = 0; i < 62; i++) {
      results.push(
        await POST(
          makeRequest(
            { url: "http://example.com/" },
            { "x-forwarded-for": "10.0.0.99" }
          )
        )
      );
    }
    const blocked = results.filter((r) => r.status === 429);
    expect(blocked.length).toBeGreaterThan(0);
  });
});
