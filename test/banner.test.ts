/**
 * Locks the session banner to "Stoa" and guards against the rebrand drift that
 * left the old "AgentOS" figlet in app/api/sessions/init-script (it had its own
 * copy of the script, so the rebrand updated only lib/banner.ts and tmux
 * sessions kept printing AgentOS). Pure string assertions, so this runs on the
 * ubuntu/macos/windows CI matrix without bash or tmux.
 */
import { describe, it, expect, afterEach } from "vitest";
import { readFileSync, existsSync, rmSync } from "fs";
import { generateInitScript, writeInitScript, getBanner } from "@/lib/banner";

// Distinctive fragments of each figlet (in the rendered script string):
//  - Stoa "standard" art line 2 has a double pipe: `/ ___|| |_ ___`
//  - the old AgentOS art has `__, |` (the descender of its 'g'), which the
//    Stoa art never produces (Stoa ends `\__,_|`, no `, |`).
const STOA_ART = "/ ___|| |_ ___";
const AGENTOS_ART = "__, |";

describe("session banner (lib/banner.ts) — single source of truth", () => {
  const written: string[] = [];
  afterEach(() => {
    for (const p of written.splice(0)) {
      if (existsSync(p)) rmSync(p, { force: true });
    }
  });

  it("generateInitScript renders the Stoa figlet, never AgentOS", () => {
    const script = generateInitScript("claude --resume abc");
    expect(script).toContain(STOA_ART);
    expect(script).not.toContain(AGENTOS_ART);
    expect(script.toLowerCase()).not.toContain("agentos");
  });

  it("configures the tmux status bar as Stoa and execs the agent verbatim", () => {
    const script = generateInitScript("hermes --yolo");
    expect(script).toContain("#[fg=#cba6f7,bold] Stoa #"); // tmux status-left
    expect(script).toContain("exec hermes --yolo");
  });

  it("writeInitScript writes a runnable bash script with the same Stoa banner", () => {
    const { scriptPath, command } = writeInitScript("codex");
    written.push(scriptPath);
    expect(command).toBe(`bash ${scriptPath}`);
    const onDisk = readFileSync(scriptPath, "utf-8");
    expect(onDisk).toContain(STOA_ART);
    expect(onDisk).not.toContain(AGENTOS_ART);
  });

  it("getBanner() is the Stoa art too", () => {
    const b = getBanner();
    expect(b).toContain(STOA_ART);
    expect(b.toLowerCase()).not.toContain("agentos");
  });
});
