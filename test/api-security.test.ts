import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { NextRequest } from "next/server";
import {
  parseJsonBody,
  clampInteger,
  sanitizeSessionName,
  sanitizeGroupPath,
  resolveSandboxedPath,
  tokenizeCommand,
  shellEscape,
  validateGitHubLabels,
  validateUploadMimeType,
  checkRateLimit,
  requireLocalhost,
} from "@/lib/api-security";

describe("parseJsonBody", () => {
  it("parses valid JSON", async () => {
    const req = new Request("http://localhost/api", {
      method: "POST",
      body: JSON.stringify({ foo: "bar" }),
    });
    const result = await parseJsonBody(req);
    expect(result).toEqual({ ok: true, data: { foo: "bar" } });
  });

  it("returns 400 on malformed JSON", async () => {
    const req = new Request("http://localhost/api", {
      method: "POST",
      body: "not json",
    });
    const result = await parseJsonBody(req);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(400);
      expect(await result.response.json()).toEqual({
        error: "Invalid JSON body",
      });
    }
  });
});

describe("clampInteger", () => {
  it("clamps numbers to bounds", () => {
    expect(clampInteger(5, 1, 10, 3)).toBe(5);
    expect(clampInteger(0, 1, 10, 3)).toBe(1);
    expect(clampInteger(15, 1, 10, 3)).toBe(10);
    expect(clampInteger(3.9, 1, 10, 3)).toBe(3);
  });

  it("parses strings", () => {
    expect(clampInteger("7", 1, 10, 3)).toBe(7);
    expect(clampInteger("abc", 1, 10, 3)).toBe(3);
  });

  it("rejects NaN and non-finite numbers", () => {
    expect(clampInteger(NaN, 1, 10, 3)).toBe(3);
    expect(clampInteger(Infinity, 1, 10, 3)).toBe(3);
    expect(clampInteger(null, 1, 10, 3)).toBe(3);
  });
});

describe("sanitizeSessionName", () => {
  it("trims and strips control characters", () => {
    expect(sanitizeSessionName("  hello\x00\nworld  ")).toBe("helloworld");
  });

  it("returns null for empty or invalid input", () => {
    expect(sanitizeSessionName("")).toBeNull();
    expect(sanitizeSessionName("   ")).toBeNull();
    expect(sanitizeSessionName(null)).toBeNull();
    expect(sanitizeSessionName(123)).toBeNull();
  });

  it("caps length", () => {
    expect(sanitizeSessionName("a".repeat(300))?.length).toBe(200);
  });
});

describe("sanitizeGroupPath", () => {
  it("allows valid dotted/grouped paths", () => {
    expect(sanitizeGroupPath("work/backend")).toBe("work/backend");
    expect(sanitizeGroupPath("my-group.sub")).toBe("my-group.sub");
  });

  it("rejects paths with invalid characters", () => {
    expect(sanitizeGroupPath("a;b")).toBeNull();
    expect(sanitizeGroupPath("$(cmd)")).toBeNull();
    expect(sanitizeGroupPath("..")).toBeNull();
  });

  it("caps length", () => {
    expect(sanitizeGroupPath("a/".repeat(150))?.length).toBe(200);
  });
});

describe("resolveSandboxedPath", () => {
  it("allows paths under an allowed root", () => {
    const roots = ["C:\\stoa\\project"];
    const result = resolveSandboxedPath(
      "C:\\stoa\\project\\src\\main.ts",
      roots
    );
    expect(result.allowed).toBe(true);
    // On POSIX the Windows-style path is treated as a relative segment, so only
    // assert the exact resolved value on Windows.
    if (process.platform === "win32") {
      expect(result.resolved).toBe("C:\\stoa\\project\\src\\main.ts");
    } else {
      expect(result.resolved).toContain("C:\\stoa\\project\\src\\main.ts");
    }
  });

  it("rejects traversal outside the root", () => {
    const roots = ["C:\\stoa\\project"];
    const result = resolveSandboxedPath(
      "C:\\stoa\\project\\..\\..\\etc\\passwd",
      roots
    );
    expect(result.allowed).toBe(false);
  });

  it("rejects paths outside all roots", () => {
    const roots = ["C:\\stoa\\project"];
    const result = resolveSandboxedPath("C:\\other\\file.txt", roots);
    expect(result.allowed).toBe(false);
  });
});

