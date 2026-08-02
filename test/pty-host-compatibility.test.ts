// A distinct socket models a daemon left alive across an application upgrade.
process.env.STOA_PTY_HOST_NAME = "stoa-pty-host-test-legacy-protocol";

import net from "net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HostClient } from "@/lib/session-backend/pty/host-client";
import { encode, hostAddress } from "@/lib/session-backend/pty/protocol";

interface HostClientTestAccess {
  wireSocket(socket: net.Socket): void;
  socket: net.Socket | null;
  negotiatedSocket: net.Socket | null;
  pending: Map<
    number,
    {
      resolve(value: unknown): void;
      reject(error: Error): void;
    }
  >;
}

/**
 * The pre-negotiation daemon used the same length-prefixed JSON framing but
 * replied to ping with no value. Keep this encoder independent of today's
 * HostMessage types so the fixture really is an old wire peer.
 */
function legacyJsonFrame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  const payload = Buffer.concat([Buffer.from([1]), body]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(payload.length, 0);
  return Buffer.concat([length, payload]);
}

function legacyPingServer(requestTypes: string[] = []): net.Server {
  return net.createServer((socket) => {
    let buffered = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      while (buffered.length >= 4) {
        const length = buffered.readUInt32BE(0);
        if (buffered.length < 4 + length) return;
        const payload = buffered.subarray(4, 4 + length);
        buffered = buffered.subarray(4 + length);
        if (payload[0] !== 1) continue;
        const request = JSON.parse(payload.toString("utf8", 1)) as {
          t?: string;
          id?: number;
        };
        if (typeof request.t === "string") requestTypes.push(request.t);
        if (request.t === "ping" && typeof request.id === "number") {
          socket.write(legacyJsonFrame({ t: "res", id: request.id, ok: true }));
        }
      }
    });
  });
}

let server: net.Server | null = null;

afterEach(async () => {
  if (!server) return;
  const active = server;
  server = null;
  await new Promise<void>((resolve) => active.close(() => resolve()));
});

describe("pty-host upgrade compatibility", () => {
  it("fails closed when a surviving legacy daemon has no spawn capabilities", async () => {
    server = legacyPingServer();
    await new Promise<void>((resolve, reject) => {
      server!.once("error", reject);
      server!.listen(hostAddress(), resolve);
    });

    const client = new HostClient();
    await expect(client.ensureReady()).rejects.toThrow(
      /incompatible pty-host daemon.*protocol handshake/
    );
    client.close();

    // Rejecting the peer must not kill or replace it: a production upgrade can
    // preserve its surviving sessions while this server safely chooses Tier 1.
    expect(server.listening).toBe(true);
  });

  it("negotiates before sending a spawn to a legacy daemon", async () => {
    const requests: string[] = [];
    server = legacyPingServer(requests);
    await new Promise<void>((resolve, reject) => {
      server!.once("error", reject);
      server!.listen(hostAddress(), resolve);
    });

    const client = new HostClient();
    await expect(
      client.spawn("must-not-reach-legacy", {
        binary: "node",
        args: [],
        cwd: process.cwd(),
        env: { ONLY: "this" },
        envMode: "replace",
        fleetWritableRoots: [process.cwd()],
      })
    ).rejects.toThrow(/incompatible pty-host daemon/);
    client.close();

    expect(requests).toEqual(["ping"]);
    expect(server.listening).toBe(true);
  });

  it("ignores a superseded socket's delayed close while replacement requests are pending", () => {
    const client = new HostClient();
    const access = client as unknown as HostClientTestAccess;
    const superseded = new net.Socket();
    const replacement = new net.Socket();
    access.wireSocket(superseded);
    access.wireSocket(replacement);
    access.negotiatedSocket = replacement;

    const resolve = vi.fn();
    const reject = vi.fn();
    access.pending.set(41, { resolve, reject });

    // The old pipe can report close after a reconnect has already negotiated
    // and issued a request. It no longer owns the client's pending map.
    superseded.emit("close");

    expect(access.socket).toBe(replacement);
    expect(access.negotiatedSocket).toBe(replacement);
    expect(access.pending.has(41)).toBe(true);
    expect(reject).not.toHaveBeenCalled();

    replacement.emit(
      "data",
      encode({ t: "res", id: 41, ok: true, value: "replacement-result" })
    );
    expect(resolve).toHaveBeenCalledWith("replacement-result");
    expect(access.pending.has(41)).toBe(false);

    client.close();
    superseded.destroy();
  });

  it("settles current-socket requests immediately on explicit client close", () => {
    const client = new HostClient();
    const access = client as unknown as HostClientTestAccess;
    const current = new net.Socket();
    access.wireSocket(current);
    access.negotiatedSocket = current;
    const reject = vi.fn();
    access.pending.set(42, { resolve: vi.fn(), reject });

    client.close();

    expect(reject).toHaveBeenCalledWith(new Error("host closed"));
    expect(access.pending.size).toBe(0);
    expect(access.socket).toBeNull();
    expect(access.negotiatedSocket).toBeNull();
  });
});
