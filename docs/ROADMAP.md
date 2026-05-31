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

## 2. Performance follow-ups (from the perf review)

- [ ] `PtySession` raw ring buffer: `rawBuffer += data` + `.slice()` per chunk is O(256KB)
      per chunk once full. Since `serialize()` is now the repaint path, consider
      shrinking or removing the raw buffer (it's only a fallback) → big CPU+mem win.
- [ ] Status polling: capture once per session (not `getStatus` capture + `getLastLine`
      capture) and **cache `claudeSessionId`** instead of re-scanning the project dir
      every poll (`getClaudeSessionIdFromFiles` does fs reads per poll per session).
- [ ] Reduce `HEADLESS_SCROLLBACK` (5000) — status/preview only read the visible screen;
      summarize reads ≤500 lines. ~1000 is plenty and cuts per-session memory.
- [ ] Tier-2 IPC: frame output as length-prefixed raw bytes instead of JSON-string-escaping
      every chunk (and encode once per chunk, not per viewer).

## 3. Architecture follow-ups (from the architecture review)

- [ ] Collapse the `create()` dual representation: discriminated spec
      `{kind:"argv",...} | {kind:"shell",...}`, ideally letting the tmux backend build
      its banner from argv → unifies `buildFlags`(string) and `buildAgentArgs`(argv).
- [ ] Centralize session-key construction (`sessionKey({kind:'agent'|'shell',...})`)
      so the namespace is enforced in one place (today it's string-built at 5 sites).
- [ ] Finish converting `lib/pr.ts` remaining `execSync` reads to `execFile` argv arrays.

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
- [ ] Session search / fuzzy switch across conversations.
- [ ] Export conversation to Markdown/JSON.
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
