/**
 * Locks the always-on / auto-restart guarantees across all three platforms so
 * they can't silently regress (AGENTS.md: "Lock anything easy to silently
 * regress: command strings, argv"). These assert the SHAPE of the generated
 * launchd plist / systemd unit and the NSSM/CLI wiring by reading the script
 * sources — no tmux/launchd/systemd/nssm is invoked, so it runs on every OS.
 *
 * The guarantees, kept identical on Windows (NSSM), macOS (launchd) and Linux
 * (systemd): (1) start on boot/login, (2) auto-restart if the process stops,
 * (3) `update` restarts THROUGH the supervisor instead of spawning a rogue copy.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";

const read = (rel: string) =>
  readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");

const commandsSh = read("scripts/lib/commands.sh");
const commonSh = read("scripts/lib/common.sh");
const updatePs1 = read("scripts/update-service.ps1");
const installPs1 = read("scripts/install-service.ps1");

describe("macOS launchd auto-restart (guarantee 2)", () => {
  it("KeepAlive is true so launchd relaunches a crashed server", () => {
    expect(commandsSh).toMatch(/<key>KeepAlive<\/key>\s*<true\/>/);
    // The old, broken value must never come back.
    expect(commandsSh).not.toMatch(/<key>KeepAlive<\/key>\s*<false\/>/);
  });

  it("the plist runs the supervisable foreground command, not the self-exiting `start`", () => {
    expect(commandsSh).toMatch(/<string>start-foreground<\/string>/);
    expect(commandsSh).not.toMatch(/<string>start<\/string>\s*<\/array>/);
  });

  it("still starts at login (RunAtLoad)", () => {
    expect(commandsSh).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
  });
});

describe("Linux systemd auto-restart (guarantee 2) + boot (guarantee 1)", () => {
  it("Restart=always (not on-failure, which skips a clean exit)", () => {
    expect(commandsSh).toMatch(/Restart=always/);
    expect(commandsSh).not.toMatch(/Restart=on-failure/);
  });

  it("enables linger so it starts at boot before an interactive login", () => {
    expect(commandsSh).toMatch(/loginctl enable-linger/);
  });

  it("still installs + enables the user unit", () => {
    expect(commandsSh).toMatch(/systemctl --user enable stoa/);
    expect(commandsSh).toMatch(/WantedBy=default\.target/);
  });

  it("runs the supervisable foreground command (ExecStart=start-foreground)", () => {
    expect(commandsSh).toMatch(/ExecStart=\$script_path start-foreground/);
  });
});

describe("POSIX `stoa update` restarts via the service manager (guarantee 3)", () => {
  it("defines the service helpers used to drive launchd/systemd", () => {
    for (const fn of [
      "service_unit_path",
      "service_enabled",
      "stop_service",
      "start_service",
    ]) {
      expect(commonSh).toContain(`${fn}()`);
    }
  });

  it("stop_service / start_service speak to launchctl AND systemctl", () => {
    expect(commonSh).toMatch(/launchctl unload/);
    expect(commonSh).toMatch(/systemctl --user stop stoa/);
    expect(commonSh).toMatch(/launchctl load/);
    expect(commonSh).toMatch(/systemctl --user start stoa/);
  });

  it("cmd_update goes through stop_for_update / resume_after_update, not a raw cmd_start", () => {
    // Bound the slice to cmd_update's body — cmd_start_foreground() lives later
    // in the file and would otherwise match the "cmd_start" substring check.
    const start = commandsSh.indexOf("cmd_update()");
    const end = commandsSh.indexOf("cmd_enable()", start);
    const update = commandsSh.slice(start, end);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(update).toContain("stop_for_update");
    expect(update).toContain("resume_after_update");
    // The bug we fixed: cmd_update must not background a rogue copy via cmd_start.
    expect(update).not.toContain("cmd_start");
  });

  it("the update wrappers branch on service_enabled", () => {
    expect(commandsSh).toMatch(
      /stop_for_update\(\)\s*\{[\s\S]*?service_enabled/
    );
    expect(commandsSh).toMatch(
      /resume_after_update\(\)\s*\{[\s\S]*?service_enabled/
    );
  });
});

describe("Windows NSSM service guarantees stay locked", () => {
  it("auto-start on boot + auto-restart on any exit", () => {
    expect(installPs1).toMatch(/Start SERVICE_AUTO_START/);
    expect(installPs1).toMatch(/AppExit Default Restart/);
  });

  it("locks the service launch command (node + tsx + server.ts) and production env", () => {
    expect(installPs1).toMatch(/nssm install \$ServiceName \$node/);
    expect(installPs1).toContain("server.ts");
    expect(installPs1).toMatch(/NODE_ENV=production/);
  });
});

describe("Windows script hardening (the bugs we fixed)", () => {
  it("self-elevation quotes -ServiceName (survives names with spaces)", () => {
    expect(installPs1).toContain('-ServiceName `"$ServiceName`"');
    expect(updatePs1).toContain('-ServiceName `"$ServiceName`"');
  });

  it("self-elevation waits and propagates the elevated exit code", () => {
    for (const s of [installPs1, updatePs1]) {
      expect(s).toMatch(/Start-Process[\s\S]*?-Wait -PassThru/);
      expect(s).toContain("exit $proc.ExitCode");
    }
  });

  it("update-service guards against a stray manual `stoa start` (EADDRINUSE)", () => {
    expect(updatePs1).toMatch(/stoa\.pid/);
    expect(updatePs1).toMatch(/\$Cli stop/);
  });

  it("update-service checks the nssm start exit code, not just a status snapshot", () => {
    expect(updatePs1).toContain("$startExit = $LASTEXITCODE");
    expect(updatePs1).toMatch(/\$startExit -ne 0/);
  });
});
