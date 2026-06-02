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
- [x] **Resolve mobile-vs-desktop view before first paint** — ✅ done (PR #41). `app/page.tsx` now gates the Desktop/Mobile view on the existing `isHydrated` flag, rendering a neutral spinner shell until the client knows the viewport — so phones no longer flash `DesktopView` for a frame. Both SSR and the first client render show the shell (so they match — no hydration mismatch); once hydrated, the correct view renders. `useViewport` also lazy-inits `isMobile` from `window.innerWidth` so it's already correct the instant hydration completes (sidebar-open already gated on `isHydrated`). _(was high/M, Startup)_
- [x] **Replace all blocking `confirm()`/`alert()` with themed dialogs/toasts** — ✅ done (PR #17: `ConfirmProvider`/`useConfirm()` + toast; dead duplicate delete paths removed). delete session/project/group, discard edits, kill worker all use native `window.confirm`, and attach-failure fires a debug `alert()` referencing the desktop console — each freezes the UI and screams "web page". Route through the existing dialog stack / `KillAllConfirm` pattern + mounted sonner toaster. _(high/M, SessionList/Terminal; see app/page.tsx:297, ConductorPanel.tsx:145, SessionList/hooks/useSessionListMutations.ts:63/110/144)_
- [x] **Show an "attaching" state during pty re-attach** — ✅ done (PR #15: "Switching…" overlay cleared on first WS output). `attachSession` calls `xterm.reset()` immediately then waits for the WS snapshot, leaving a blank black terminal with no overlay (the "Connecting…" overlay only covers initial connect). Set a transient flag cleared on first `output` for the new key; hold/dim the old buffer or fade the snapshot in. _(high/M, Terminal; see components/Terminal/hooks/useTerminalConnection.ts:89-107, Terminal/index.tsx:291-320)_
- [x] **Surface a "needs attention" count + jump-to-waiting** — ✅ done (PR #16: amber count badge + click-to-jump cycling waiting/error; optional `mod+.` chord folds into the pane/view-shortcuts item below). per-session status dots exist but nothing aggregates them, so triaging many agents means visually scanning the list. Add a `"N waiting"` badge in `SessionListHeader` from `sessionStatuses` and a global chord (e.g. `mod+.`) that cycles only `waiting`/`error` sessions via the `selectRelativeSession` pattern. _(high/M, SessionList/Status; see components/SessionCard.tsx statusConfig, data/statuses/queries.ts, app/page.tsx)_
- [x] **Wire pane/tab/view keyboard shortcuts** — ✅ done (PR #23 + #36). #23: `⌘/Ctrl+B` toggle sidebar + `⌘/Ctrl+\` split. #36 adds the focused-pane view/tab chords via a new `paneCommandStore` (mirrors `fileOpenStore` — a global handler can't reach a pane's local `viewMode`/`rightDrawer`, so it publishes a command the focused pane consumes + clears): `⌘/Ctrl+Shift+G` Git drawer, `⌘/Ctrl+Shift+E` files, `⌘/Ctrl+Shift+S` shell, `⌘/Ctrl+Shift+→`/`←` next/prev tab. Conflict-safe — dodges browser-reserved chords (⌘T/⌘W, ⌘1..9 browser tabs) and shifted-punctuation normalization; the `.xterm` guard suppresses them in a focused terminal (consistent with `mod+b`), and they're auto-listed in the cheatsheet. _goto-tab-N deferred (⌘1..9 collides with browser tab switching)._ _(was high/M, Panes; contexts/PaneContext.tsx, components/Pane/index.tsx, stores/paneCommands.ts)_
- [ ] **Add edge-swipe-to-open for the sidebar** — `SwipeSidebar` only implements swipe-to-close; the sole open path is the hard-to-reach top-left hamburger. Add a left-edge (`clientX < 20`) rightward-drag zone calling a new `onOpen → setSidebarOpen(true)`, mirroring the close logic with rubber-banding. _(high/M, Navigation; see components/mobile/SwipeSidebar.tsx:22-81, app/page.tsx:479)_
- [x] **Unify session-switch ordering across chevrons, swipe, and Alt+arrows over the *visible* list** — ✅ done (PR #37). New `lib/session-navigation.ts` `getSwitchableSessionOrder(sessions, projects)` is the single source of truth for the switch order: worker sessions excluded, project-grouped order in projects view (matches `ProjectsSection`), `group_path` grouping as the no-projects fallback, orphans appended so every session stays reachable (unit-tested). All four paths now consume it — `selectRelativeSession` (Alt+arrows, app/page.tsx), the `MobileTabBar` chevrons + dropdown, and the `Pane` swipe — so chevrons no longer leak workers and Alt+arrows follow the sidebar layout instead of MRU. The fixed 500ms nav lock is now backend-aware (pty 150ms / tmux 500ms via `getActiveBackend`). _(was medium/M, SessionSwitching)_
- [ ] **Cut the hardcoded terminal startup/attach delays (~250ms+)** — opening a terminal waits `setTimeout(150)` before xterm exists, plus `setTimeout(100)` on attach and the tmux 100ms+50ms dance, adding dead time on every open/switch. Drive init off `requestAnimationFrame`/`terminalRef` presence and attach off the real `connected` event; gate any real race on ResizeObserver/fit, not a magic constant. _(medium/M, Terminal; see useTerminalConnection.ts:166, Pane/index.tsx:220-231, app/page.tsx:322-336)_
- [x] **Optimistically remove/move sessions on mutation** — ✅ done (PR #18): pure cache transforms (`removeSessionFromCache`/`patchSessionInCache`, unit-tested) feed `onMutate`/`onError`/`onSettled` on `useDeleteSession` + `useMoveSessionToGroup`; `useRenameSession` refactored onto the same helpers. **Move-to-project intentionally left non-optimistic** — see the server gap below. Dev-server-stop not covered (separate data layer). _(was medium/M, SessionList/mutations)_
- [x] **Fix server-side move-to-project (PATCH ignores `projectId`)** — ✅ done (PR #24): `PATCH /api/sessions/[id]` now persists `projectId` (sidebar groups flat by `project_id`, so this relocates the session); re-enabled the optimistic `useMoveSessionToProject` (no longer flashes-and-reverts). _was:_ `PATCH /api/sessions/[id]` only updates name/status/workingDirectory/systemPrompt/groupPath, so `useMoveSessionToProject` is a silent no-op (the session never actually moves). Add a `projectId` branch to the route and decide the `group_path` interplay (deprecated in favor of `project_id`); then make the mutation optimistic. _(high/S, API/SessionList; see app/api/sessions/[id]/route.ts:104-122, data/sessions/queries.ts useMoveSessionToProject, components/SessionCard.tsx:320-332)_
- [ ] **Convert mobile New Session / QuickSwitcher to bottom sheets** — these reuse the center-anchored `DialogContent`, so focusing their autofocused inputs raises the keyboard and shoves/clips action buttons mid-screen, away from the thumb. Render a bottom-anchored sheet variant (`rounded-t-xl` + `env(safe-area-inset-bottom)`) on `isMobile`, reusing the `TerminalToolbar` pattern. _(medium/M, Mobile/Dialogs; see components/ui/dialog.tsx:60-67, NewSessionDialog/index.tsx, QuickSwitcher.tsx:142)_
- [x] **Add a `prefers-reduced-motion` override** — ✅ done (PR #22): global `@media (prefers-reduced-motion: reduce)` in globals.css neutralizes transitions/slides/pulse/enter-exit animations; `.animate-spin` exempted so spinners still convey progress. — there's zero reduce-motion handling, yet the UI leans on pulse skeletons, spinners, the 300ms sidebar slide, and pulsing status dots, which mobile OS users who set the system flag expect honored. Add a global `@media (prefers-reduced-motion: reduce)` block in `globals.css` neutralizing non-essential motion. _(medium/S, a11y; see app/globals.css, SwipeSidebar.tsx:110, DesktopView.tsx:64)_
- [x] **Guarantee 44px touch targets + visible focus/aria on icon controls** — ✅ done (PR #40). SessionCard rows bumped to `min-h-[44px]` on mobile (compact on desktop); the actions menu button is `h-9 w-9` (36px) on mobile; the select checkbox, PR badge, and menu trigger gained `aria-label`s (+ `aria-pressed` on the checkbox), and DesktopView's icon-only header buttons (sidebar toggle, copy session-id, quick-switch) are now labeled. Added a **global `:focus-visible` ring** in `@layer base` (`outline` so it never shifts layout) — shadcn `Button`'s utility-layer `outline-none` wins over it (no double ring), so it only surfaces a focus state on raw `<button>`/`<a>` that had none. (The terminal file-picker was already labeled+ringed.) _(was medium/S-M, A11y/TapTargets)_

## ⭐ Priority B — Performance, lightweight & speed: local-run feel

Performance & lightness are the spine of the "local-run feel" — this section attacks cold-start weight, render churn, and the chatty poll/IPC paths so Stoa boots fast, stays quiet when idle, and types instantly.

**Status (2026-06):** the two real cold-start / render wins shipped — **#33** (lazy-load Monaco + syntax-highlighter) and **#34** (SessionCard memoization). Everything below them is **deferred**: several candidates were verified out as no-ops against the actual code/libraries (marked inline), and the rest are real but lower-priority, marginal, or large-scope. The codebase is already well-optimized — no remaining item blocks the local-run feel.

- [x] **Lazy-load Monaco out of cold start** — ✅ done (PR #33): `FileEditDialog` (the only `@monaco-editor/react`+`monaco-editor` importer) is now `next/dynamic(...,{ssr:false})` in `GitDrawer/index.tsx`, with a spinner-overlay loading state. Monaco loads on first file-open, out of the eager graph.
- [x] **Split react-syntax-highlighter off the eager graph** — ✅ done (PR #33): `CodeSearchResults` (Prism + `vscDarkPlus`) is now `next/dynamic` in `QuickSwitcher.tsx`, loaded only when code search runs.
- [x] ~~**setNoDelay on pty-host IPC sockets**~~ — **scrapped (PR #33): no-op.** The IPC is a named pipe (`\\.\pipe\…`) / unix domain socket (`<tmp>/*.sock`), not TCP (`net.connect(hostAddress())` with a string path). Nagle's algorithm only applies to TCP, so `setNoDelay` does nothing here — the premise was wrong. Keystroke latency on the pty path, if any, is elsewhere (rAF-batch of pty output is the real lever).
- [x] **Memoize SessionCard + stabilize per-row callbacks** — ✅ done (PR #34): id-threaded callbacks + `React.memo` so a 5s status / 10s sessions tick only re-renders the cards whose own data changed (not every row). Took 3 review rounds to make the memo genuinely effective — per-row closures → inline `onSelect`/`onOpenInTab` arrows in DesktopView/MobileView → react-query's per-render `useMutation` result object; the fix depends on the stable `mutateAsync` property, not the whole object. Idle "time ago" decoupled into a self-ticking `<TimeAgo>` so it doesn't freeze on memoized cards.
- [x] ~~**Stop double-fetching sessions; single source of truth**~~ — **scrapped: not real.** `SessionList`'s `useSessionsQuery`/`useProjectsQuery`/`useDevServersQuery` and HomeContent's share react-query's cache by query key — one fetch with deduped subscribers, not two. Nothing to fix.
- [x] ~~**Async + cached fs scans in the status route**~~ — **already in place.** `app/api/sessions/status/route.ts` resolves each agent id once and caches it (`resolvedSessionIds`, then skips the scan), processes sessions in parallel (`Promise.all`), and batches DB writes in one transaction. The `readdirSync`/`statSync` runs only until first resolution — the perf intent this item described is met.

**Deferred** — real but lower-priority, marginal, or large-scope; not blocking the local-run feel. Verified no-ops are marked.

- [ ] ~~**Coalesce pty output into rAF-batched frames**~~ — **mostly no-op, deferred.** xterm 6 + CanvasAddon already coalesces sub-frame `term.write`s into one paint via its own rAF loop, and pty data arrives pre-chunked (4–16 KB) — batching writes adds latency without cutting paints. Only the *per-message* `requestAnimationFrame` scroll-fix is genuinely per-message; low impact. _(Terminal/WS; components/Terminal/hooks/websocket-connection.ts)_
- [ ] **enable optimizePackageImports for lucide-react + Radix** — **deferred (likely no-op):** Next 16 already ships `lucide-react` + `@radix-ui/*` in its default `optimizePackageImports` list. Revisit only if a bundle measurement shows a barrel still leaking. _(next.config.ts:5-13)_
- [ ] **Gate background polls on visibility/active view** — **mostly handled by the library:** react-query v5 already skips `refetchInterval` fetches when the tab is hidden (`refetchIntervalInBackground` defaults false; `focusManager.isFocused()` = `visibilityState !== 'hidden'`). The only unguarded pollers are the raw `setInterval`s scoped to already-open UI — ConductorPanel (5s), SessionPreviewPopover (2s), ServerLogsModal (3s). Marginal; deferred. _(components/ConductorPanel.tsx, SessionPreviewPopover.tsx, DevServers/ServerLogsModal.tsx)_
- [ ] **Prefetch the Terminal chunk on idle** — deferred (real, minor): `requestIdleCallback(() => import('@/components/Terminal'))` after first paint to warm the ~500 KB lazy xterm chunk before first attach. _(medium/S; components/Pane/index.tsx:36-39)_
- [ ] **Disable cursorBlink on hidden/inactive terminals** — deferred (real, minor): toggle `term.options.cursorBlink` by pane visibility so offscreen canvas cursors stop scheduling repaints. _(medium/S; Terminal/hooks/terminal-init.ts, Pane/index.tsx)_
- [ ] **Strip prod debugLog ring buffer + window.stoaLogs** — deferred (real, minor): gate the debug ring buffer / `window.stoaLogs` behind `NODE_ENV`/`STOA_DEBUG` so it compiles out in prod; keep error-level only. _(medium/S; app/page.tsx)_
- [ ] **Throttle headless-VT writes for unattached sessions** — deferred (real, medium): gate per-byte `@xterm/headless` parsing on `subscriberCount` for background sessions; keep full parsing only while subscribed. _(medium/M; lib/session-backend/pty/pty-session.ts onData)_
- [ ] **Push status over WS; demote the 5s HTTP poll to a safety net** — deferred (real, large): the biggest remaining lever, but high-effort and touches the status/IPC path next to the locked tmux behavior — wants its own focused, well-tested change. _(high/L; data/statuses/queries.ts, app/api/sessions/status/route.ts, lib/session-backend/pty/host.ts)_

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
