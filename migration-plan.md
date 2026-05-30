# AgentOS → Native Windows Migration Plan

**Status:** Proposed
**Author:** Deep analysis by 3 expert agents, synthesized
**Date:** 2026-05-30
**Goal:** Run AgentOS natively on Windows (no WSL, no tmux) with full feature parity, robustness, and stability — while remaining fully functional on macOS/Linux.

---

## 1. Executive Summary

AgentOS does not run on native Windows for one root reason: **tmux is the process supervisor for every agent session, and tmux does not exist on Windows.** A secondary reason is a broad set of POSIX assumptions (Unix shells, `/tmp`, `lsof`, `which`, `~`/`$HOME`, `sed`/`head`, bash install scripts).

The good news, established by the analysis:

- **node-pty already works on Windows** via ConPTY — `win32-x64` and `win32-arm64` prebuilds ship in the dependency today. The PTY primitive is solved; only _what it spawns_ (a Unix shell that runs `tmux attach`) and the surrounding Unix tooling are the problem.
- **No npm dependency is hard-blocked on Windows.** Every blocker is in application code or bash-only install/run scripts.
- The migration is fundamentally an **architecture inversion**: today tmux owns the agent processes and AgentOS attaches to them; in the target, **AgentOS itself owns the processes** via a server-side PTY registry.

The native design actually _removes_ layers. Today's chain is:

```
WebSocket → bare shell (server.ts) → tmux attach (page.tsx) → init-script (tmpfile) → exec agent
```

The target is:

```
WebSocket → server-side PTY registry → ConPTY(agent binary, argv[], cwd, env)
```

### Decision: two-tier delivery

The one genuinely hard problem is **surviving an AgentOS server restart**. tmux gives this for free because it is a separate OS-level daemon; a ConPTY child of the Node process dies when Node dies. We therefore ship in two tiers:

- **Tier 1 (covers ~95% of real usage):** in-process PTY registry. Agents survive **browser disconnect**, full scrollback, multi-client attach, status detection, orchestration. Agents do **not** survive an AgentOS server restart. This is the valuable, shippable milestone.
- **Tier 2 (full parity):** a separate long-lived **PTY-host daemon** (or Windows Service) that owns the registry and survives Next.js restarts, with AgentOS connecting over a local socket. This restores tmux's "survives server restart + full scrollback" guarantee natively.

Do **not** let the hard 5% (Tier 2) block shipping the valuable 95% (Tier 1).

---

## Implementation Status (2026-05-30)

All phases implemented on branch `feat/windows-native-migration`; `tsc`, `next build`, and `npm test` (15 tests) are green.

- **Phase 0 — Foundations:** ✅ `lib/platform.ts`, cross-env, bundled ripgrep, Node CLI, postinstall.
- **Phase 1 — SessionBackend abstraction:** ✅ all tmux calls behind one interface (`lib/session-backend`).
- **Phase 2 — Native pty backend (Tier 1):** ✅ `PtySession` (node-pty + `@xterm/headless` + ring buffer), registry, `server.ts` subscribe/replay/fan-out, client attach protocol. Builds + headless smoke + dev runtime verified. ⚠️ Interactive browser flow still needs hands-on verification on Windows.
- **Phase 3 — Cross-platform hardening:** ✅ ports/search/git/pr/projects/dev-servers/env-setup/file-APIs, exec route, `claude/process-manager`, file-picker drive roots, basename display, `.husky` hook.
- **Phase 4 — Provider argv:** ✅ `buildAgentArgs`; `CreateOptions` carries structured `binary/args`; orchestration + summarize spawn argv on the pty path (no bash banner). The POSIX banner remains for the tmux path.
- **Phase 5 — Install/distribution:** ✅ `scripts/agent-os.js`, `scripts/install.ps1`, README Windows section, cross-platform precommit.
- **Phase 6 — Tier 2 pty-host daemon:** ✅ opt-in via `AGENT_OS_PTY_HOST=1` (default OFF). IPC protocol + host daemon + client + `HostBackend` + `server.ts` host streaming. Verified: daemon launches/listens/dedupes, cross-process connect works, and a session survives a client disconnect (simulated server restart) in the test suite.
- **Testing:** ✅ vitest with `buildAgentArgs`, pty-session integration, and Tier-2 daemon survival tests.

