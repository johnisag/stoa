/**
 * Pty implementation of SessionBackend.
 *
 * One backend, parameterized by a PtyTransport (LocalTransport for the
 * in-process registry / Tier 1, HostTransport for the out-of-process daemon /
 * Tier 2). All session ops delegate to the transport, so Tier 1 and Tier 2 share
 * exactly one implementation of the SessionBackend contract.
 */

import { isWindows, resolveBinary, defaultInteractiveShell } from "../platform";
import type {
  SessionBackend,
  SessionActivity,
  CaptureOptions,
  CreateOptions,
  SendOptions,
} from "./types";
import {
  type PtyTransport,
  LocalTransport,
  HostTransport,
} from "./pty/transport";

export class PtyBackend implements SessionBackend {
  constructor(private readonly transport: PtyTransport) {}

  async create({
    name,
    cwd,
    command,
    binary,
    args,
  }: CreateOptions): Promise<void> {
    // Preferred: spawn the agent binary directly with argv (no bash banner).
    if (binary && binary.length > 0) {
      await this.transport.spawn(name, { binary, args: args ?? [], cwd });
      return;
    }
    // Fallback: run the (banner-wrapped) command string through a shell. The
    // bash banner assumes POSIX; native-Windows orchestration should pass
    // binary/args above instead.
    if (isWindows) {
      const pwsh = resolveBinary("pwsh");
      await this.transport.spawn(
        name,
        pwsh
          ? { binary: pwsh, args: ["-NoLogo", "-Command", command], cwd }
          : {
              binary: process.env.ComSpec || "cmd.exe",
              args: ["/c", command],
              cwd,
            }
      );
    } else {
      await this.transport.spawn(name, {
        binary: defaultInteractiveShell(),
        args: ["-c", command],
        cwd,
      });
    }
  }

  async kill(name: string): Promise<void> {
    await this.transport.kill(name);
  }

  async rename(oldName: string, newName: string): Promise<void> {
    await this.transport.rename(oldName, newName);
  }

  async exists(name: string): Promise<boolean> {
    return this.transport.exists(name);
  }

  async list(): Promise<string[]> {
    return this.transport.list();
  }

  async listWithActivity(): Promise<SessionActivity[]> {
    return this.transport.listActivity();
  }

  async getPanePath(name: string): Promise<string | null> {
    return this.transport.panePath(name);
  }

  async getEnv(_name: string, _varName: string): Promise<string | null> {
    // A pty can't introspect its child's env; callers fall back to Claude's
    // JSONL on disk.
    return null;
  }

  async capture(name: string, opts?: CaptureOptions): Promise<string> {
    return this.transport.capture(name, opts?.lines);
  }

  async sendEnter(name: string): Promise<void> {
    this.transport.write(name, "\r");
  }

  async sendEscape(name: string): Promise<void> {
    this.transport.write(name, "\x1b");
  }

  async sendKeysLiteral(name: string, text: string): Promise<void> {
    this.transport.write(name, text);
  }

  async sendKeysInterpreted(
    name: string,
    text: string,
    opts?: SendOptions
  ): Promise<void> {
    this.transport.write(name, text + (opts?.enter ? "\r" : ""));
  }

  async pasteText(
    name: string,
    text: string,
    opts?: SendOptions
  ): Promise<void> {
    // Bracketed paste so multi-line input isn't submitted line-by-line. Send the
    // body AND the trailing Enter as ONE write: on the Tier-2 host transport each
    // write is a separate fire-and-forget frame, so two writes could drop the body
    // on a dying socket while the Enter lands — submitting an empty/truncated prompt.
    const payload = `\x1b[200~${text}\x1b[201~${opts?.enter ? "\r" : ""}`;
    this.transport.write(name, payload);
  }
}

/** Build the right PtyBackend for the current mode. */
export function createPtyBackend(useHost: boolean): PtyBackend {
  return new PtyBackend(useHost ? new HostTransport() : new LocalTransport());
}