describe("tokenizeCommand", () => {
  it("splits a simple command into tokens", () => {
    expect(tokenizeCommand("node server.js --port 3000")).toEqual([
      "node",
      "server.js",
      "--port",
      "3000",
    ]);
  });

  it("supports double-quoted arguments", () => {
    expect(tokenizeCommand('node "my script.js"')).toEqual([
      "node",
      "my script.js",
    ]);
  });

  it("supports single-quoted arguments", () => {
    expect(tokenizeCommand("node 'my script.js'")).toEqual([
      "node",
      "my script.js",
    ]);
  });

  it("rejects shell metacharacters", () => {
    expect(() => tokenizeCommand("node; ls")).toThrow("Shell metacharacter");
    expect(() => tokenizeCommand("node | cat")).toThrow("Shell metacharacter");
    expect(() => tokenizeCommand("node && cat")).toThrow("Shell metacharacter");
    expect(() => tokenizeCommand("node > out")).toThrow("Shell metacharacter");
    expect(() => tokenizeCommand("$(whoami)")).toThrow("Shell metacharacter");
    expect(() => tokenizeCommand("`whoami`")).toThrow("Shell metacharacter");
  });

  it("rejects empty commands", () => {
    expect(() => tokenizeCommand("   ")).toThrow("Empty command");
  });

  it("rejects unterminated quotes", () => {
    expect(() => tokenizeCommand('node "server.js')).toThrow("Unterminated");
    expect(() => tokenizeCommand("node 'server.js")).toThrow("Unterminated");
  });

  it("preserves Windows-style backslash paths as literals", () => {
    expect(tokenizeCommand("C:\\Users\\foo\\.bin\\npm.cmd")).toEqual([
      "C:\\Users\\foo\\.bin\\npm.cmd",
    ]);
  });

  it("still escapes quotes with a backslash outside quotes", () => {
    expect(tokenizeCommand('node \\"weird\\"')).toEqual(["node", '"weird"']);
  });
});

describe("shellEscape", () => {
  it("leaves safe tokens unchanged", () => {
    expect(shellEscape("node")).toBe("node");
    expect(shellEscape("server.js")).toBe("server.js");
  });

  it("quotes unsafe tokens", () => {
    expect(shellEscape("hello world")).toBe("'hello world'");
    expect(shellEscape("it's")).toBe("'it'\"'\"'s'");
  });

  it("handles empty string", () => {
    expect(shellEscape("")).toBe("''");
  });
});

describe("validateGitHubLabels", () => {
  it("accepts valid labels", () => {
    expect(validateGitHubLabels(["bug", "good-first-issue", "v1.0+"]).ok).toBe(
      true
    );
  });

  it("rejects invalid structures", () => {
    expect(validateGitHubLabels("bug" as unknown as string[]).ok).toBe(false);
    expect(validateGitHubLabels(["", "bug"]).ok).toBe(false);
    expect(validateGitHubLabels([123] as unknown as string[]).ok).toBe(false);
  });

  it("rejects labels that are too long or have bad characters", () => {
    expect(validateGitHubLabels(["a".repeat(51)]).ok).toBe(false);
    expect(validateGitHubLabels(["bad label"]).ok).toBe(false);
  });
});

describe("validateUploadMimeType", () => {
  it("accepts allowed MIME types", () => {
    expect(validateUploadMimeType("image/png")).toEqual({
      ok: true,
      ext: "png",
    });
    expect(validateUploadMimeType("image/jpeg")).toEqual({
      ok: true,
      ext: "jpg",
    });
  });

  it("rejects disallowed MIME types", () => {
    expect(validateUploadMimeType("application/javascript").ok).toBe(false);
    expect(validateUploadMimeType("text/html").ok).toBe(false);
  });

  it("defaults to png when omitted", () => {
    expect(validateUploadMimeType(undefined)).toEqual({ ok: true, ext: "png" });
  });
});

