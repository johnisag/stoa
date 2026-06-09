import { describe, it, expect, vi, beforeEach } from "vitest";
import path from "path";

const childProcess = vi.hoisted(() => ({
  spawn: vi.fn(),
  unref: vi.fn(),
}));

vi.mock("child_process", () => ({
  spawn: childProcess.spawn,
}));

import { HostClient } from "@/lib/session-backend/pty/host-client";

describe("pty-host daemon spawn", () => {
  beforeEach(() => {
    childProcess.unref.mockReset();
    childProcess.spawn.mockReset();
    childProcess.spawn.mockReturnValue({ unref: childProcess.unref });
  });

  it("launches through the tsx loader directly so Windows does not flash a CLI child", () => {
    const client = new HostClient();

    (
      client as unknown as {
        spawnHost(): void;
      }
    ).spawnHost();

    expect(childProcess.spawn).toHaveBeenCalledTimes(1);
    const [file, args, options] = childProcess.spawn.mock.calls[0] as [
      string,
      string[],
      { detached: boolean; stdio: string; windowsHide: boolean },
    ];

    const joinedArgs = args.join("\n").replaceAll("\\", "/");
    expect(file).toBe(process.execPath);
    expect(joinedArgs).toContain("node_modules/tsx/dist/preflight.cjs");
    expect(joinedArgs).toContain("node_modules/tsx/dist/loader.mjs");
    expect(joinedArgs).toContain("scripts/pty-host.ts");
    expect(joinedArgs).not.toContain("node_modules/tsx/dist/cli.mjs");
    expect(args.at(-1)).toContain(path.join("scripts", "pty-host.ts"));
    expect(options).toMatchObject({
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    expect(childProcess.unref).toHaveBeenCalledTimes(1);
  });
});
