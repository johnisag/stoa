/**
 * VAPID key handling must never destroy a valid keypair on a TRANSIENT read
 * failure (Windows file lock / AV scan / partial write) — overwriting it would
 * invalidate every existing push subscription (F10). Mocks fs + web-push (and
 * db, which push.ts imports) so it runs on every OS with no real key/file.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const fsMock = vi.hoisted(() => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

vi.mock("fs", () => fsMock);
vi.mock("web-push", () => ({
  default: {
    generateVAPIDKeys: () => ({ publicKey: "GEN_PUB", privateKey: "GEN_PRIV" }),
    setVapidDetails: vi.fn(),
    sendNotification: vi.fn(),
  },
}));
// push.ts imports the db module at load; stub it (getVapidKeys never touches db).
vi.mock("../lib/db", () => ({ getDb: vi.fn(), queries: {} }));

beforeEach(() => {
  vi.resetModules(); // reset push.ts's module-level VAPID cache between tests
  fsMock.existsSync.mockReset();
  fsMock.readFileSync.mockReset();
  fsMock.writeFileSync.mockReset();
  fsMock.mkdirSync.mockReset();
});

describe("getVapidKeys — never clobbers a valid file on a transient read error (F10)", () => {
  it("throws and does NOT overwrite when an existing file fails to read", async () => {
    fsMock.existsSync.mockReturnValue(true);
    fsMock.readFileSync.mockImplementation(() => {
      throw new Error("EBUSY: resource busy or locked");
    });
    const { getVapidKeys } = await import("../lib/push");
    expect(() => getVapidKeys()).toThrow(/EBUSY/);
    expect(fsMock.writeFileSync).not.toHaveBeenCalled(); // key preserved
  });

  it("reads existing valid keys without regenerating", async () => {
    fsMock.existsSync.mockReturnValue(true);
    fsMock.readFileSync.mockReturnValue(
      JSON.stringify({ publicKey: "P", privateKey: "K" })
    );
    const { getVapidKeys } = await import("../lib/push");
    expect(getVapidKeys()).toEqual({ publicKey: "P", privateKey: "K" });
    expect(fsMock.writeFileSync).not.toHaveBeenCalled();
  });

  it("generates + persists when no file exists", async () => {
    fsMock.existsSync.mockReturnValue(false);
    const { getVapidKeys } = await import("../lib/push");
    expect(getVapidKeys()).toEqual({
      publicKey: "GEN_PUB",
      privateKey: "GEN_PRIV",
    });
    expect(fsMock.writeFileSync).toHaveBeenCalledTimes(1);
  });

  it("regenerates a genuinely corrupt (unparseable) file", async () => {
    fsMock.existsSync.mockReturnValue(true);
    fsMock.readFileSync.mockReturnValue("{ not valid json");
    const { getVapidKeys } = await import("../lib/push");
    expect(getVapidKeys()).toEqual({
      publicKey: "GEN_PUB",
      privateKey: "GEN_PRIV",
    });
    expect(fsMock.writeFileSync).toHaveBeenCalledTimes(1);
  });
});
