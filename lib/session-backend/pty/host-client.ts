/**
 * Client for the pty-host daemon (Tier 2).
 *
 * Connects to the host over the local socket and exposes async control ops plus
 * an attach() that streams output. Auto-spawns the daemon (detached) if it isn't
 * running yet. Used by HostTransport (PtyBackend) and server.ts when host mode is on.
 *
 * Hardened for "bulletproof" use as the default Windows backend:
 *  - single-flight connect + ping-validate (the daemon is confirmed serving
 *    before we declare it usable; avoids half-open pipes / connect storms),
 *  - request() retries once across a dropped socket,
 *  - input/resize wait for (re)connection before writing,
 *  - active subscriptions are automatically re-attached (and repainted) after a
 *    socket reconnect, so a transient daemon-socket drop is invisible.
 */

import net from "net";
import { spawn } from "child_process";
import path from "path";
import {
  hostAddress,
  encode,
  createDecoder,
  type ClientMessage,
  type HostMessage,
  type SpawnSpecMsg,
} from "./protocol";

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

/** Distributive Omit so the discriminated union keeps its per-variant fields. */
type DistributiveOmit<T, K extends keyof T> = T extends unknown
  ? Omit<T, K>
  : never;
type ClientRequest = DistributiveOmit<
  Extract<ClientMessage, { id: number }>,
  "id"
>;

export interface AttachResult {
  snapshot: string;
  detach: () => void;
}

const CONNECT_ATTEMPTS = 40;
const CONNECT_RETRY_MS = 100;
const REQUEST_TIMEOUT_MS = 10_000;

export class HostClient {
  private socket: net.Socket | null = null;
  private connecting: Promise<void> | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private outputListeners = new Map<string, Set<(data: string) => void>>();
  private exitListeners = new Map<string, Set<(code: number) => void>>();
  private spawnedThisCycle = false;

