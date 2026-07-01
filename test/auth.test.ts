import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  isLoopbackAddress,
  isTailscaleAddress,
  parseCookies,
  safeEqual,
  isOriginAllowed,
  safeRedirectPath,
  decideHttpAuth,
  decideWsAuth,
  readSharedOrigins,
  COOKIE_NAME,
} from "../lib/auth";

describe("safeRedirectPath (open-redirect guard)", () => {
  it("keeps a normal local path", () => {
    expect(safeRedirectPath("/")).toBe("/");
    expect(safeRedirectPath("/app/page")).toBe("/app/page");
    expect(safeRedirectPath(undefined)).toBe("/");
  });
  it("rejects protocol-relative / backslash targets (would go off-site)", () => {
    expect(safeRedirectPath("//evil.com/x")).toBe("/");
    expect(safeRedirectPath("/\\evil.com")).toBe("/");
    expect(safeRedirectPath("///evil.com")).toBe("/");
  });
  it("rejects non-/-rooted targets + null", () => {
    expect(safeRedirectPath("https://evil.com")).toBe("/");
    expect(safeRedirectPath("javascript:alert(1)")).toBe("/");
    expect(safeRedirectPath("evil.com")).toBe("/");
    expect(safeRedirectPath(null)).toBe("/");
  });
});

const TOKEN = "s3cr3t-token";

describe("isLoopbackAddress", () => {
  it("recognizes loopback forms", () => {
    for (const a of [
      "127.0.0.1",
      "::1",
      "localhost",
      "::ffff:127.0.0.1",
      "127.0.0.5",
    ])
      expect(isLoopbackAddress(a)).toBe(true);
  });
  it("rejects LAN / Tailscale / empty", () => {
    for (const a of ["192.168.1.20", "10.0.0.3", "100.64.1.2", "", undefined])
      expect(isLoopbackAddress(a)).toBe(false);
  });
});

describe("isTailscaleAddress", () => {
  it("recognizes the CGNAT range + IPv4-mapped + IPv6 ULA", () => {
    for (const a of [
      "100.64.0.1",
      "100.100.20.30",
      "100.127.255.255",
      "::ffff:100.96.0.5",
      "fd7a:115c:a1e0:ab12::1",
    ])
      expect(isTailscaleAddress(a)).toBe(true);
  });
  it("rejects loopback, LAN, and 100.x outside 64–127", () => {
    for (const a of [
      "127.0.0.1",
      "192.168.1.5",
      "10.0.0.1",
      "100.63.0.1", // just below the range
      "100.128.0.1", // just above
      undefined,
    ])
      expect(isTailscaleAddress(a)).toBe(false);
  });
});

describe("parseCookies", () => {
  it("parses and URL-decodes", () => {
    expect(parseCookies("a=1; stoa_token=ab%20c; b=2")).toEqual({
      a: "1",
      stoa_token: "ab c",
      b: "2",
    });
  });
  it("handles empty/missing", () => {
    expect(parseCookies(undefined)).toEqual({});
    expect(parseCookies("")).toEqual({});
  });
});

describe("safeEqual", () => {
  it("true only for exact match", () => {
    expect(safeEqual(TOKEN, TOKEN)).toBe(true);
    expect(safeEqual(TOKEN, TOKEN + "x")).toBe(false);
    expect(safeEqual(TOKEN, "")).toBe(false);
    expect(safeEqual(undefined, TOKEN)).toBe(false);
    expect(safeEqual(null, null)).toBe(false);
  });
});

