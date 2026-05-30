/**
 * Client for the pty-host daemon (Tier 2).
 *
 * Connects to the host over the local socket and exposes async control ops plus
 * an attach() that streams output. Auto-spawns the daemon (detached) if it isn't
 * running yet. Used by PtyBackend and server.ts when AGENT_OS_PTY_HOST=1.
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

export class HostClient {
  private socket: net.Socket | null = null;
  private connecting: Promise<void> | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private outputListeners = new Map<string, Set<(data: string) => void>>();
  private exitListeners = new Map<string, Set<(code: number) => void>>();

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

  private async ensureConnected(): Promise<void> {
    if (this.socket && !this.socket.destroyed) return;
    if (this.connecting) return this.connecting;

    this.connecting = (async () => {
      let lastErr: Error | null = null;
      for (let attempt = 0; attempt < 30; attempt++) {
        try {
          const s = await this.connectOnce();
          this.socket = s;
          const decode = createDecoder<HostMessage>((m) => this.route(m));
          s.on("data", decode);
          s.on("close", () => {
            this.socket = null;
            // Reject in-flight requests; callers can retry.
            for (const [, p] of this.pending)
              p.reject(new Error("host closed"));
            this.pending.clear();
          });
          this.connecting = null;
          return;
        } catch (err) {
          lastErr = err as Error;
          if (attempt === 0) this.spawnHost();
          await new Promise((r) => setTimeout(r, 100));
        }
      }
      this.connecting = null;
      throw lastErr ?? new Error("could not connect to pty host");
    })();

    return this.connecting;
  }

  private async request<T>(msg: ClientRequest): Promise<T> {
    await this.ensureConnected();
    const id = this.nextId++;
    const full = { ...msg, id } as ClientMessage;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
      });
      this.socket!.write(encode(full));
    });
  }

  private async fireAndForget(msg: ClientMessage): Promise<void> {
    await this.ensureConnected();
    this.socket!.write(encode(msg));
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

    const res = await this.request<{ snapshot: string }>({ t: "attach", key });
    const detach = () => {
      outSet!.delete(onOutput);
      exitSet!.delete(onExit);
      void this.fireAndForget({ t: "detach", key });
    };
    return { snapshot: res?.snapshot ?? "", detach };
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
