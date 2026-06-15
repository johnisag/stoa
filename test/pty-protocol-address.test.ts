/**
 * Regression: hostAddress() must (1) qualify the DEFAULT socket/pipe name per-user
 * so two users (or two installs) on one machine don't bind the same global address,
 * and (2) keep the POSIX socket path under the AF_UNIX sun_path limit by falling
 * back to /tmp when a deep TMPDIR would overflow it.
 *
 * isWindows is mocked false so the POSIX (socket) branch is exercised on every OS;
 * assertions are path-separator-agnostic (basename/length) so they pass on Windows CI.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import os from "os";
import path from "path";

vi.mock("@/lib/platform", () => ({ isWindows: false }));

import { hostAddress } from "@/lib/session-backend/pty/protocol";

const savedEnv = process.env.STOA_PTY_HOST_NAME;

beforeEach(() => {
  delete process.env.STOA_PTY_HOST_NAME;
  vi.spyOn(os, "userInfo").mockReturnValue({
    uid: 1234,
    username: "alice",
  } as unknown as os.UserInfo<string>);
  vi.spyOn(os, "tmpdir").mockReturnValue("/tmp");
});

afterEach(() => {
  vi.restoreAllMocks();
  if (savedEnv === undefined) delete process.env.STOA_PTY_HOST_NAME;
  else process.env.STOA_PTY_HOST_NAME = savedEnv;
});

describe("hostAddress — per-user default + sun_path safety (POSIX branch)", () => {
  it("qualifies the default name with a per-user suffix (not the bare global)", () => {
    const base = path.basename(hostAddress());
    expect(base).toMatch(/^stoa-pty-host-.+\.sock$/);
    expect(base).not.toBe("stoa-pty-host.sock");
  });

  it("gives two different users two different addresses", () => {
    vi.spyOn(os, "userInfo").mockReturnValue({
      uid: 1,
      username: "a",
    } as unknown as os.UserInfo<string>);
    const a = hostAddress();
    vi.spyOn(os, "userInfo").mockReturnValue({
      uid: 2,
      username: "b",
    } as unknown as os.UserInfo<string>);
    const b = hostAddress();
    expect(a).not.toBe(b);
  });

  it("STOA_PTY_HOST_NAME overrides exactly (no suffix) so test daemons stay isolated", () => {
    process.env.STOA_PTY_HOST_NAME = "iso-123";
    expect(path.basename(hostAddress())).toBe("iso-123.sock");
  });

  it("falls back off a deep TMPDIR that would overflow the sun_path limit", () => {
    vi.spyOn(os, "tmpdir").mockReturnValue("/" + "x".repeat(140));
    const addr = hostAddress();
    // Not under the overflowing tmpdir, and within a safe length.
    expect(addr).not.toContain("xxxx");
    expect(path.basename(addr)).toMatch(/^stoa-pty-host-.+\.sock$/);
    expect(addr.length).toBeLessThanOrEqual(100);
  });
});
