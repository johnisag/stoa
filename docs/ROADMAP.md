# Stoa — Roadmap / Next Session Plan

Ordered by priority. The native-Windows migration, the `PtyTransport`
unification, the Stoa rename (incl. GitHub repo), and the green 3-OS CI matrix
are all **done**; what remains is below.

---

## 0. Headline: Hermes follow-ups ⭐

Hermes core is wired: provider registry + object, agent-picker entry, `--yolo`
auto-approve, and the CLI surface mapped from `hermes --help` (`-z PROMPT`,
`-m MODEL`, `--resume SESSION`, `--continue`, `--yolo`, `--pass-session-id`).
It renders through the pty backend with no special-casing.

**Done:**

- **Live browser test** ✅ — Hermes spawns/streams/renders correctly on native
  Windows (verified end-to-end in the browser).
- **`-z` initial prompt** ✅ (resolved) — `-z`/`--oneshot` and `chat -q` are
  one-shot (run once, exit), so they must NOT be the initial-prompt flag;
  `initialPromptFlag` stays unset and prompts go into the live TUI via the
  existing send-keys path. No change needed.
- **Resume** ✅ — Stoa captures Hermes's session id from the startup banner
  (`Session: <YYYYMMDD_HHMMSS_hex>`) via the status detector's screen capture,
  persists it in `sessions.claude_session_id`, and `buildAgentArgs` passes
  `--resume <id>` on respawn. Verified live: a torn-down session reattaches as
  `↻ Resumed session <id>` with full conversation restored. (Hermes persists
  incrementally to its store, so resume survives even a hard kill.)

- **Model selection** ✅ — Hermes models are dynamic, so the project model
  field is now FREE-TEXT for Hermes (no static dropdown); `modelFlag: "-m"`
  passes it as `-m <model>`, and an empty value leaves Hermes on its own
  default. See `lib/model-catalog.ts` (`isFreeTextModelAgent`).

**Remaining:**

- **Status detection** — needs a live observation to tune confidently, and
  it's more involved than first thought:
  - The per-provider `waitingPatterns`/`runningPatterns`/`idlePatterns` on the
    `AgentProvider` objects are **vestigial** — `lib/status-detector.ts` only
    uses its own GLOBAL lists (`BUSY_INDICATORS`, `SPINNER_CHARS`,
    whimsical-words + `tokens`, `WAITING_PATTERNS`), shared across all agents.
  - So tuning means either (a) wiring the detector to also consult the active
    provider's patterns (additive, but changes behavior for every agent — risks
    the locked Claude path), or (b) adding a Hermes-unique marker to the global
    lists. Either needs a real observation of Hermes's sustained busy / waiting
    output — a headless capture didn't surface it reliably (TUI/alt-screen), and
    a guessed marker (e.g. "Initializing agent…") lingers in scrollback and
    would false-positive as busy when idle.
  - **Next step:** a ~2-min live session watching `/api/sessions/status` while
    Hermes generates vs. waits vs. idles, then pick the safe pattern(s).

---

## 1. Real-runtime verification on Windows (human-in-the-loop gate)

CI is green on ubuntu/macos/windows, but these need a human at a real browser/agent:

- [ ] Interactive flow: create a session, watch a real agent spawn → stream → resize → reconnect.
- [ ] `.cmd` spawn of each agent CLI through ConPTY (claude confirmed; verify others).
- [ ] **Tier-2 restart-survival**: start a session, restart the Stoa server, reattach — session intact.
- [ ] Orchestration (conductor/workers) on native Windows (uses the argv path; banner is POSIX-only).
- [ ] Shell drawer, file picker (drive roots), Git panel against a real repo, PR flow.
- [ ] Tag a release once this verification passes.

## 2. Performance follow-ups (from the perf review) ✅

All four done on `perf/session-hotpaths` (tsc + 83 tests + build green; reviewed by
a 5-dimension adversarial pass — see notes).