describe("isOriginAllowed (CSWSH defense)", () => {
  it("allows no Origin (non-browser client)", () => {
    expect(isOriginAllowed(undefined, "localhost:3011", [])).toBe(true);
  });
  it("allows same-origin", () => {
    expect(isOriginAllowed("http://localhost:3011", "localhost:3011", [])).toBe(
      true
    );
    expect(
      isOriginAllowed("https://stoa.example.com", "stoa.example.com", [])
    ).toBe(true);
  });
  it("BLOCKS a foreign origin hitting a loopback host (the attack)", () => {
    expect(isOriginAllowed("http://evil.example", "localhost:3011", [])).toBe(
      false
    );
  });
  it("allows an explicit allowlisted origin (reverse proxy)", () => {
    expect(
      isOriginAllowed("https://stoa.me", "localhost:3011", ["https://stoa.me"])
    ).toBe(true);
    // bare-host allowlist entry also matches
    expect(
      isOriginAllowed("https://stoa.me", "localhost:3011", ["stoa.me"])
    ).toBe(true);
  });
  it("rejects a malformed Origin", () => {
    expect(isOriginAllowed("not a url", "localhost:3011", [])).toBe(false);
  });
});

describe("decideHttpAuth", () => {
  const base = { serverToken: TOKEN, trustLoopback: true };

  it("allows everything when auth is disabled (serverToken null)", () => {
    expect(
      decideHttpAuth({ ...base, serverToken: null, remoteAddr: "10.0.0.9" })
    ).toEqual({ type: "allow" });
  });

  it("trusts loopback without a token", () => {
    expect(decideHttpAuth({ ...base, remoteAddr: "127.0.0.1" })).toEqual({
      type: "allow",
    });
  });

  it("denies remote without a token", () => {
    expect(decideHttpAuth({ ...base, remoteAddr: "192.168.1.5" })).toEqual({
      type: "deny",
    });
  });

  it("allows remote with a valid Bearer header", () => {
    expect(
      decideHttpAuth({
        ...base,
        remoteAddr: "192.168.1.5",
        authHeader: `Bearer ${TOKEN}`,
      })
    ).toEqual({ type: "allow" });
  });

  it("allows remote with a valid cookie", () => {
    expect(
      decideHttpAuth({
        ...base,
        remoteAddr: "192.168.1.5",
        cookieHeader: `${COOKIE_NAME}=${TOKEN}`,
      })
    ).toEqual({ type: "allow" });
  });

  it("bootstraps (set-cookie + redirect) on a valid ?token=", () => {
    expect(
      decideHttpAuth({
        ...base,
        remoteAddr: "192.168.1.5",
        queryToken: TOKEN,
      })
    ).toEqual({ type: "bootstrap", token: TOKEN });
  });

  it("denies a wrong token", () => {
    expect(
      decideHttpAuth({
        ...base,
        remoteAddr: "192.168.1.5",
        cookieHeader: `${COOKIE_NAME}=nope`,
        queryToken: "nope",
      })
    ).toEqual({ type: "deny" });
  });

  it("requires a token even on loopback when trustLoopback is false", () => {
    expect(
      decideHttpAuth({ ...base, trustLoopback: false, remoteAddr: "127.0.0.1" })
    ).toEqual({ type: "deny" });
  });

  it("trusts a Tailscale address (no token) only when trustTailscale is on", () => {
    expect(decideHttpAuth({ ...base, remoteAddr: "100.96.1.2" })).toEqual({
      type: "deny",
    }); // off by default
    expect(
      decideHttpAuth({
        ...base,
        trustTailscale: true,
        remoteAddr: "100.96.1.2",
      })
    ).toEqual({ type: "allow" });
  });

  it("trustTailscale does NOT trust a plain-LAN address", () => {
    expect(
      decideHttpAuth({
        ...base,
        trustTailscale: true,
        remoteAddr: "192.168.1.50",
      })
    ).toEqual({ type: "deny" });
  });
});

