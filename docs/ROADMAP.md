# Stoa — Roadmap / Next Session Plan

Ordered by priority. The native-Windows migration, the `PtyTransport`
unification, the Stoa rename (incl. GitHub repo), and the green 3-OS CI matrix
are all **done**; what remains is below. **Top priority now: make Stoa feel
like a local/native app — Priority A (UI/UX) and Priority B (Performance) below.**

---

## ⭐ Priority A — UI/UX: toward a native, local-app feel

Make session work feel instant and gesture-native on mobile while giving desktop power-users the keyboard-and-glance surfaces a local app provides.

- [x] **⭐ File explorer in the right drawer (shared with Git, mutually exclusive) + right-click "Copy path"** — ✅ done (PR #19). Replaced the `gitDrawerOpen` boolean with a per-pane `rightDrawer: "git" | "files" | null` state (Git icon ↔ folder icon, mutually exclusive). New `FileExplorerDrawer` = tree (reusing `FileTree` + `/api/files`) docked in the Git slot; clicking a file opens it in a **modal editor** (FileTabs + FileEditor), mirroring how Git opens a changed file, so the terminal stays visible. Right-click any node → **Copy path** / **Copy relative path** (`relativePath` helper, unit-tested; `useCopyToClipboard` + toast). Mobile keeps `viewMode="files"`; the deep-link file-open path is unchanged.
- [x] **Drive the mobile shell with `--app-height`** — ✅ done (PR #11). `MobileView` uses `h-screen` (100vh), so the terminal + Esc/Ctrl-C toolbar slide under the on-screen keyboard while typing; the `useViewportHeight()`/`.h-app` machinery is built but unused. Switch the mobile root to `h-app`, keep `h-screen` on desktop. _(high/S, Mobile/Viewport; see components/views/MobileView.tsx:39, hooks/useViewportHeight.ts, app/globals.css:51-56)_
- [x] **Re-enable the hover session-preview popover** — ✅ done (PR #12, + on-screen X-clamp). `SessionPreviewPopover` is complete and wired (live 720px ANSI snapshot, 2s refresh, hover state still computed) but its render is commented out, so users can't peek at a session without a destructive tmux re-attach. Uncomment, gate to desktop + non-select mode. _(high/S, SessionList; see components/SessionList/index.tsx:~299-310, components/SessionPreviewPopover.tsx)_
- [x] **Add a shortcut cheatsheet (`?` / `mod+/`)** — ✅ done (PR #13 overlay + PR #14 visible "?" button). only 3 global chords exist and the lone hint is a `⌘K` tooltip, so Alt+arrow cycling etc. is undiscoverable. Add a binding to `NAV_KEYBINDINGS` that opens an overlay rendered from the keybinding list (platform glyph via `isMacPlatform()`) so it stays in sync. _(high/S, Shortcuts; see app/page.tsx NAV_KEYBINDINGS, lib/keybindings.ts)_
- [ ] **Resolve mobile-vs-desktop view before first paint** — `useViewport()` defaults `isMobile=false`, so phones render the full `DesktopView` for one frame then snap to mobile (and the sidebar opens post-hydration). Seed `isMobile`/`sidebarOpen` from `matchMedia('(max-width:767px)')` in a lazy initializer, or resolve via the pre-paint `<head>` script. _(high/M, Startup; see hooks/useViewport.ts, app/page.tsx:418-420,604-608)_
- [x] **Replace all blocking `confirm()`/`alert()` with themed dialogs/toasts** — ✅ done (PR #17: `ConfirmProvider`/`useConfirm()` + toast; dead duplicate delete paths removed). delete session/project/group, discard edits, kill worker all use native `window.confirm`, and attach-failure fires a debug `alert()` referencing the desktop console — each freezes the UI and screams "web page". Route through the existing dialog stack / `KillAllConfirm` pattern + mounted sonner toaster. _(high/M, SessionList/Terminal; see app/page.tsx:297, ConductorPanel.tsx:145, SessionList/hooks/useSessionListMutations.ts:63/110/144)_
- [x] **Show an "attaching" state during pty re-attach** — ✅ done (PR #15: "Switching…" overlay cleared on first WS output). `attachSession` calls `xterm.reset()` immediately then waits for the WS snapshot, leaving a blank black terminal with no overlay (the "Connecting…" overlay only covers initial connect). Set a transient flag cleared on first `output` for the new key; hold/dim the old buffer or fade the snapshot in. _(high/M, Terminal; see components/Terminal/hooks/useTerminalConnection.ts:89-107, Terminal/index.tsx:291-320)_
- [x] **Surface a "needs attention" count + jump-to-waiting** — ✅ done (PR #16: amber count badge + click-to-jump cycling waiting/error; optional `mod+.` chord folds into the pane/view-shortcuts item below). per-session status dots exist but nothing aggregates them, so triaging many agents means visually scanning the list. Add a `"N waiting"` badge in `SessionListHeader` from `sessionStatuses` and a global chord (e.g. `mod+.`) that cycles only `waiting`/`error` sessions via the `selectRelativeSession` pattern. _(high/M, SessionList/Status; see components/SessionCard.tsx statusConfig, data/statuses/queries.ts, app/page.tsx)_
- [ ] **Wire pane/tab/view keyboard shortcuts** — all multi-pane layout ops (split, close, focus-next, new/switch tab, git/files/shell toggles) are mouse-only icon buttons though `PaneContext` already exposes the methods. Bind a focused set (`mod+\`, `mod+w`, `mod+t`, `mod+1..9`, `mod+alt+arrows`, view toggles) into `useGlobalKeybindings`; lift pane-local `viewMode` so a global handler can reach the focused pane. _(high/M, Panes; see contexts/PaneContext.tsx, components/Pane/DesktopTabBar.tsx, components/Pane/index.tsx)_
- [ ] **Add edge-swipe-to-open for the sidebar** — `SwipeSidebar` only implements swipe-to-close; the sole open path is the hard-to-reach top-left hamburger. Add a left-edge (`clientX < 20`) rightward-drag zone calling a new `onOpen → setSidebarOpen(true)`, mirroring the close logic with rubber-banding. _(high/M, Navigation; see components/mobile/SwipeSidebar.tsx:22-81, app/page.tsx:479)_
- [ ] **Unify session-switch ordering across chevrons, swipe, and Alt+arrows over the *visible* list** — `MobileTabBar` chevrons and the `Pane` swipe both index the raw `sessions` array (leaking hidden conductor workers and disagreeing with the dropdown), while `selectRelativeSession` cycles MRU order rather than the grouped sidebar order. Compute one shared filtered/grouped order all three reuse, and drop the fixed 500ms nav lock to backend-aware (~80-120ms for pty). _(medium/M, SessionSwitching; see MobileTabBar.tsx:86-132,191-225, Pane/index.tsx:289-319, app/page.tsx:447-461)_
- [ ] **Cut the hardcoded terminal startup/attach delays (~250ms+)** — opening a terminal waits `setTimeout(150)` before xterm exists, plus `setTimeout(100)` on attach and the tmux 100ms+50ms dance, adding dead time on every open/switch. Drive init off `requestAnimationFrame`/`terminalRef` presence and attach off the real `connected` event; gate any real race on ResizeObserver/fit, not a magic constant. _(medium/M, Terminal; see useTerminalConnection.ts:166, Pane/index.tsx:220-231, app/page.tsx:322-336)_
- [x] **Optimistically remove/move sessions on mutation** — ✅ done (PR #18): pure cache transforms (`removeSessionFromCache`/`patchSessionInCache`, unit-tested) feed `onMutate`/`onError`/`onSettled` on `useDeleteSession` + `useMoveSessionToGroup`; `useRenameSession` refactored onto the same helpers. **Move-to-project intentionally left non-optimistic** — see the server gap below. Dev-server-stop not covered (separate data layer). _(was medium/M, SessionList/mutations)_
- [ ] **Fix server-side move-to-project (PATCH ignores `projectId`)** — `PATCH /api/sessions/[id]` only updates name/status/workingDirectory/systemPrompt/groupPath, so `useMoveSessionToProject` is a silent no-op (the session never actually moves). Add a `projectId` branch to the route and decide the `group_path` interplay (deprecated in favor of `project_id`); then make the mutation optimistic. _(high/S, API/SessionList; see app/api/sessions/[id]/route.ts:104-122, data/sessions/queries.ts useMoveSessionToProject, components/SessionCard.tsx:320-332)_
- [ ] **Convert mobile New Session / QuickSwitcher to bottom sheets** — these reuse the center-anchored `DialogContent`, so focusing their autofocused inputs raises the keyboard and shoves/clips action buttons mid-screen, away from the thumb. Render a bottom-anchored sheet variant (`rounded-t-xl` + `env(safe-area-inset-bottom)`) on `isMobile`, reusing the `TerminalToolbar` pattern. _(medium/M, Mobile/Dialogs; see components/ui/dialog.tsx:60-67, NewSessionDialog/index.tsx, QuickSwitcher.tsx:142)_
- [x] **Add a `prefers-reduced-motion` override** — ✅ done (PR #22): global `@media (prefers-reduced-motion: reduce)` in globals.css neutralizes transitions/slides/pulse/enter-exit animations; `.animate-spin` exempted so spinners still convey progress. — there's zero reduce-motion handling, yet the UI leans on pulse skeletons, spinners, the 300ms sidebar slide, and pulsing status dots, which mobile OS users who set the system flag expect honored. Add a global `@media (prefers-reduced-motion: reduce)` block in `globals.css` neutralizing non-essential motion. _(medium/S, a11y; see app/globals.css, SwipeSidebar.tsx:110, DesktopView.tsx:64)_
- [ ] **Guarantee 44px touch targets + visible focus/aria on icon controls** — mobile `SessionCard` rows are `min-h-[36px]` and pack a 24px menu button + tiny PR badge (easy mis-taps), while header/copy/attach buttons are icon-only with no `aria-label` and no focus-visible ring. Bump rows to 44px with ≥40px child hit areas, label icon-only buttons, and add a global focus ring. _(medium/S-M, A11y/TapTargets; see SessionCard.tsx:382,484-492, DesktopView.tsx:96-159, Terminal/index.tsx:256-265)_

## ⭐ Priority B — Performance, lightweight & speed: local-run feel

Performance & lightness are the spine of the "local-run feel" — this section attacks cold-start weight, render churn, and the chatty poll/IPC paths so Stoa boots fast, stays quiet when idle, and types instantly.

- [ ] **Lazy-load Monaco out of cold start** — `GitDrawer` → `FileEditDialog` statically imports `@monaco-editor/react`+`monaco-editor` (FileEditDialog.tsx:15-16), shipping ~892 KB (half the eager JS) on `/` though it only renders in the diff dialog -> `next/dynamic(...,{ssr:false})` `FileEditDialog` in `GitDrawer/index.tsx`, matching the Terminal/FileExplorer split. _(high/S, Startup; see components/GitDrawer/index.tsx:28, FileEditDialog.tsx:15-16)_
- [ ] **Split react-syntax-highlighter off the eager graph** — `CodeSearchResults` top-imports Prism + `vscDarkPlus` and rides into the page via QuickSwitcher, co-bundled in the same heavy chunk as Monaco -> `next/dynamic` `CodeSearchResults` from `QuickSwitcher.tsx` and lazy-load the highlighter only when the >2-char query fires. _(high/S, Startup; see components/CodeSearch/CodeSearchResults.tsx:6-7, QuickSwitcher.tsx:15)_
- [ ] **setNoDelay on pty-host IPC sockets** — neither `HostClient.connectOnce` (net.connect) nor `host.ts` server sockets disable Nagle, so each keystroke frame eats tens of ms of write-coalescing on the hottest interactive path -> `socket.setNoDelay(true)` on both ends. _(high/S, IPC; see lib/session-backend/pty/host-client.ts connectOnce, host.ts startHost)_
- [ ] **Coalesce pty output into rAF-batched frames** — every tiny pty chunk fans out as its own WS message + `term.write` + a per-message `requestAnimationFrame` scroll-fix (websocket-connection.ts:120-149), hundreds of frames/sec under busy agents -> buffer chunks, flush one `term.write` + at most one rAF per ~8-16ms tick, capturing `wasAtBottom` once. _(high/M, Terminal/WS; see server.ts handlePtyTerminal, components/Terminal/hooks/websocket-connection.ts:120-149)_
- [ ] **Memoize SessionCard + stabilize per-row callbacks** — plain-function `SessionCard` rebuilds full Radix ContextMenu/DropdownMenu trees for every row on each 5s status / 10s sessions tick -> `React.memo` keyed on rendered fields, `useCallback`/id-bound handlers in ProjectsSection/GroupSection, lazy-mount menu content on first open. _(high/M, SessionList; see components/SessionCard.tsx, Projects/ProjectsSection.tsx:231-348)_
- [ ] **Stop double-fetching sessions; single source of truth** — `SessionList` re-runs `useSessionsQuery`/`useProjectsQuery`/`useDevServersQuery` despite HomeContent already threading them as props, doubling subscriptions and breaking memoization -> consume the passed props (or push fetch to leaves) and `useMemo` the derived `data?.sessions ?? []` for stable identity. _(high/M, SessionList; see components/SessionList/index.tsx:48-66, app/page.tsx:78)_
- [ ] **Async + cached fs scans in the status route** — `getClaudeSessionIdFromFiles` runs `readdirSync`/`statSync` over `~/.claude/projects/<dir>` on the event loop for every unresolved session each 5s poll, stalling concurrent WS sends -> `fs.promises`, TTL-cache "not found yet", and reuse one readdir across sessions sharing a dir. _(high/M, StatusPoll; see app/api/sessions/status/route.ts getClaudeSessionIdFromFiles)_
- [ ] **Prefetch the Terminal chunk on idle** — xterm is correctly split into a ~500 KB lazy chunk but only fetched at first attach — the user's first action — so they wait synchronously -> `requestIdleCallback(() => import('@/components/Terminal'))` after first paint to warm it. _(medium/S, Startup; see components/Pane/index.tsx:36-39)_
- [ ] **enable optimizePackageImports for lucide-react + Radix** — `next.config.ts` has no barrel-import optimization for the heavily-used icon set and 8 Radix packages, inflating eager app-shell chunks -> add `experimental.optimizePackageImports` and re-measure. _(medium/S, Startup; see next.config.ts:5-13)_
- [ ] **Disable cursorBlink on hidden/inactive terminals** — every tab keeps its Terminal mounted (CSS-hidden) with `cursorBlink:true` on the canvas renderer, so offscreen cursors keep scheduling repaints -> toggle `term.options.cursorBlink` by pane visibility so only the focused terminal animates. _(medium/S, Terminal; see components/Terminal/hooks/terminal-init.ts:25-42, Pane/index.tsx:378-414)_
- [ ] **Gate background polls on visibility/active view** — git-status (15s), conductor (5s), and preview-popover (2s) polls run regardless of tab visibility or panel state, keeping steady idle HTTP/DB chatter -> pause on `document.visibilityState==='hidden'` (`refetchIntervalInBackground:false`) and only poll when the panel is open. _(medium/S, Network; see data/git/queries.ts, components/ConductorPanel.tsx, SessionPreviewPopover.tsx)_
- [ ] **Strip prod debugLog ring buffer + window.stoaLogs** — `app/page.tsx` builds debug strings, mutates a shared array, and console.logs on every terminal mount/session switch in production, leaking an internal API onto `window` -> gate behind `NODE_ENV`/`STOA_DEBUG` so it compiles out; keep error-level only. _(medium/S, Startup; see app/page.tsx:6-24,123-171,428-437)_
- [ ] **Push status over WS; demote the 5s HTTP poll to a safety net** — the status poll re-lists then captures every managed session's rendered screen every 5s (one IPC capture/session on Tier 2) regardless of change -> emit server-side status/activity transitions over the existing WS and drop the poll to ~30s; batch any remaining capture into one `statusSnapshot` IPC round-trip instead of 1+N. _(high/L, StatusPoll/IPC; see data/statuses/queries.ts, app/api/sessions/status/route.ts, lib/session-backend/pty/host.ts)_
- [ ] **Throttle headless-VT writes for unattached sessions** — every PtySession parses all pty bytes into a 1000-row `@xterm/headless` grid per chunk even with zero subscribers, burning steady background CPU/memory -> gate on `subscriberCount`: batch/just-in-time VT writes before capture for background sessions, keep per-byte parsing only while subscribed. _(medium/M, Backend; see lib/session-backend/pty/pty-session.ts onData)_

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
- [x] Keyboard shortcuts for navigation — done (PR #8): a pure keybindings core
      (`lib/keybindings.ts`: chord normalization, an input/terminal focus guard,
      auto-repeat suppression) + `useGlobalKeybindings`. ⌘/Ctrl-K opens the
      switcher; Alt+↓/↑ cycle next/prev (non-worker) session.
- [ ] Live-tear-down a pane's terminal when its session is deleted. The reconcile
      in PaneContext already detaches the tab in state (so it clears on reload),
      but the mounted `<Terminal>` keeps its WS until remount. Needs a terminal
      `detach()` triggered on the set→null transition — without regressing the
      imperative session-switch path (which reuses the same attach handle).

> **Note:** the clean, low-risk near-term items above are now shipped
> (notifications, export, fuzzy search, keyboard nav). The remaining backlog
> below is larger and/or riskier — Web Push (large; iOS-PWA), live terminal
> teardown (touches the WS/terminal lifecycle; browser-only to verify),
> tool-call persistence (fragile agent-output parsing), multiple cwd / MCP
> toggle (backend). Pick deliberately; several want human-in-the-loop verification.

**Session management:**

- [ ] Session templates — pre-configured sessions for common tasks. _(Largely
      subsumed by Projects: a project already pre-sets agent_type / default_model
      / initial_prompt and `useNewSessionForm` prefills from it. Only worth doing
      as a lighter, cross-project quick-preset if that proves desirable.)_
- [ ] Session groups / folders — organize sessions by project, not just by path.
      _(Largely subsumed by Projects + `project_id`; the legacy `group_path` is
      deprecated.)_
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