### Remaining follow-ups

- Hands-on browser verification of the Phase 2 interactive flow on native Windows (spawn a real `claude`, stream, resize, reconnect).
- Windows `.cmd` spawning of agent CLIs through ConPTY (resolution logic in place; needs live confirmation).
- Orchestration's bash banner is POSIX-only; native-Windows orchestration uses the argv path (no status-bar styling).
- Cross-OS CI matrix (windows/ubuntu/macos) for the test suite.

---

## 2. Current Architecture (How tmux Is Used)

### 2.1 tmux's four jobs

| Job                                                                   | Where (file:line)                                                                                                                                                                                                              | tmux mechanism                                                                   |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| **Persistence** — agent survives browser disconnect / server restart  | `app/page.tsx:207-212`                                                                                                                                                                                                         | `tmux new-session -d` + `tmux attach` (separate daemon)                          |
| **Output capture** — read screen for status/preview without attaching | `lib/status-detector.ts:229-231`, `app/api/sessions/status/route.ts:140-142`, `app/api/sessions/[id]/preview/route.ts:23-25`, `app/api/sessions/[id]/summarize/route.ts:88-91,156-158`, `lib/orchestration.ts:192-194,330-332` | `tmux capture-pane -p [-S -N]`                                                   |
| **Input injection** — type into a session from API routes             | `app/api/sessions/[id]/send-keys/route.ts:73-95`, `lib/orchestration.ts:207,238-241,355-357`, `app/api/sessions/[id]/summarize/route.ts:182-189`                                                                               | `tmux send-keys`, `load-buffer`/`paste-buffer`                                   |
| **Isolation / lifecycle** — named, independent sessions               | everywhere                                                                                                                                                                                                                     | named sessions, `has-session`, `kill-session`, `rename-session`, `list-sessions` |

### 2.2 The key insight

**Creating a session does not spawn a process** — `app/api/sessions/route.ts:51` only inserts a DB row and computes `tmuxName = ${agentType}-${id}` (`route.ts:144`). The agent process is born **lazily** when the browser attaches and `app/page.tsx:207-212` runs the load-bearing command:

```bash
tmux set -g mouse on 2>/dev/null; tmux attach -t <name> 2>/dev/null || tmux new -s <name> -c "<cwd>" "<command>"
```

This "attach-if-exists-else-create" is the entire persistence mechanism. The pty in `server.ts:62` is a **disposable bare shell** — killed on every WebSocket close (`server.ts:110-111`) — that exists only to host `tmux attach`. Because tmux is a separate daemon, killing that shell is harmless: the agent keeps running.

The DB `tmux_name` column (`lib/db/types.ts`) is the durable join key that lets a session reattach after a server restart.

### 2.3 Status detection depends on _rendered_ terminal text

`lib/status-detector.ts` is the most behavior-sensitive consumer. It combines:

1. **An activity timestamp** — `tmux list-sessions -F '#{session_name}\t#{session_activity}'` (`status-detector.ts:202-203`), cached 2s. The spike detector (`:254-296`) keys entirely off changes to this integer-seconds value.
2. **Rendered pane text** — `tmux capture-pane -p` (`:227-236`), scanned for:
   - **Busy** (`checkBusyIndicators`, `:166-186`): last 10 lines for `"esc to interrupt"`, `"tokens"` + a whimsical word (`thinking`/`working`/`brewing`/…, ~110 words `:40-131`); last 5 lines for Braille spinner chars `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏` (`:38`).
   - **Waiting** (`checkWaitingPatterns`, `:188-191`): last 5 lines against `/\[Y\/n\]/i`, `/Allow\?/i`, `/Approve\?/i`, `/Press Enter to/i`, `/Do you want to/i`, `/Yes, allow all/i`, etc. (`:133-148`).

**Critical constraint:** these heuristics assume a **rendered terminal grid** where a spinner line overwrites itself in place. If a native backend feeds raw append-only pty bytes, every spinner frame accumulates and the "last N lines" windows fill with escape sequences — detection breaks. **The native backend must run a headless VT emulator and snapshot the visible grid**, reproducing `capture-pane -p` semantics.

---

## 3. Target Architecture