describe("checkRateLimit", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function makeRequest(ip?: string) {
    const headers = new Headers();
    const req = {
      headers,
      ip,
    } as unknown as NextRequest;
    return req;
  }

  it("allows requests under the limit", () => {
    const req = makeRequest("1.2.3.4");
    for (let i = 0; i < 60; i++) {
      expect(checkRateLimit(req).allowed).toBe(true);
    }
  });

  it("blocks requests over the limit", () => {
    const req = makeRequest("1.2.3.4");
    for (let i = 0; i < 60; i++) checkRateLimit(req);
    const over = checkRateLimit(req);
    expect(over.allowed).toBe(false);
    expect(over.retryAfter).toBeGreaterThan(0);
  });

  it("resets after the window", () => {
    const req = makeRequest("1.2.3.4");
    for (let i = 0; i < 60; i++) checkRateLimit(req);
    vi.advanceTimersByTime(61_000);
    expect(checkRateLimit(req).allowed).toBe(true);
  });

  it("ignores spoofed X-Forwarded-For and keys by connection IP", () => {
    const reqA = {
      headers: new Headers({ "x-forwarded-for": "10.0.0.1" }),
      ip: "1.2.3.4",
    } as unknown as NextRequest;
    const reqB = {
      headers: new Headers({ "x-forwarded-for": "10.0.0.2" }),
      ip: "1.2.3.4",
    } as unknown as NextRequest;
    for (let i = 0; i < 60; i++) checkRateLimit(reqA);
    // Same connection IP as reqA, even though X-Forwarded-For differs.
    expect(checkRateLimit(reqB).allowed).toBe(false);
  });

  it("keys by the server-injected x-stoa-remote-addr header (Next 16 has no request.ip)", () => {
    // Production path: the custom server sets x-stoa-remote-addr; request.ip is
    // undefined. Distinct header values must get distinct buckets.
    const reqA = {
      headers: new Headers({ "x-stoa-remote-addr": "5.5.5.5" }),
    } as unknown as NextRequest;
    const reqB = {
      headers: new Headers({ "x-stoa-remote-addr": "6.6.6.6" }),
    } as unknown as NextRequest;
    for (let i = 0; i < 60; i++)
      expect(checkRateLimit(reqA).allowed).toBe(true);
    expect(checkRateLimit(reqA).allowed).toBe(false); // A exhausted
    expect(checkRateLimit(reqB).allowed).toBe(true); // B is a separate bucket
  });
});

describe("requireLocalhost", () => {
  function makeRequest(host: string) {
    return { headers: new Headers({ host }) } as NextRequest;
  }

  it("allows localhost hosts", () => {
    for (const host of ["localhost", "127.0.0.1", "::1", "[::1]"]) {
      const result = requireLocalhost(makeRequest(host));
      expect(result.ok).toBe(true);
    }
  });

  it("allows localhost with port", () => {
    expect(requireLocalhost(makeRequest("localhost:3011")).ok).toBe(true);
  });

  it("strips the port from an IPv4 Host (127.0.0.1:3011)", () => {
    // A single colon is host:port; the old `colons === 4` branch never matched
    // an IPv4:port and the value only survived by accident.
    expect(requireLocalhost(makeRequest("127.0.0.1:3011")).ok).toBe(true);
  });

  it("rejects non-local hosts", () => {
    const result = requireLocalhost(makeRequest("evil.com"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(403);
    }
  });

  it("rejects a remote IP even when the Host header claims localhost", () => {
    const headers = new Headers({ host: "localhost" });
    const req = { headers, ip: "192.168.1.1" } as unknown as NextRequest;
    const result = requireLocalhost(req);
    expect(result.ok).toBe(false);
  });

  it("trusts x-stoa-remote-addr over a spoofed Host (production path, no request.ip)", () => {
    // A remote client connecting with a spoofed `Host: localhost` is rejected
    // because the server-injected connection IP says otherwise.
    const remote = {
      headers: new Headers({
        host: "localhost",
        "x-stoa-remote-addr": "203.0.113.7",
      }),
    } as unknown as NextRequest;
    expect(requireLocalhost(remote).ok).toBe(false);

    const local = {
      headers: new Headers({
        host: "evil.com",
        "x-stoa-remote-addr": "127.0.0.1",
      }),
    } as unknown as NextRequest;
    expect(requireLocalhost(local).ok).toBe(true);
  });
});