describe("decideWsAuth", () => {
  const base = {
    serverToken: TOKEN,
    trustLoopback: true,
    allowedOrigins: [] as string[],
    host: "localhost:3011",
  };

  it("denies a cross-site Origin BEFORE any token/loopback check", () => {
    // Even from loopback with a valid cookie, a foreign Origin is rejected.
    expect(
      decideWsAuth({
        ...base,
        origin: "http://evil.example",
        remoteAddr: "127.0.0.1",
        cookieHeader: `${COOKIE_NAME}=${TOKEN}`,
      })
    ).toEqual({ type: "deny", reason: "origin" });
  });

  it("allows same-origin loopback (the real app)", () => {
    expect(
      decideWsAuth({
        ...base,
        origin: "http://localhost:3011",
        remoteAddr: "127.0.0.1",
      })
    ).toEqual({ type: "allow" });
  });

  it("allows same-origin remote with a valid cookie", () => {
    expect(
      decideWsAuth({
        ...base,
        host: "stoa.lan:3011",
        origin: "http://stoa.lan:3011",
        remoteAddr: "192.168.1.5",
        cookieHeader: `${COOKIE_NAME}=${TOKEN}`,
      })
    ).toEqual({ type: "allow" });
  });

  it("denies same-origin remote without a token", () => {
    expect(
      decideWsAuth({
        ...base,
        host: "stoa.lan:3011",
        origin: "http://stoa.lan:3011",
        remoteAddr: "192.168.1.5",
      })
    ).toEqual({ type: "deny", reason: "token" });
  });

  it("allows a non-browser client (no Origin) with a valid bearer token", () => {
    expect(
      decideWsAuth({
        ...base,
        remoteAddr: "192.168.1.5",
        authHeader: `Bearer ${TOKEN}`,
      })
    ).toEqual({ type: "allow" });
  });

  it("origin check still applies when the token gate is disabled", () => {
    expect(
      decideWsAuth({
        ...base,
        serverToken: null,
        origin: "http://evil.example",
      })
    ).toEqual({ type: "deny", reason: "origin" });
    expect(
      decideWsAuth({
        ...base,
        serverToken: null,
        origin: "http://localhost:3011",
      })
    ).toEqual({ type: "allow" });
  });
});

describe("getServerToken (env resolution)", () => {
  const saved = { ...process.env };
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  it("returns null when STOA_AUTH=off", async () => {
    process.env.STOA_AUTH = "off";
    const { getServerToken, isAuthDisabled } = await import("../lib/auth");
    expect(getServerToken()).toBeNull();
    expect(isAuthDisabled()).toBe(true);
  });

  it("uses STOA_TOKEN when set", async () => {
    delete process.env.STOA_AUTH;
    process.env.STOA_TOKEN = "env-token-123";
    const { getServerToken } = await import("../lib/auth");
    expect(getServerToken()).toBe("env-token-123");
  });
});

// share (#11): the tunnel origin `stoa share` registers in ~/.stoa/shared-origins is
// read live and unioned into the WS origin allowlist (server.ts), so a share started
// after the server needs no restart. Without it, the tunnel origin is CSWSH-denied.
describe("readSharedOrigins (stoa share origin registry)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "stoa-origins-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads one origin per line, trimmed, blanks dropped", () => {
    const f = join(dir, "shared-origins");
    writeFileSync(f, "https://a.ts.net\n  https://b.trycloudflare.com  \n\n");
    expect(readSharedOrigins(f)).toEqual([
      "https://a.ts.net",
      "https://b.trycloudflare.com",
    ]);
  });

  it("a missing/unreadable file is [] (fail-safe: unknown origins stay denied)", () => {
    expect(readSharedOrigins(join(dir, "nope"))).toEqual([]);
    expect(readSharedOrigins(dir)).toEqual([]); // a directory → read throws → []
  });

  it("registration is what admits the tunnel origin — unregistered is CSWSH-denied even with a valid cookie", () => {
    const tunnel = "https://my-box.tail1a2b.ts.net";
    const base = {
      serverToken: "tok",
      trustLoopback: false, // the loopback bypass is off (as `stoa share` requires)
      host: "localhost:3011",
      origin: tunnel,
      cookieHeader: `${COOKIE_NAME}=tok`,
    };
    // registered → allowed
    expect(decideWsAuth({ ...base, allowedOrigins: [tunnel] })).toEqual({
      type: "allow",
    });
    // NOT registered → denied on origin BEFORE the token is even considered
    expect(decideWsAuth({ ...base, allowedOrigins: [] })).toEqual({
      type: "deny",
      reason: "origin",
    });
  });
});