### 3.1 The `SessionBackend` contract

A single interface, with a `tmux` implementation (today's behavior, macOS/Linux) and a `pty` implementation (cross-platform, ConPTY on Windows). Selected by platform/config. This is the highest-leverage refactor and the first step regardless of how far the native backend is taken.

```ts
interface SessionBackend {
  // Lifecycle
  spawn(
    key: string,
    command: string,
    args: string[],
    opts: {
      cwd: string;
      env: Record<string, string>;
      cols: number;
      rows: number;
    }
  ): Promise<void>; // replaces tmux new-session -d / new -s
  exists(key: string): boolean; // replaces tmux has-session
  list(): SessionInfo[]; // replaces tmux list-sessions; includes lastActivity
  rename(oldKey: string, newKey: string): void; // replaces tmux rename-session
  kill(key: string): Promise<void>; // replaces tmux kill-session

  // I/O
  write(key: string, data: string): void; // replaces send-keys / load-buffer+paste-buffer
  resize(key: string, cols: number, rows: number): void;
  readScrollback(key: string, lines: number): string; // replaces capture-pane -p -S -N (RENDERED grid)
  readVisible(key: string): string; // replaces capture-pane -p (visible screen only)

  // Streaming (Tier 1+)
  subscribe(key: string, ws: WebSocket): void; // multi-client attach + scrollback replay
  unsubscribe(key: string, ws: WebSocket): void; // detach without killing

  // Signal
  lastActivity(key: string): number; // ms timestamp, replaces #{session_activity}
}

interface SessionInfo {
  key: string;
  cwd: string;
  lastActivity: number;
  alive: boolean;
  env: Record<string, string>;
}
```

### 3.2 The `PtySession` (native implementation building block)

Each managed session holds:

- The `node-pty` `IPty` handle (ConPTY on Windows).
- A **headless VT emulator** (e.g. `@xterm/headless` or a server-side VT parser) fed every `onData` chunk, so `readScrollback`/`readVisible` return rendered rows — satisfying the status heuristics (§2.3) unchanged.
- A **scrollback ring buffer** (rendered rows, cap ~1–4 MB / N lines) for fast "last N lines" queries (N ranges 5→500) and for replay on reconnect.
- A `Set<WebSocket>` of subscribers for input/output fan-out.
- Metadata: `cwd`, `env`, `lastActivity` (updated on every `onData`), per-subscriber `{cols, rows}`.

The registry is a module-level `Map<string, PtySession>` that outlives any single WebSocket (Tier 1) or lives in a separate daemon (Tier 2).

### 3.3 How this maps to the hard problems

| Problem                               | tmux today                                         | Native design                                                                                       |
| ------------------------------------- | -------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| **Persist across browser disconnect** | `kill()` on WS close is harmless; agent is in tmux | Stop killing on `ws.close`; just `unsubscribe`. Kill only on explicit delete/kill-all.              |
| **Multi-client attach**               | tmux multiplexes natively                          | `PtySession.subscribers` fan-out; input from any subscriber → single pty                            |
| **Scrollback replay on reconnect**    | `tmux attach` repaints                             | Replay ring buffer to new subscriber, then live-stream                                              |
| **Resize with multiple clients**      | tmux uses smallest client (window-size)            | Track per-subscriber size; resize ConPTY to **min** on any change/unsubscribe                       |
| **Survive server restart**            | tmux is a separate daemon                          | **Tier 1:** regression (agents die). **Tier 2:** separate PTY-host daemon/Service over local socket |

---

## 4. Phased Implementation Plan

### Phase 0 — Foundations & quick wins (low risk, ships immediately)

Independent of the backend swap; valuable on all platforms.

1. **`.npmrc`** with `legacy-peer-deps=true` (already done) to clear the xterm v6 peer conflict.
2. Add deps: **`cross-env`** (fix `NODE_ENV=` scripts) and **`@vscode/ripgrep`** (bundle `rg`, exposes `rgPath`).
3. **package.json scripts:**
   - `package.json:32` `"start"`: `NODE_ENV=production tsx server.ts` → `cross-env NODE_ENV=production tsx server.ts` _(Blocker for prod start on Windows)_
   - `package.json:33` `"postinstall"`: replace `chmod ... 2>/dev/null || true` with a Node script that no-ops on `win32`.
   - `package.json` `bin`: point `agent-os` at a cross-platform **`scripts/agent-os.js`** (`#!/usr/bin/env node`) instead of the bash script.
4. **ripgrep:** `lib/code-search.ts:8` (`execSync("which rg")`), `:66,106` — replace detection + bare `rg` with `@vscode/ripgrep`'s `rgPath`. Removes the prerequisite entirely.
5. **Port probing:** `lib/ports.ts:23-24` and `lib/dev-servers.ts:56,68` — replace `lsof ... | head -1` with a Node `net.createServer().listen()` probe (cross-platform).

### Phase 1 — The `SessionBackend` abstraction (no behavior change)

The safest, highest-leverage step. Extract the scattered tmux calls (currently in `lib/orchestration.ts`, `lib/status-detector.ts`, `app/api/sessions/*`, `app/api/tmux/*`, `app/page.tsx`) behind the `SessionBackend` interface. Ship **only the `tmux` implementation**, wired so behavior is byte-for-byte identical on macOS/Linux. This turns "should we do this?" into a reviewable diff and de-risks everything after.

Touchpoint inventory to route through the interface:

| file:line                                                              | tmux command                                                           | Interface method                                |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------- |
| `app/page.tsx:207-212`                                                 | attach-or-create                                                       | `spawn` + `subscribe`                           |
| `app/api/sessions/[id]/route.ts:72`, `app/api/tmux/rename/route.ts:20` | `rename-session`                                                       | `rename`                                        |
| `app/api/tmux/kill-all/route.ts:14,31`                                 | `list-sessions`, `kill-session`                                        | `list` + `kill`                                 |
| `app/api/sessions/[id]/send-keys/route.ts:51`                          | `has-session`                                                          | `exists`                                        |
| `send-keys/route.ts:73-95`                                             | `load-buffer`/`paste-buffer`/`send-keys Enter`                         | `write`                                         |
| `app/api/sessions/status/route.ts:28,39,55,140-142`                    | `list-sessions`, `display-message`, `show-environment`, `capture-pane` | `list` / metadata / `readScrollback`            |
| `lib/status-detector.ts:202-203,227-236`                               | `list-sessions -F activity`, `capture-pane`                            | `lastActivity` + `readVisible`/`readScrollback` |
| `lib/orchestration.ts:171,192-194,207,238-241,330-332,355-357,397`     | `new-session -d`, `capture-pane`, `send-keys`, `kill-session`          | `spawn`/`readScrollback`/`write`/`kill`         |
| `app/api/sessions/[id]/preview/route.ts:23-25`                         | `capture-pane -S -100`                                                 | `readScrollback(100)`                           |
| `app/api/sessions/[id]/summarize/route.ts:88-91,156-189`               | `capture-pane`, paste-buffer                                           | `readScrollback`/`readVisible`/`write`          |

`components/TmuxSessions.tsx` appears **dead/unwired** (not referenced in `DesktopView`); confirm and remove, or repoint at `backend.list()`.

### Phase 2 — Native PTY backend, Tier 1 (in-process registry)

Implement the `pty` `SessionBackend`:

1. **Registry**: module-level `Map<string, PtySession>` in the server process.
2. **`spawn`**: `pty.spawn(binary, argv[], { cwd, env, cols, rows })` — **the agent binary directly**, not a shell. Eliminates `app/page.tsx:207-212`'s shell-string construction, the init-script (`app/api/sessions/init-script/route.ts`), and `lib/banner.ts`'s bash wrapper. Banner, if kept, is printed by the server around spawn.
3. **VT emulator + ring buffer** per session (§3.2) so `readScrollback`/`readVisible` return rendered text.
4. **Streaming**: `server.ts` `/ws/terminal` becomes a thin subscribe/unsubscribe bridge:
   - On connect: parse `{type:"attach", key, ...}`; `backend.subscribe(key, ws)`; replay ring buffer; live-stream `onData`.
   - **Remove `ptyProcess.kill()` from `ws.close`** (`server.ts:110-111`) — call `backend.unsubscribe` instead.
   - Input from any subscriber → `backend.write(key, data)`.
   - Resize → recompute min over subscribers → `backend.resize`.
5. **Client protocol change**: `app/page.tsx` `runSessionInTerminal`/`buildSessionCommand` (`:148-217`) stop building shell strings. Send a structured `{type:"attach", key, binary, args, cwd, env}`. The `\x02d` detach (`:238`) and `\x03` (`:243`) keystroke hacks are deleted — switching sessions = unsubscribe A, subscribe B.
6. **Input simplification**: `send-keys/route.ts` and `summarize/route.ts` drop the `load-buffer`/`paste-buffer`/temp-file dance → `backend.write(text)` + `write("\r")`. Wrap multi-line writes in **bracketed paste** (`\e[200~`…`\e[201~`) so multi-line prompts aren't submitted line-by-line. Use `\r` (not `\n`) for Enter.
7. **Status detector**: unchanged logic — `getStatus` reads `backend.readVisible/readScrollback` (rendered) and `backend.lastActivity` (now ms-precise; the 1s/120s tmux-granularity constants `status-detector.ts:23-29` can be revisited but keep behavior identical first).

### Phase 3 — Cross-platform code hardening

Systematic removal of POSIX assumptions (full inventory in §6). Themes:

- **Stop using a shell for programmatic commands.** Convert `execAsync("git ... | sed ...")` / `execSync("gh ... '...'")` across `lib/git.ts`, `lib/pr.ts`, `lib/pr-generation.ts`, `lib/git-status.ts`, `lib/orchestration.ts` to **`execFile`/`spawn` with arg arrays** + `cwd`. Do pipe/parse logic in JS (already done for `worktree list --porcelain`). Kills quoting bugs, `2>/dev/null`, `| head`, `| sed`, and injection surface in one move.
- **Path discipline**: one `expandHome` helper (`os.homedir()`), always `path.join`/`path.basename`, never `process.env.HOME` or `/`-splitting. ~40 violation sites listed in §6.
- **`/tmp` → `os.tmpdir()`**; **`which` → `where` (or bundled binary)**; **`lsof` → Node net probe**.
- **Interactive shell selection** in `server.ts` and `app/api/exec/route.ts`: Windows → `pwsh.exe` ?? `powershell.exe` ?? `%ComSpec%`; inherit full `process.env` (Windows console apps need `SystemRoot`/`PATH`/`USERPROFILE`/`APPDATA`/`TEMP`) instead of the curated minimal env.
- **Remove hardcoded binary path** `lib/claude/process-manager.ts:149` (nvm path) → PATH resolution / `shell:true` for `.cmd` shims.

### Phase 4 — Provider layer (argv, not shell strings)

`lib/providers.ts` / `lib/providers/registry.ts` currently return flags as a **joined string** with embedded POSIX single-quote escaping (`prompt.replace(/'/g, "'\\''")`) and combined tokens (`--resume <id>` as one string). For native `pty.spawn(binary, argv[])`:

- Return **argv arrays**, split combined tokens (`["--resume", id]`, `["--model", model]`).
- **Remove all manual quoting** — argv entries are passed literally; quoting would put literal quotes into argv. _(Correctness change, not cosmetic.)_
- **Windows binary resolution**: `claude` → `claude.cmd`, `cursor-agent`, `aider` (Python entry) etc. resolve via PATH; `spawn` of `.cmd` needs `shell:true` or `.cmd`-aware resolution.
- Fix latent `omp` escape bug (`providers.ts:530`, `"'\\'"` vs `"'\\''"`) — moot once quoting is removed.
- `claude-session/route.ts:18-20` (`tmux show-environment CLAUDE_SESSION_ID`) has no native analog → read the session id from the **Claude JSONL-on-disk path** already implemented in `status/route.ts:71-122`. Note `status/route.ts:74` / `summarize/route.ts:30` derive the Claude project dir via `projectPath.replace(/\//g, "-")` — must match Claude's **actual Windows** dir-naming convention (separator handling).

### Phase 5 — Install & distribution (Windows)

Current distribution is two Windows-hostile bash paths (`scripts/install.sh` → `agent-os install` → `scripts/lib/*.sh`: `chmod`, `ln -sf`, `rsync`, `nohup`, `kill -0`, launchd/systemd, brew/apt/yum, `/tmp`; and `bin` pointing at a bash script).

1. **`install.ps1`** (`irm https://.../install.ps1 | iex`): checks Node 20+ / Git (hint `winget install OpenJS.NodeJS.LTS Git.Git`), clones/updates, `npm install --legacy-peer-deps` + `npm run build`, autostart via **Scheduled Task** (`Register-ScheduledTask`) or Startup shortcut.
2. **`scripts/agent-os.js`** (Node) implementing `start/stop/status/run/update` via `child_process` + PID file (or Windows Service) — same `bin` works everywhere; npm generates a working `.cmd` shim; also resolves the `NODE_ENV=` start blocker.
3. **Prerequisites on Windows**: tmux **removed**; ripgrep **bundled** (`@vscode/ripgrep`); git/gh/docker/AI-CLIs detected via `where` with winget hints.
4. **Tauri desktop**: `tauri.conf.json` already declares `bundle.windows` + `icon.ico` → cleanest Windows vector (MSI/NSIS), once the server starts cross-platform. `Dockerfile.linux`/`tauri:build:linux` are irrelevant to Windows.
5. **`.husky/pre-commit`** (`grep`/`xargs`/`[ ]`) → call a Node script (e.g. lint-staged).

### Phase 6 — Tier 2: PTY-host daemon (full restart-survival parity)

The only design that natively reproduces tmux's "survives AgentOS restart + full scrollback":

- A separate long-lived process (Node "pty-host", or a Windows Service) owns the registry + ring buffers and survives Next.js restarts.
- AgentOS connects over a **local socket** (named pipe on Windows / Unix domain socket elsewhere); the `pty` `SessionBackend` becomes a thin client of it.
- The DB `tmux_name`/`key` remains the durable join key for reattach after restart.
- Alternatives considered and rejected for the primary path: detached child processes (`detached:true`) lose the ConPTY handle/scrollback on restart (partial only); a real multiplexer (abduco/dtach/tmux-on-WSL) defeats the native-Windows goal.

---

## 5. Hard Problems & Key Decisions

1. **Rendered vs raw scrollback (must-fix).** Status detection (§2.3) only works on a rendered terminal grid. The native backend **must** run a headless VT emulator; a raw byte stream breaks busy/waiting detection. This is the single most important correctness requirement.
2. **Server-restart survival (Tier 2).** Accept the Tier 1 regression and document WSL2 as the "bulletproof persistence" fallback until Tier 2 lands. Don't block Tier 1 on it.
3. **Multi-client resize.** With one ConPTY and N clients, replicate tmux's smallest-client policy: resize to the min of subscriber sizes on any change/unsubscribe.
4. **Argv vs shell strings (provider layer).** Switching to argv arrays removes all manual quoting; this is a correctness change that touches every provider and the orchestration task-send path.
5. **Bracketed paste.** Multi-line prompt injection must wrap in `\e[200~`…`\e[201~` so CLIs don't submit line-by-line (tmux `paste-buffer` effectively did this).

---

## 6. Portability Landmine Inventory (Phase 3/4 detail)

Severity: **Blocker** = native Windows can't function; **Major** = feature broken; **Minor** = cosmetic.

| File:line                                                                                                                   | Unix assumption                                                         | Fix                                                         | Severity             |
| --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------- | -------------------- |
| `server.ts:49,53-59,66`                                                                                                     | `SHELL\|\|/bin/zsh`; curated `PATH=/usr/local/bin:...`; `cwd:HOME\|\|/` | platform shell; `os.homedir()`; inherit full env on Windows | Blocker              |
| `app/api/exec/route.ts:27,30-31`                                                                                            | `shell:"/bin/zsh"`, brew PATH                                           | platform default shell; drop brew PATH on win               | Blocker              |
| `lib/claude/process-manager.ts:149`                                                                                         | hardcoded nvm `claude` path                                             | PATH resolve / `shell:true`                                 | Blocker              |
| `lib/code-search.ts:8,66,106`                                                                                               | `which rg`; bare `rg`; "brew install" msg                               | `@vscode/ripgrep` `rgPath`                                  | Blocker (search)     |
| `package.json:32`                                                                                                           | `NODE_ENV=` start prefix                                                | `cross-env`                                                 | Blocker (prod start) |
| `package.json:33`                                                                                                           | `chmod ... 2>/dev/null \|\| true` postinstall                           | Node script, no-op on win32                                 | Major                |
| `package.json` `bin`                                                                                                        | bash `scripts/agent-os`                                                 | Node `scripts/agent-os.js`                                  | Blocker (CLI)        |
| `scripts/install.sh`, `scripts/agent-os`, `scripts/setup.sh`, `scripts/lib/*.sh`                                            | full bash: chmod/ln/rsync/nohup/launchd/systemd/brew/apt                | `install.ps1` + Node CLI (§4.5)                             | Blocker (install)    |
| `lib/banner.ts:12-65`, `app/api/sessions/init-script/route.ts:10-56`                                                        | `#!/bin/bash` script, `chmod 0o755`, `id -u`, `sleep`, `export`, tmux   | drop wrapper; print banner from Node                        | Blocker              |
| `lib/ports.ts:23-24`, `lib/dev-servers.ts:56,68`                                                                            | `lsof -i ... \| head -1`                                                | Node `net` probe; `netstat -ano` for PID                    | Major                |
| `lib/dev-servers.ts:9,163-168`                                                                                              | `HOME\|\|"~"` logs dir; `~/` expand                                     | `os.homedir()`                                              | Major                |
| `lib/dev-servers.ts:201,203`                                                                                                | `cd "${cwd}" && ${cmd}` shell prefix                                    | drop `cd` (cwd already set); `env` for vars                 | Major                |
| `lib/dev-servers.ts:107,229,...`                                                                                            | `docker ... 2>/dev/null \|\| echo ""`, single-quoted `{{ }}`            | no-shell exec; exit code in JS                              | Major                |
| `lib/env-setup.ts:202-207,262,275`                                                                                          | `$VAR` expansion; `PORT=x npm run dev` prefix                           | shell-specific expand; pass `PORT` via `env`                | Major                |
| `lib/orchestration.ts:94,162,409,419`                                                                                       | `~`→`$HOME`; `\| head \| sed`; `rm -rf`                                 | `os.homedir()`; parse porcelain in JS; `fs.rm`              | Major                |
| `lib/git.ts:47,246` & `lib/pr*.ts`, `lib/git-status.ts:321`                                                                 | `sed`, `2>/dev/null \|\| echo`, single-quote commit/PR strings          | `execFile`+argv arrays; strip in JS                         | Major (systemic)     |
| `app/api/sessions/[id]/send-keys/route.ts:10,62`, `summarize/route.ts:177`                                                  | `/tmp/...`                                                              | `os.tmpdir()`                                               | Major                |
| `app/api/sessions/status/route.ts:74`, `summarize/route.ts:30`                                                              | `path.replace(/\//g,"-")` for Claude dir                                | match Claude's Windows dir convention                       | Major                |
| `components/DirectoryPicker.tsx:88-106`, `FolderPicker.tsx:121`, `FilePicker.tsx:171`, `hooks/useDirectoryBrowser.ts:59-73` | `/`-root file browser, `split("/")` nav                                 | server endpoint for drive roots; server-provided separators | Major (file picker)  |
| ~12 `split("/").pop()` display sites (SessionCard, QuickSwitcher:238, CodeSearchResults:113, FileTabs:49, …)                | basename via `/`                                                        | split `/[\\/]/` or server `basename`                        | Minor (cosmetic)     |
| `.husky/pre-commit`                                                                                                         | `grep`/`xargs`/`[ ]`                                                    | Node script / lint-staged                                   | Major                |

**~40 `process.env.HOME` / `~` / separator violations** to route through the `expandHome`/`path` helpers — representative sites: `server.ts:54,55,66`; `app/api/exec/route.ts:31`; `lib/dev-servers.ts:9,166,189,190`; `lib/claude/process-manager.ts:128,129,149,155`; `lib/orchestration.ts:94`; `lib/git.ts:17,31,43,80,98,114,144,165,217`; `lib/projects.ts:386,448,498`; `app/api/files/route.ts:22`; `app/api/files/content/route.ts:21,59`; `app/api/git/clone/route.ts:33`; `app/api/dev-servers/detect/route.ts:27`; `app/api/sessions/[id]/mcp-config/route.ts:21`; `app/api/sessions/[id]/summarize/route.ts:222`; `components/GitDrawer/FileEditDialog.tsx:107`. (Already correct, use as templates: `lib/worktrees.ts:21,48`, `app/api/sessions/status/route.ts:72`.)

---

## 7. Dependency Audit

- **`node-pty@1.2.0-beta.6`** — Windows-supported (ConPTY; `win32-x64`/`win32-arm64` prebuilds present). No replacement; only fix the `postinstall chmod` and what it spawns.
- **`better-sqlite3@^11`** — ships Windows prebuilds; needs VS Build Tools only if a rebuild triggers. Flag for CI.
- **`esbuild`, `next@16`, `@serwist/turbopack`, `tsx`, `monaco-editor`, xterm addons, `@radix-ui`, `@codemirror`** — no Windows issues.
- **`@tauri-apps/cli`** — cross-platform; Windows build needs Rust + MSVC + WebView2 (standard Tauri prereqs).
- **No package has an `os`/`cpu` restriction excluding Windows; `package.json` has no `os` field** (good).
- **Add:** `@vscode/ripgrep` (bundle rg), `cross-env` (NODE_ENV scripts). `@xterm/headless` (server-side VT emulator) for the native backend.

**Net:** no dependency is hard-blocked on Windows. Every blocker is application code or bash tooling.

---

## 8. Testing & Verification Strategy

1. **Backend parity tests (Phase 1):** golden tests asserting the `tmux` backend produces identical scrollback/status output before and after the abstraction — pin behavior before swapping.
2. **VT-render tests (Phase 2):** feed recorded Claude/Codex output (spinner frames, trust prompts, `[Y/n]`) into the headless emulator; assert `readVisible`/`readScrollback` reproduce the exact text the status heuristics (§2.3 patterns) need. This is the highest-risk surface.
3. **Status-detector regression suite:** replay captured panes through `getStatus`; assert idle/running/waiting/dead transitions match tmux behavior.
4. **Persistence tests:** browser disconnect → reconnect → scrollback intact, agent alive (Tier 1); server restart → agent alive (Tier 2).
5. **Multi-client tests:** two WS clients on one session; input fan-in, output fan-out, min-size resize.
6. **Cross-platform CI matrix:** windows-latest + ubuntu-latest + macos-latest for unit/integration; smoke-launch one real agent per OS.
7. **Manual Windows smoke:** native Windows 11 (incl. Enterprise without WSL) — install via `install.ps1`, create session, attach, send prompt, see status, fork, orchestrate.

---

## 9. Risks & Mitigations

| Risk                                               | Mitigation                                                                                |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| VT-render mismatch breaks status detection         | Phase-2 render tests against recorded output; keep tmux backend as reference oracle       |
| Tier 1 loses agents on server restart              | Document clearly; WSL2 fallback for users needing bulletproof persistence; deliver Tier 2 |
| ConPTY quirks (resize, ANSI edge cases)            | Pin to a known-good node-pty; integration tests; min-size resize policy                   |
| Argv refactor changes prompt delivery subtly       | Provider-level tests asserting exact argv per agent; bracketed-paste tests                |
| Scope creep across ~40 portability sites           | Phase them; Blockers first, Minors (cosmetic basename) last; gate on CI matrix            |
| `better-sqlite3` rebuild on a machine without MSVC | Rely on prebuilds; document VS Build Tools as fallback                                    |

---

## 10. Rollout Sequence (recommended order)

1. **Phase 0** quick wins (ship now; helps all platforms).
2. **Phase 1** `SessionBackend` abstraction, tmux impl only (no behavior change; reviewable de-risking diff).
3. **Phase 3/4** cross-platform + provider hardening (can parallelize with Phase 2; many are independent).
4. **Phase 2** native PTY backend Tier 1 (the headline: native Windows, survives browser disconnect).
5. **Phase 5** Windows install/distribution (ship to users).
6. **Phase 6** Tier 2 PTY-host daemon (full restart-survival parity).

**Definition of done for "native Windows, no functionality loss":** Phases 0–5 complete and green on the Windows CI matrix, with Tier 1 persistence; Phase 6 closes the final restart-survival gap to reach byte-for-byte parity with the tmux experience.