- [x] `PtySession` raw ring buffer: was `rawBuffer += data` + `.slice()` per chunk =
      O(256KB) per chunk once full. Now an **amortized high-water trim** (grow to 2×
      the limit, slice back to 1× — amortized O(1)/byte) and the limit shrank 256KB→64KB
      (it's only the `serialize()`-throws fallback). CPU + 4× memory win.
- [x] Status polling: one capture per session via `statusDetector.getStatusDetail()`
      (`{status, lastLine}` from a single screen) — was a `getStatus` capture **plus** a
      `getLastLine` capture (2 IPC round-trips/session/poll on Tier-2). Plus a route-level
      `resolvedSessionIds` cache so the resume-id is resolved once instead of fs-scanning
      the Claude project dir every poll. Both module maps are pruned by live ids.
      **Trade-off (intentional):** the Claude resume-id is cached for the session's life,
      so starting a brand-new conversation (e.g. `/clear`) inside the *same* managed
      session keeps the first id. Acceptable — new sessions get new ids; add a TTL only if
      multi-conversation sessions become common.
- [x] `HEADLESS_SCROLLBACK` 5000→1000 — status/preview read the visible screen, summarize
      reads ≤500. ~5× less per-session VT memory and smaller `serialize()` snapshots. The
      orchestrate worker-output endpoint now clamps `?lines=` to ≤1000 (was unbounded).
- [x] Tier-2 IPC: **length-prefixed binary frames** (4-byte BE length + KIND tag;
      output = `[u16 keyLen][key][raw UTF-8 bytes]`, control/res/exit = JSON). Output bytes
      are carried verbatim — no JSON-escaping of ANSI on every chunk. (Note: "encode once
      per viewer" was moot — viewers multiplex client-side through one daemon socket per
      server, so the per-chunk JSON-escape was the real cost; the binary framing removes it.)

## 3. Architecture follow-ups (from the architecture review)

- [ ] **Deferred — needs human verification.** Collapse the `create()` dual representation:
      discriminated spec `{kind:"argv",...} | {kind:"shell",...}`, letting the tmux backend
      build its banner from argv → unifies `buildFlags`(string) and `buildAgentArgs`(argv).
      **Why deferred:** `buildFlags` (tmux path) omits Hermes `--resume` while `buildAgentArgs`
      (pty path) includes it, so unifying is NOT byte-identical — it changes the locked
      macOS/Linux tmux path (Hermes gains tmux resume) and must re-fold the init-script route's
      root `IS_SANDBOX`/`PATH` env. CI runs no real tmux/agents, so this falls under the §1
      human-in-the-loop gate. Plan: implement test-first (argv→banner byte-identity for
      claude/codex) and flag the Hermes/root deltas for a real Mac/Linux check before merge.
- [x] Centralize session-key construction (`sessionKey({kind:'agent'|'shell',...})`) — done
      (PR #5). One constructor in `lib/providers/registry.ts`; all 13 string-built sites
      migrated; byte-identical (format/round-trip tests); also fixed a non-Claude-worker prefix bug.
- [x] Finish converting `lib/pr.ts` `execSync` reads to `execFile` argv arrays — done (PR #5).
      Also fixed a latent bug: `getCommitsSinceBase` returned `[]` for all real `git log` output,
      so generated PR bodies never listed commits.

## 4. Security / product decisions (from the security review — pre-existing posture)

These predate the migration but are worth a deliberate call:

- [ ] WS/HTTP binds `0.0.0.0` with no auth (intentional for Tailscale mobile access).
      Decide: default to loopback + opt-in `0.0.0.0`, and/or add a WS auth token / origin check.
- [ ] `/api/exec` and the file APIs are unauthenticated + unconfined to project roots.
- [ ] Agent ptys inherit the full server env (matches "agent runs as you"; offer an
      allowlist option if running in a shared/hosted context).

## 5. Product backlog

Status detector already classifies waiting/error/done, so several of these now
fit cleanly on the native backend.

**Near-term polish (pick a couple):**

- [x] Notifications when a session needs attention (waiting/error/done) —
      foreground path: toast + sound + tab badge/flash + browser notification
      (when unfocused) + per-session highlight, with active-session suppression
      and per-event toggles. `error` is now a real detected state (conservative
      screen patterns); `done` = the running→idle "completed" event (default on);
      cooldown dedup fixes flap; statuses refetch on window-focus to recover
      transitions missed while the tab was hidden. **Best-effort caveats:** the
      error patterns need live tuning against real transcripts, and a fully
      *closed* tab/browser still needs Web Push (separate milestone below).
- [ ] **Notifications — closed-tab/browser (Web Push).** Foreground polling
      can't alert when the tab is fully closed; add a service-worker push path
      (VAPID + subscription store + server emitter on status transitions). Large;
      iOS-Safari needs PWA-standalone. Do after the foreground path proves out.
- [x] Session search / fuzzy switch across conversations — the ⌘/Ctrl-K QuickSwitcher
      already existed; its plain substring filter is now a real **ranked fuzzy matcher**
      (`lib/session-search.ts`, subsequence scoring with prefix/word-boundary/contiguity
      bonuses) over name, path, agent, and branch (deliberately not the deprecated
      group_path, whose "sessions" default would match everything).
- [x] Export conversation to Markdown/JSON — done (PR #6): pure formatters +
      `/api/sessions/[id]/export?format=md|json` route + an Export submenu in SessionCard.
- [ ] Keyboard shortcuts for navigation.
- [ ] Live-tear-down a pane's terminal when its session is deleted. The reconcile
      in PaneContext already detaches the tab in state (so it clears on reload),
      but the mounted `<Terminal>` keeps its WS until remount. Needs a terminal
      `detach()` triggered on the set→null transition — without regressing the
      imperative session-switch path (which reuses the same attach handle).

**Session management:**

- [ ] Session templates — pre-configured sessions for common tasks.
- [ ] Session groups / folders — organize sessions by project, not just by path.
- [ ] Session snapshots — save/restore session state.
- [ ] Tool-call persistence — store tool calls in the database.
- [ ] Multiple working directories per session.
- [ ] Rate limiting / queue for parallel sessions.
- [ ] Per-session MCP capability toggle (web search, GitHub, etc.).

**Workspaces (catnip-inspired):**

- [ ] Project-tied workspaces — sessions grouped by project/worktree.
- [ ] Auto dev-server per worktree with a unique port; workspace dashboard
      (branches, ports, session status); one-click "worktree + session + dev
      server" spin-up; port-forwarding UI; per-worktree build/test health.
