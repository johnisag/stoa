import { describe, it, expect } from "vitest";

// Regression guard for B002 — spawnNodeServer's env construction.
//
// The bug: spawnNodeServer built a POSIX-minimal env (PATH/HOME/USER/SHELL/
// TERM/LANG) UNCONDITIONALLY and spawned with `shell: true`. On Windows
// `shell: true` launches cmd.exe, which needs SystemRoot/ComSpec just to start
// and PATHEXT to resolve `.cmd` shims (npm/npx/next). None of those were in the
// minimal env, so dev servers failed to launch on Windows. USER/SHELL are also
// undefined Windows concepts.
//
// The fix extracts a pure `buildServerEnv` that:
//   - POSIX: stays byte-identical to the historical minimal env.
//   - Windows: spreads the parent env (so cmd.exe can start + resolve shims)
//     and overrides only HOME (+ PORT).
//
// We assert the env CONSTRUCTION for both platforms via the `windows` flag so
// the test is deterministic on any host OS.

import { buildServerEnv } from "@/lib/dev-servers";

describe("buildServerEnv (B002)", () => {
  describe("POSIX branch stays minimal + byte-identical", () => {
    const parentEnv = {
      PATH: "/usr/bin:/bin",
      USER: "alice",
      SHELL: "/bin/bash",
      TERM: "screen-256color",
      LANG: "en_GB.UTF-8",
      // These must NOT leak through on POSIX (the minimal-env contract).
      SECRET_TOKEN: "leak-me",
      SystemRoot: "C:\\Windows",
    } as unknown as NodeJS.ProcessEnv;

    it("includes exactly the minimal keys (+ PORT when given)", () => {
      const env = buildServerEnv({
        windows: false,
        home: "/home/alice",
        parentEnv,
        port: 3001,
      });

      expect(env).toEqual({
        PATH: "/usr/bin:/bin",
        HOME: "/home/alice",
        USER: "alice",
        SHELL: "/bin/bash",
        TERM: "screen-256color",
        LANG: "en_GB.UTF-8",
        PORT: "3001",
      });

      // No parent env leakage — the whole point of the minimal env.
      expect(env.SECRET_TOKEN).toBeUndefined();
      expect(env.SystemRoot).toBeUndefined();
    });

    it("falls back to default TERM/LANG when unset", () => {
      const env = buildServerEnv({
        windows: false,
        home: "/home/alice",
        parentEnv: { PATH: "/usr/bin" } as unknown as NodeJS.ProcessEnv,
      });

      expect(env.TERM).toBe("xterm-256color");
      expect(env.LANG).toBe("en_US.UTF-8");
      // No port arg → no PORT key (not an empty / "undefined" string).
      expect("PORT" in env).toBe(false);
    });
  });

  describe("Windows branch carries the full env for cmd.exe", () => {
    const parentEnv = {
      PATH: "C:\\Windows\\System32;C:\\nodejs",
      SystemRoot: "C:\\Windows",
      ComSpec: "C:\\Windows\\System32\\cmd.exe",
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
      USERPROFILE: "C:\\Users\\alice",
      APPDATA: "C:\\Users\\alice\\AppData\\Roaming",
      TEMP: "C:\\Users\\alice\\AppData\\Local\\Temp",
      windir: "C:\\Windows",
    } as unknown as NodeJS.ProcessEnv;

    it("preserves the cmd.exe startup contract (SystemRoot/ComSpec/PATHEXT/...)", () => {
      const env = buildServerEnv({
        windows: true,
        home: "C:\\Users\\alice",
        parentEnv,
        port: 5173,
      });

      // The keys whose absence broke Windows must all survive.
      expect(env.SystemRoot).toBe("C:\\Windows");
      expect(env.ComSpec).toBe("C:\\Windows\\System32\\cmd.exe");
      expect(env.PATHEXT).toBe(".COM;.EXE;.BAT;.CMD");
      expect(env.USERPROFILE).toBe("C:\\Users\\alice");
      expect(env.APPDATA).toBe("C:\\Users\\alice\\AppData\\Roaming");
      expect(env.TEMP).toBe("C:\\Users\\alice\\AppData\\Local\\Temp");
      expect(env.windir).toBe("C:\\Windows");
      expect(env.PATH).toBe("C:\\Windows\\System32;C:\\nodejs");
    });

    it("overrides HOME and sets PORT without dropping parent keys", () => {
      const env = buildServerEnv({
        windows: true,
        home: "C:\\Users\\alice",
        parentEnv,
        port: 5173,
      });

      expect(env.HOME).toBe("C:\\Users\\alice");
      expect(env.PORT).toBe("5173");
    });

    it("does not invent POSIX-only USER/SHELL keys", () => {
      const env = buildServerEnv({
        windows: true,
        home: "C:\\Users\\alice",
        parentEnv,
      });

      // parentEnv has no USER/SHELL → we must not synthesize them, and no PORT
      // when none was requested.
      expect("USER" in env).toBe(false);
      expect("SHELL" in env).toBe(false);
      expect("PORT" in env).toBe(false);
    });
  });
});