  private route(msg: HostMessage) {
    if (msg.t === "res") {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.value);
      else p.reject(new Error(msg.error));
    } else if (msg.t === "output") {
      this.outputListeners.get(msg.key)?.forEach((cb) => cb(msg.data));
    } else if (msg.t === "exit") {
      this.exitListeners.get(msg.key)?.forEach((cb) => cb(msg.code));
    }
  }

  private connectOnce(): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
      const s = net.connect(hostAddress());
      s.setEncoding("utf8");
      const onError = (err: Error) => {
        s.removeAllListeners();
        s.destroy();
        reject(err);
      };
      s.once("error", onError);
      s.once("connect", () => {
        s.removeListener("error", onError);
        resolve(s);
      });
    });
  }

  /** Spawn the daemon as a detached process that outlives this one. */
  private spawnHost() {
    if (this.spawnedThisCycle) return;
    this.spawnedThisCycle = true;
    const root = path.join(__dirname, "..", "..", "..");
    const script = path.join(root, "scripts", "pty-host.ts");
    // Run through the tsx CLI under the current node binary. This avoids the
    // tsx .cmd shim on Windows and the --import named-export resolution issue.
    const tsxCli = path.join(root, "node_modules", "tsx", "dist", "cli.mjs");
    const child = spawn(process.execPath, [tsxCli, script], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
  }

  private wireSocket(s: net.Socket): void {
    this.socket = s;
    const decode = createDecoder<HostMessage>((m) => this.route(m));
    s.on("data", decode);
    // A late socket error (e.g. half-open pipe) must be handled or Node throws
    // an uncaught exception and crashes the process. Treat it like a close.
    s.on("error", () => {
      if (this.socket === s) this.socket = null;
    });
    s.on("close", () => {
      if (this.socket === s) this.socket = null;
      // Fail in-flight requests so request()'s retry can reconnect.
      for (const [, p] of this.pending) p.reject(new Error("host closed"));
      this.pending.clear();
    });
  }

  private async ensureConnected(): Promise<void> {
    if (this.socket && !this.socket.destroyed) return;
    if (this.connecting) return this.connecting;

    const hadSubscriptions = this.outputListeners.size > 0;

    this.connecting = (async () => {
      this.spawnedThisCycle = false;
      let lastErr: Error | null = null;
      for (let attempt = 0; attempt < CONNECT_ATTEMPTS; attempt++) {
        try {
          const s = await this.connectOnce();
          this.wireSocket(s);
          return;
        } catch (err) {
          lastErr = err as Error;
          // Spawn the daemon once per connect cycle, then keep retrying.
          if (attempt === 0) this.spawnHost();
          await new Promise((r) => setTimeout(r, CONNECT_RETRY_MS));
        }
      }
      throw lastErr ?? new Error("could not connect to pty host");
    })();

    try {
      await this.connecting;
    } finally {
      this.connecting = null;
    }

    // Validate the daemon is actually serving (not a half-open pipe). If the
    // ping fails, tear down the socket so the NEXT call reconnects instead of
    // treating this half-open socket as healthy (which would defeat the check).
    try {
      await this.pingRaw();
    } catch (err) {
      this.socket?.destroy();
      this.socket = null;
      throw err;
    }

    // If we reconnected while holding live subscriptions, re-attach them so
    // output resumes and the screen repaints — a transient socket drop is then
    // invisible to the browser.
    if (hadSubscriptions) await this.resubscribeAll();
  }

  /** Low-level ping that does not recurse through ensureConnected. */
  private pingRaw(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.socket || this.socket.destroyed) {
        reject(new Error("not connected"));
        return;
      }
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("ping timeout"));
      }, 2000);
      this.pending.set(id, {
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.socket.write(encode({ t: "ping", id }));
    });
  }

  /** Re-send attach for every subscribed key and repaint from the snapshot. */
  private async resubscribeAll(): Promise<void> {
    for (const key of [...this.outputListeners.keys()]) {
      try {
        const res = await this.requestNoRetry<{ snapshot: string }>({
          t: "attach",
          key,
        });
        const snap = res?.snapshot;
        if (snap) this.outputListeners.get(key)?.forEach((cb) => cb(snap));
      } catch {
        // Session is gone on the daemon (e.g. daemon itself restarted); the
        // caller (server.ts) will respawn on the next browser attach.
      }
    }
  }

  private requestNoRetry<T>(msg: ClientRequest): Promise<T> {
    const id = this.nextId++;
    const full = { ...msg, id } as ClientMessage;
    return new Promise<T>((resolve, reject) => {
      if (!this.socket || this.socket.destroyed) {
        reject(new Error("not connected"));
        return;
      }
      // Bound every request so a wedged daemon can't hang the caller forever.
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("host request timeout"));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          (resolve as (x: unknown) => void)(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.socket.write(encode(full));
    });
  }

  private async request<T>(msg: ClientRequest): Promise<T> {
    await this.ensureConnected();
    try {
      return await this.requestNoRetry<T>(msg);
    } catch (err) {
      // One transparent retry across a dropped socket / daemon restart.
      if (
        (err as Error).message === "host closed" ||
        (err as Error).message === "not connected"
      ) {
        await this.ensureConnected();
        return this.requestNoRetry<T>(msg);
      }
      throw err;
    }
  }

  private async fireAndForget(msg: ClientMessage): Promise<void> {
    await this.ensureConnected();
    this.socket?.write(encode(msg));
  }

  /** Connect + validate the daemon is reachable. Throws if it can't be reached. */
  async ensureReady(): Promise<void> {
    await this.ensureConnected();
  }

  async ping(): Promise<void> {
    await this.request<void>({ t: "ping" });
  }

  async spawn(key: string, spec: SpawnSpecMsg): Promise<void> {
    await this.request<void>({ t: "spawn", key, spec });
  }

  async spawnShell(
    key: string,
    cwd: string,
    cols?: number,
    rows?: number
  ): Promise<void> {
    await this.request<void>({ t: "spawnShell", key, cwd, cols, rows });
  }

  async attach(
    key: string,
    onOutput: (data: string) => void,
    onExit: (code: number) => void
  ): Promise<AttachResult> {
    let outSet = this.outputListeners.get(key);
    if (!outSet) this.outputListeners.set(key, (outSet = new Set()));
    let exitSet = this.exitListeners.get(key);
    if (!exitSet) this.exitListeners.set(key, (exitSet = new Set()));
    outSet.add(onOutput);
    exitSet.add(onExit);

    try {
      const res = await this.request<{ snapshot: string }>({
        t: "attach",
        key,
      });
      const detach = () => {
        outSet!.delete(onOutput);
        exitSet!.delete(onExit);
        if (outSet!.size === 0) this.outputListeners.delete(key);
        if (exitSet!.size === 0) this.exitListeners.delete(key);
        void this.fireAndForget({ t: "detach", key });
      };
      return { snapshot: res?.snapshot ?? "", detach };
    } catch (err) {
      // Roll back listener registration if the attach failed.
      outSet.delete(onOutput);
      exitSet.delete(onExit);
      if (outSet.size === 0) this.outputListeners.delete(key);
      if (exitSet.size === 0) this.exitListeners.delete(key);
      throw err;
    }
  }

  input(key: string, data: string): void {
    void this.fireAndForget({ t: "input", key, data });
  }

  resize(key: string, cols: number, rows: number): void {
    void this.fireAndForget({ t: "resize", key, cols, rows });
  }

  async kill(key: string): Promise<void> {
    await this.request<void>({ t: "kill", key });
  }

  async rename(oldKey: string, newKey: string): Promise<void> {
    await this.request<void>({ t: "rename", oldKey, newKey });
  }

  async capture(key: string, lines?: number): Promise<string> {
    return (await this.request<string>({ t: "capture", key, lines })) ?? "";
  }

  async exists(key: string): Promise<boolean> {
    return (await this.request<boolean>({ t: "exists", key })) ?? false;
  }

  async list(): Promise<string[]> {
    return (await this.request<string[]>({ t: "list" })) ?? [];
  }

  async listActivity(): Promise<
    Array<{ name: string; activity: number | null }>
  > {
    return (await this.request({ t: "listActivity" })) ?? [];
  }

  async panePath(key: string): Promise<string | null> {
    return (await this.request<string | null>({ t: "panePath", key })) ?? null;
  }

  close(): void {
    this.socket?.destroy();
    this.socket = null;
  }
}

let client: HostClient | null = null;

export function getHostClient(): HostClient {
  if (!client) client = new HostClient();
  return client;
}
