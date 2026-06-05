# AGENTS.md — working principles for Stoa

Guidance for any AI agent (or human) working in this repo. Read before changing
code. Keep changes surgical and match surrounding style.

Stoa is a mobile-first web UI for running AI coding agents in real terminals.
It runs **natively on Windows, macOS, and Linux** — preserving that is a hard
requirement, not a nice-to-have.

## Workflow & verification gate

- Package manager: `npm`. Dev: `npm run dev` (port 3011). Build: `npm run build`.
- **Before every commit, all three must be green:** `npx tsc --noEmit`, `npm test`,
  `npm run build`. The pre-commit hook runs prettier + typecheck.
- CI runs the test matrix on **ubuntu + macos + windows** (`.github/workflows/test.yml`).
  A change isn't done until that matrix is green.
- **3-agent review before merge — no exceptions.** Every change (any size —
  feature, fix, refactor, or docs) gets a local review of the PR diff by three
  independent agents, each on a distinct dimension: correctness/security,
  conventions/cross-platform, and simplicity/UX. Surface the findings and fix
  them first; this gate carries equal weight to green CI. (Merging itself still
  follows "don't push or open PRs unless asked".)
- Conventional commits; end the message with the project's `Co-Authored-By` trailer.
- Don't push or open PRs unless asked.

## Cross-platform (the #1 source of regressions)

- **Never assume POSIX.** Use the helpers in `lib/platform.ts`: `isWindows`,
  `homeDir()`, `expandHome()`, `tmpDir()`, `resolveBinary()`, `isPortInUse()`,
  `defaultInteractiveShell()`, `baseName()`, `claudeProjectDirName()`.
- Never read `process.env.HOME` (unset on Windows), hardcode `/tmp` or `/bin`,
  or `split("/")` a path. No `lsof`/`which`/`sed`/`head`/`grep`/`rm -rf`.
- **No shell-string `exec` with pipes/redirects.** Use `execFile`/`execFileSync`
  with an argv array and do parsing in JS. Resolve binaries with `resolveBinary`
  (npm CLIs are `.cmd` shims on Windows; a bare name ENOENTs under `execFile`).
- **Client components must not import server-only modules.** `lib/platform.ts`
  pulls in node builtins — for path display in the browser use `lib/path-display.ts`.

## Session / terminal architecture

- **All session & terminal operations go through `getSessionBackend()`** (the
  `SessionBackend` interface). Do not call `tmux` or `node-pty` directly elsewhere.
- Backend selection (`lib/session-backend/index.ts`): **tmux on macOS/Linux, pty on
  Windows**; `STOA_BACKEND=tmux|pty` overrides. The tmux path must stay
  behavior-identical on POSIX — it's locked by `test/tmux-backend.test.ts`.
- **`PtyTransport`** is the seam for _where_ the pty lives: `LocalTransport`
  (in-process registry, Tier 1) vs `HostTransport` (out-of-process daemon, Tier 2).
  To add a remote pty (e.g. SSH), write a transport — don't add a backend or a
  second WS handler.
- **Status detection reads the RENDERED screen** (`capture()` off the headless VT
  emulator), never the raw byte stream. A spinner overwrites its line in place;
  raw bytes would break the heuristics.
- Tier 2 (pty-host daemon) is **default-on for Windows**; `server.ts` probes it once
  before listening and falls back to Tier 1 if unreachable (no split brain — the
  whole process agrees on one backend).

## Adding an agent provider

1. **Discover the CLI with `<cli> --help`** — do not guess flags.
2. Wire it in three places: `lib/providers/registry.ts` (`PROVIDER_IDS` + `PROVIDERS`),
   `lib/providers.ts` (provider object + the `providers` map), and
   `components/NewSessionDialog/NewSessionDialog.types.ts` (`AGENT_OPTIONS`).
3. argv comes from `buildAgentArgs` — **clean tokens, no shell quoting** (it runs
   through a direct spawn). Only wire a flag you've verified.
4. **Don't impose a static model list** if the agent's models are dynamic
   (e.g. Hermes live-fetches `/v1/models`); leave `modelFlag` unset and let the
   agent use its own default.
5. Add coverage in `test/providers.test.ts` (the integrity sweep already guards
   that every id has a provider object, definition, and picker entry).

## Testing principles

- **New functionality ships with tests.** Any new logic — backends, transports,
  providers, the IPC protocol, platform helpers, parsing/argv construction —
  must come with unit tests in `test/`, and a bug fix should add a regression
  test that fails before the fix. (Purely presentational UI is exempt where a
  unit test adds no real signal.) The verification gate above is not met until
  the new tests are green on the CI matrix.
- Tests must pass on **all three OSes** — no real `tmux` or agent binaries.
  - Command construction: mock `child_process.exec` (see `tmux-backend.test.ts`).
  - pty round-trips: spawn `node` with an inline script (see `pty-backend.test.ts`).
  - ports: use a real `net` server (see `platform.test.ts`).
- Daemon tests must isolate their socket via `STOA_PTY_HOST_NAME` so parallel
  test files don't collide on the global pipe/socket.
- Lock anything easy to silently regress: command strings, argv, the tmux path.

## Don't

- Don't break the macOS/Linux experience — it's the untouched tmux path.
- Don't reintroduce POSIX-only shell calls or `process.env.HOME`.
- Don't add session/terminal logic outside the `SessionBackend`/`PtyTransport` seams.
