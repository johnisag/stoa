/**
 * Host implementation of SessionBackend (Tier 2).
 *
 * Same contract as PtyBackend, but proxies to the pty-host daemon over IPC so
 * sessions survive web-server restarts. Selected when AGENT_OS_PTY_HOST=1.
 */

import { isWindows, resolveBinary } from "../../platform";
import type {
  SessionBackend,
  SessionActivity,
  CaptureOptions,
  CreateOptions,
  SendOptions,
} from "../types";
import { getHostClient } from "./host-client";

export class HostBackend implements SessionBackend {
  private client = getHostClient();

  async create({
    name,
    cwd,
    command,
    binary,
    args,
  }: CreateOptions): Promise<void> {
    if (binary && binary.length > 0) {
      await this.client.spawn(name, { binary, args: args ?? [], cwd });
      return;
    }
    // Banner-command fallback through a shell (POSIX banner caveat applies).
    if (isWindows) {
      const pwsh = resolveBinary("pwsh");
      await this.client.spawn(
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
      await this.client.spawn(name, {
        binary: process.env.SHELL || "/bin/bash",
        args: ["-c", command],
        cwd,
      });
    }
  }

  async kill(name: string): Promise<void> {
    await this.client.kill(name);
  }

  async rename(oldName: string, newName: string): Promise<void> {
    await this.client.rename(oldName, newName);
  }

  async exists(name: string): Promise<boolean> {
    return this.client.exists(name);
  }

  async list(): Promise<string[]> {
    return this.client.list();
  }

  async listWithActivity(): Promise<SessionActivity[]> {
    return this.client.listActivity();
  }

  async getPanePath(name: string): Promise<string | null> {
    return this.client.panePath(name);
  }

  async getEnv(): Promise<string | null> {
    // Same as the pty backend: a pty can't read its child's env; callers fall
    // back to Claude's JSONL on disk.
    return null;
  }

  async capture(name: string, opts?: CaptureOptions): Promise<string> {
    return this.client.capture(name, opts?.lines);
  }

  async sendEnter(name: string): Promise<void> {
    this.client.input(name, "\r");
  }

  async sendKeysLiteral(name: string, text: string): Promise<void> {
    this.client.input(name, text);
  }

  async sendKeysInterpreted(
    name: string,
    text: string,
    opts?: SendOptions
  ): Promise<void> {
    this.client.input(name, text + (opts?.enter ? "\r" : ""));
  }

  async pasteText(
    name: string,
    text: string,
    opts?: SendOptions
  ): Promise<void> {
    this.client.input(name, `\x1b[200~${text}\x1b[201~`);
    if (opts?.enter) this.client.input(name, "\r");
  }
}
