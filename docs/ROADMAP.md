# Stoa — Roadmap / Next Session Plan

Ordered by priority. The native-Windows migration, the `PtyTransport`
unification, the Stoa rename (incl. GitHub repo), and the green 3-OS CI matrix
are all **done**, and **Priority A (UI/UX) + Priority B (Performance) are now
shipped** (history below). The forward menu is **🔭 Next horizons** — from a
10-expert opportunity scan — ordered Features → Performance → Usability → Stability.

---

## 🔭 Next horizons — opportunity scan (2026-06)

From a 10-expert multi-agent scan of the codebase + a synthesis pass (deduped
against shipped / verified-no-op items; every claim validated against the code).
Ordered **Features → Performance → Usability → Stability**; each item is
code-grounded. **These are proposals — pick deliberately.** `P`=priority, `E`=effort.

> **▶ Next session — START HERE:** make orchestration _reachable_. The `.mcp.json`
> that wires the `stoa` MCP into a session is no longer auto-written
> ([app/page.tsx:271-274](app/page.tsx) removed it to avoid polluting repos), so
> **no session currently has `spawn_worker`** — confirmed live (Claude reports the
> tools absent). Build the "Enable Orchestration" item below first; PR #51
> (`agentType`) and the cross-agent triage workflow build directly on it.

### Features

- [ ] **⭐ Enable Orchestration — make `spawn_worker` reachable (DO FIRST)** — _(P:high · E:M)_ Orchestration is currently un-triggerable from the UI: auto-creation of the session `.mcp.json` was removed ([app/page.tsx:271-274](app/page.tsx) TODO) to avoid littering repos, and the planned "Enable Orchestration" toggle was never built — so no Claude session has `spawn_worker`/`get_worker_output` (verified live: Claude reports the tools absent). Wire an explicit per-session **Enable Orchestration** action that calls the dormant `POST /api/sessions/[id]/mcp-config` (writes `.mcp.json` via `ensureMcpConfig`), surfaces the one-time Claude reload + MCP trust-approval, and keeps the written `.mcp.json` gitignored so it doesn't pollute the project. _Where:_ app/page.tsx (the TODO), app/api/sessions/[id]/mcp-config/route.ts + lib/mcp-config.ts (both exist), + a UI affordance (SessionCard menu / session settings). _Risk:_ none to the tmux/connection/status paths; this is the prerequisite that makes the agent-orchestration items below actually usable.
- [ ] **Unlock codex/hermes orchestration workers** — _(P:high · E:M)_ ✅ **implemented in PR #51** (adds `agentType` to the `spawn_worker` tool + a per-provider readiness/trust-prompt contract via `getProvider`; Claude byte-identical) — but only **usable once orchestration is enabled** (item above). _was:_ the conductor/worker path was plumbed for `agentType` end-to-end, but the MCP tool lacked the param and `spawnWorker`'s readiness loop hard-matched Claude-only banners, so non-Claude workers burned the 30s timeout. _Where:_ mcp/orchestration-server.ts, lib/orchestration.ts, lib/providers.ts. _Risk:_ no tmux/lifecycle/status-detector touch.
- [ ] **Workspace dashboard + auto dev-server per worktree + orphan reclaim** — _(P:high · E:L)_ Stoa already creates worktrees, allocates a unique dev-server port each, copies `.env`+installs, and parses `git worktree list` — but `listWorktrees()` is dead code. Build the §5 catnip surface: `GET /api/worktrees` + a sidebar section (branch, dirty/ahead-behind, attached session, owning port), opt-in one-click "start dev server here" on the pre-allocated port, and orphan flagging + bulk "remove worktree + delete branch" via `useConfirm`. The biggest "scales to many sessions" gap. _Where:_ new app/api/worktrees, components/Worktrees, additive dev_servers migration; reuse lib/ports.ts + lib/env-setup.ts. _Risk:_ read-only git+SQLite + opt-in spawn; reclaim only via useConfirm + isStoaWorktree(); depends on the worktrees→execFile fix (Stability).
- [ ] **Per-session MCP capability toggles** — _(P:med · E:L)_ `.mcp.json` only ever gets the `stoa` server; no UI to enable GitHub/web-search/Playwright per session. Add a curated MCP catalog + a checkbox section in New Session, persisted + merged **non-destructively**. Turns "launch an agent" into "launch an agent with the right tools." _Where:_ lib/mcp-config.ts, new lib/mcp-catalog.ts, NewSessionDialog, db migration. _Risk:_ merge must keep `stoa`+user servers; gate the catalog per provider.
- [ ] **Codex resume + a resume/continue picker at New Session** — _(P:med · E:M)_ Codex is `supportsResume:false` (relaunch loses its conversation), and resume is implicit (no way to _start_ continuing a prior session). Verify Codex's flag via `--help`, capture its id additively (mirroring the shipped Hermes banner), and add a "Resume previous conversation" control (Claude/Hermes `--continue`). _Where:_ registry.ts, status-detector.ts (ADDITIVE Codex regex only), NewSessionDialog. _Risk:_ status-detector is shared/locked — strictly additive; scope resume tokens so the tmux `buildFlags` path stays byte-identical.
- [ ] **Read-only share links for a session transcript** — _(P:med · E:M)_ Token-gated `/share/[token]` exposing a READ-ONLY transcript (export md/json + a static snapshot — both already exist) behind a `share_tokens` table; never reaches send-keys/WS input. "Copy share link" in the Export submenu. Reuses ~90% of shipped code, deliberately narrower than the open 0.0.0.0 bind. _Where:_ app/share/[token], app/api/share, additive migration. _Risk:_ cryptographically-random token; strictly read-only + single-session scoped.

### Performance

- [ ] **Binary WS frames browser-ward (close the un-optimized IPC half)** — _(P:high · E:M)_ §2 moved the daemon→server hop to binary frames, but server.ts re-wraps the same ANSI bytes in `JSON.stringify` per message per socket for the server→browser hop — the hottest remaining per-message op. Send output as a binary WS frame (1-byte kind + raw UTF-8; control stays JSON), decode via TextDecoder. _Where:_ server.ts handlePtyTerminal send(), websocket-connection.ts onmessage, ws.binaryType. _Risk:_ delicate lifecycle — preserve the Claude top-scroll rAF fix, snapshot-then-stream ordering, and the exit path; tmux untouched.
- [ ] **Shrink syntax-highlighter from full-Prism (625KB) to a registered light build** — _(P:high · E:S)_ CodeSearchResults bundles the entire refractor grammar set (625KB — the largest non-editor async chunk) to highlight single result lines for ~10 known languages. Switch to `PrismLight` + `registerLanguage` the mapped langs → <100KB. _Where:_ components/CodeSearch/CodeSearchResults.tsx. _Risk:_ low, behind the existing dynamic boundary; register every mapped language.
- [ ] **Dedupe the duplicated CodeMirror chunks (2× ~663KB)** — _(P:med · E:M)_ FileExplorer + FileExplorerDrawer each statically import FileEditor, emitting two near-identical CodeMirror chunks; hoist behind one shared dynamic wrapper + lazy-import the 6 grammars per opened-file language. _Where:_ FileExplorer/FileEditor.tsx, index.tsx, FileExplorerDrawer.tsx. _Risk:_ low; handle async-grammar loading state, keep SSR:false.
- [ ] **Throttle headless-VT parsing for sessions with zero subscribers** — _(P:med · E:M)_ PtySession.onData feeds every byte into @xterm/headless regardless of subscribers — N background agents = N emulators parsing in real time only for the 2s status poll. Gate the full parse on `subscriberCount`; flush before capture()/serialize(). Biggest per-session server-CPU lever under a fleet. _Where:_ pty-session.ts onData. _Risk:_ MUST flush before capture() or a running agent reads idle; never change captured content (status-detector is locked).
- [ ] **Prefetch the Terminal chunk on idle + strip the prod debugLog ring** — _(P:med · E:S)_ Warm the ~770KB xterm chunks via `requestIdleCallback` after first paint (off the first-attach critical path), and gate app/page.tsx's debugLog ring + `window.stoaLogs` behind NODE_ENV/STOA_DEBUG. _Where:_ Pane/index.tsx, app/page.tsx. _Risk:_ low; prefetch only imports the module (no mount/WS).
- [ ] **One shared TimeAgo ticker + back off the unguarded pollers** — _(P:med · E:S)_ N SessionCards run N 30s `setInterval`s (undercutting the #34 memo); ConductorPanel polls 5s forever and usePRStatus shells out to git/gh even when the drawer is closed. One module-level ticker + adaptive / `enabled`-gated polls. _Where:_ SessionCard TimeAgo, ConductorPanel, data/git usePRStatus. _Risk:_ ticker must reach memoized cards via an external store; client-only.
- [ ] **Disable cursorBlink on hidden/inactive terminals** — _(P:low · E:S)_ Every mounted xterm blinks (~2 repaints/s) even when it's not the focused pane; toggle `cursorBlink` by pane active/visible state. _Where:_ terminal-init.ts driven by Pane focus. _Risk:_ low; flip an option only, don't recreate the term.

### Usability

- [ ] **Tame the native mobile keyboard on the xterm input** — _(P:high · E:S)_ The hidden `.xterm-helper-textarea` has no input attrs, so iOS/Android auto-capitalize/autocorrect/spellcheck silently corrupt shell commands (`git status`→`Git status`). Set autocapitalize/autocorrect/autocomplete=off, spellcheck=false, enterkeyhint (gated on isMobile). The biggest "fighting my phone" papercut on the primary text path. _Where:_ terminal-init.ts after term.open. _Risk:_ low; desktop byte-identical.
- [ ] **Surface `lastLine` as a one-line preview under each session card** — _(P:high · E:S)_ The status detector already computes `lastLine` and threads it to ProjectsSection — but the card boundary drops it (passes only `.status`). Render a dim truncated preview for running/waiting → a glanceable "what is each agent saying" board instead of dots. Data is free (no new poll). _Where:_ ProjectsSection (pass lastLine), SessionCard. _Risk:_ pass it as a primitive + confine to changed cards so it doesn't undo the #34 per-poll memo.
- [ ] **Status-aware QuickSwitcher + per-pane tab/sidebar glyphs (shared helper)** — _(P:high · E:S)_ ⌘K QuickSwitcher has zero status awareness (DesktopView doesn't even pass it sessionStatuses) and DesktopTabBar shows no per-pane agent status. Extract one status-glyph helper (from SidebarRail) and reuse it across QuickSwitcher (+lastLine) and the tab bars so backgrounded panes self-announce. _Where:_ shared helper from SidebarRail; QuickSwitcher, DesktopView, Pane/DesktopTabBar. _Risk:_ read-only sessionStatuses; mind the ~5s-poll churn.
- [ ] **Thumb-size the terminal key toolbar (44px) + haptics + fix the scroll-button collision** — _(P:med · E:S)_ The most-tapped mobile controls (Esc/^C/Tab/arrows/Enter) are still ~30px (under the 44px shipped everywhere in #40), fire no haptic, and the floating scroll-to-bottom button sits behind the toolbar. Bump to ≥44px + `navigator.vibrate(5)` + offset the button. A mis-tapped ^C kills an agent's turn. _Where:_ TerminalToolbar, ScrollToBottomButton. _Risk:_ low; verify fit when the OS keyboard is up.
- [ ] **Keyboard focus-cycling + direct goto between split panes** — _(P:med · E:M)_ `focusPane` is only ever called from the mouse, so there's no keyboard way to move between the 2-4 split panes the #36 chords target. Add `mod+]`/`mod+[` cycling (+ optional `mod+alt+1..4`) with a focused ring, and let a QuickSwitcher pick name its destination pane. _Where:_ lib/panes.ts (nextPaneId), PaneContext, NAV_KEYBINDINGS, Pane, QuickSwitcher. _Risk:_ pane focus is client state; keep the tmux attach dance byte-identical — only change which handle is selected.
- [ ] **PWA standalone polish + mobile font stepper + sheet swipe-to-dismiss** — _(P:med · E:M)_ The full PWA manifest + Serwist SW are unused for UX: add an install hint + display-mode:standalone chrome trims + safe-area-inset-top; an A-/A+ mobile font stepper (11px fixed, zoom disabled = WCAG 1.4.4); and a grab-handle + swipe-down dismiss on the #48 bottom sheets. _Where:_ new usePwaInstall, globals.css, terminal-init.ts (font), dialog.tsx (sheet branch only). _Risk:_ low/additive; font change must flow through the existing resize path; verify iOS standalone (§1 gate).

### Stability

- [ ] **Make DELETE authoritative: kill the session's own pty + live-teardown its terminal** — _(P:high · E:M)_ DELETE deletes the DB row and kills _worker_ ptys but never calls `getSessionBackend().kill()` for the session's OWN pty — so on Tier-2 (Windows default) a "deleted" agent lingers for the daemon's life (pinning a CLI seat, blocking idle-shutdown, resurrectable by key), and the client keeps a live WS into the orphaned tab (ghost pane). Add the server kill + a Terminal `detach()` on the sessionId→null transition (§5 deferred item, both halves). _Where:_ app/api/sessions/[id]/route.ts DELETE, transport kill, Terminal/Pane teardown. _Risk:_ backend-agnostic kill (await/try-catch); client detach must distinguish delete from session-switch + stay behind intentionalClose.
- [ ] **Opt-in shared-secret auth (STOA_TOKEN) + a WS Origin/Host allowlist** — _(P:high · E:M)_ Zero auth/origin code exists, yet the server binds 0.0.0.0 — anyone reachable gets unauthenticated /api/exec, full-disk file r/w, and a real terminal over /ws/terminal; and any webpage can open the WS (no same-origin on sockets). Add an optional token (middleware for /api/\* + the upgrade handler) and a pure origin allowlist at the same upgrade seam. **Unset token + same-host = byte-identical to today.** _Where:_ new middleware.ts, server.on('upgrade'), new lib/auth.ts. _Risk:_ check at the upgrade boundary only; default-permissive for same-host so Tailscale UX is unchanged; opt-in only to tighten.
- [ ] **Neutralize /api/exec: default-off (STOA_ENABLE_EXEC) + execFile allowlist** — _(P:high · E:S)_ /api/exec runs `exec(command,{shell})` — literal arbitrary RCE, and a repo grep finds **zero** client callers. Gate the route off by default; when enabled, switch to execFile + a parsed-argv allowlist (the AGENTS.md pattern). _Where:_ app/api/exec/route.ts. _Risk:_ low — no callers, so default-off regresses nothing.
- [ ] **Port lib/worktrees.ts + the delete-cleanup off POSIX shell-strings to execFile** — _(P:high · E:M)_ Worktree create/delete build interpolated shell strings with `2>/dev/null || echo ""` — AGENTS.md-banned and broken under cmd.exe, so worktree cleanup on Windows can silently no-op (orphaning worktrees + locked branches, which makes the workspace dashboard lie). Convert to execFile argv (the lib/git.ts template). _Where:_ lib/worktrees.ts, app/api/sessions/[id]/route.ts:198-231. _Risk:_ POSIX byte-identical (same refs, same order); lock with an execFile mock test.
- [ ] **Surface failed-attach: handle the WS `error` frame** — _(P:med · E:S)_ server.ts emits `{type:'error'}` on attach failure, but the client only handles `output`/`exit` — so a failed attach leaves a black "Switching…" overlay that resolves to a dead empty terminal with no diagnosis. Add an `error` branch + an onAttachError callback (toast + Relaunch). Exactly the failure after orphan/delete races or a daemon restart. _Where:_ websocket-connection.ts, useTerminalConnection.ts. _Risk:_ additive branch; output/exit fast paths untouched.
- [ ] **Fix Tier-2 multi-client sizing (Windows clipping)** — _(P:med · E:M)_ Tier-1 registers a client at its REAL size; the daemon registers at the session's CURRENT size (the attach frame carries none) — so a second smaller client (phone) doesn't shrink the pty until a later resize, clipping its output. Pass the attaching client's cols/rows in the attach frame. _Where:_ host.ts attach (~106), protocol.ts + host-client.ts attach(). _Risk:_ optional/back-compat protocol field; tmux untouched.
- [ ] **Daemon uncaughtException guard + scoped retry on the flaky Windows pty test** — _(P:med · E:S)_ The Tier-2 daemon (default-on Windows) has zero process-level error trapping — one unhandled throw kills EVERY live session, the exact catastrophe Tier-2 promises to prevent. Add top-level handlers (keep-alive for per-session faults, still exit on a genuine listen failure) + a scoped `it.retry(2)` on the node-pty-spawn integration specs. _Where:_ scripts/pty-host.ts, host.ts startHost; vitest spawn-flaky specs. _Risk:_ low; scope the keep-alive to per-connection faults.
- [ ] **Lock the untested Tier-2 lifecycle contracts** — _(P:med · E:M)_ No coverage for: the `exit`-over-IPC → `[Session ended]` chain; **exit-after-reconnect** (a short agent that exits during a transient socket drop is repainted as alive — a real correctness hole); and the Tier-2→Tier-1 fallback ("no split brain"). Add specs + fix exit-after-reconnect by returning alive/exitCode on attach. _Where:_ test/pty-host.test.ts, new selection test; optional protocol field. _Risk:_ mostly additive; the fix touches IPC + reconnect — keep optional, isolate the test socket.

### Cross-cutting notes

- **WS-events milestone (largest deferred lever):** server-pushed status transitions, live conductor/worker output, Web Push (closed-tab), actionable quick-replies, and multi-device presence/dedup all want the SAME new `/ws/events` channel + the status-route transition source. Sequence as **its own milestone** (WS transport as a safety-net alongside the 5s poll → push emitter → presence/dedup → actionable replies via the send-keys seam), not scattered items — it's status/IPC-adjacent and wants a focused, well-tested change.
- **Shared status-glyph helper:** extract it once from `SidebarRail`; it underpins the card-preview, QuickSwitcher, and per-pane-tab usability items (avoids drift).
- **Editor lightness (highest ceiling, larger bet):** dropping `@monaco-editor/react` + `monaco-editor` and folding git-diff onto `@codemirror/merge` is the biggest bundle win but L-effort with real diff/inline-staging UX risk — pursue **after** the CodeMirror dedup lands (shared single-editor goal).
- **More §4 hardening (opt-in, below the auth/origin/exec trio):** file-API path-confinement (resolveWithinRoots over the working dirs already in SQLite), an agent-pty env allowlist (STOA_ENV_MODE over the single buildEnv chokepoint), and request body-size/concurrency caps on file/exec/upload.

---

## ⭐ Priority A — UI/UX: toward a native, local-app feel

Make session work feel instant and gesture-native on mobile while giving desktop power-users the keyboard-and-glance surfaces a local app provides.

- [x] **⭐ File explorer in the right drawer (shared with Git, mutually exclusive) + right-click "Copy path"** — ✅ done (PR #19). Replaced the `gitDrawerOpen` boolean with a per-pane `rightDrawer: "git" | "files" | null` state (Git icon ↔ folder icon, mutually exclusive). New `FileExplorerDrawer` = tree (reusing `FileTree` + `/api/files`) docked in the Git slot; clicking a file opens it in a **modal editor** (FileTabs + FileEditor), mirroring how Git opens a changed file, so the terminal stays visible. Right-click any node → **Copy path** / **Copy relative path** (`relativePath` helper, unit-tested; `useCopyToClipboard` + toast). Mobile keeps `viewMode="files"`; the deep-link file-open path is unchanged.
- [x] **Drive the mobile shell with `--app-height`** — ✅ done (PR #11). `MobileView` uses `h-screen` (100vh), so the terminal + Esc/Ctrl-C toolbar slide under the on-screen keyboard while typing; the `useViewportHeight()`/`.h-app` machinery is built but unused. Switch the mobile root to `h-app`, keep `h-screen` on desktop. _(high/S, Mobile/Viewport; see components/views/MobileView.tsx:39, hooks/useViewportHeight.ts, app/globals.css:51-56)_
- [x] **Re-enable the hover session-preview popover** — ✅ done (PR #12, + on-screen X-clamp). `SessionPreviewPopover` is complete and wired (live 720px ANSI snapshot, 2s refresh, hover state still computed) but its render is commented out, so users can't peek at a session without a destructive tmux re-attach. Uncomment, gate to desktop + non-select mode. _(high/S, SessionList; see components/SessionList/index.tsx:~299-310, components/SessionPreviewPopover.tsx)_ **Update: the popover was later removed** — redundant once session-switching became instant (#46), its 2s-refresh snapshot read stale/noisy, and it kept a per-hover 2s poll alive; the `SessionPreviewPopover` component + hover plumbing are gone. The backend `/api/sessions/[id]/preview` route is retained (harmless, reusable).
- [x] **Add a shortcut cheatsheet (`?` / `mod+/`)** — ✅ done (PR #13 overlay + PR #14 visible "?" button). only 3 global chords exist and the lone hint is a `⌘K` tooltip, so Alt+arrow cycling etc. is undiscoverable. Add a binding to `NAV_KEYBINDINGS` that opens an overlay rendered from the keybinding list (platform glyph via `isMacPlatform()`) so it stays in sync. _(high/S, Shortcuts; see app/page.tsx NAV_KEYBINDINGS, lib/keybindings.ts)_
- [x] **Resolve mobile-vs-desktop view before first paint** — ✅ done (PR #41). `app/page.tsx` now gates the Desktop/Mobile view on the existing `isHydrated` flag, rendering a neutral spinner shell until the client knows the viewport — so phones no longer flash `DesktopView` for a frame. Both SSR and the first client render show the shell (so they match — no hydration mismatch); once hydrated, the correct view renders. `useViewport` also lazy-inits `isMobile` from `window.innerWidth` so it's already correct the instant hydration completes (sidebar-open already gated on `isHydrated`). _(was high/M, Startup)_
- [x] **Replace all blocking `confirm()`/`alert()` with themed dialogs/toasts** — ✅ done (PR #17: `ConfirmProvider`/`useConfirm()` + toast; dead duplicate delete paths removed). delete session/project/group, discard edits, kill worker all use native `window.confirm`, and attach-failure fires a debug `alert()` referencing the desktop console — each freezes the UI and screams "web page". Route through the existing dialog stack / `KillAllConfirm` pattern + mounted sonner toaster. _(high/M, SessionList/Terminal; see app/page.tsx:297, ConductorPanel.tsx:145, SessionList/hooks/useSessionListMutations.ts:63/110/144)_
- [x] **Show an "attaching" state during pty re-attach** — ✅ done (PR #15: "Switching…" overlay cleared on first WS output). `attachSession` calls `xterm.reset()` immediately then waits for the WS snapshot, leaving a blank black terminal with no overlay (the "Connecting…" overlay only covers initial connect). Set a transient flag cleared on first `output` for the new key; hold/dim the old buffer or fade the snapshot in. _(high/M, Terminal; see components/Terminal/hooks/useTerminalConnection.ts:89-107, Terminal/index.tsx:291-320)_
- [x] **Surface a "needs attention" count + jump-to-waiting** — ✅ done (PR #16: amber count badge + click-to-jump cycling waiting/error; optional `mod+.` chord folds into the pane/view-shortcuts item below). per-session status dots exist but nothing aggregates them, so triaging many agents means visually scanning the list. Add a `"N waiting"` badge in `SessionListHeader` from `sessionStatuses` and a global chord (e.g. `mod+.`) that cycles only `waiting`/`error` sessions via the `selectRelativeSession` pattern. _(high/M, SessionList/Status; see components/SessionCard.tsx statusConfig, data/statuses/queries.ts, app/page.tsx)_
- [x] **Wire pane/tab/view keyboard shortcuts** — ✅ done (PR #23 + #36). #23: `⌘/Ctrl+B` toggle sidebar + `⌘/Ctrl+\` split. #36 adds the focused-pane view/tab chords via a new `paneCommandStore` (mirrors `fileOpenStore` — a global handler can't reach a pane's local `viewMode`/`rightDrawer`, so it publishes a command the focused pane consumes + clears): `⌘/Ctrl+Shift+G` Git drawer, `⌘/Ctrl+Shift+E` files, `⌘/Ctrl+Shift+S` shell, `⌘/Ctrl+Shift+→`/`←` next/prev tab. Conflict-safe — dodges browser-reserved chords (⌘T/⌘W, ⌘1..9 browser tabs) and shifted-punctuation normalization; the `.xterm` guard suppresses them in a focused terminal (consistent with `mod+b`), and they're auto-listed in the cheatsheet. _goto-tab-N deferred (⌘1..9 collides with browser tab switching)._ _(was high/M, Panes; contexts/PaneContext.tsx, components/Pane/index.tsx, stores/paneCommands.ts)_
- [x] **Add edge-swipe-to-open for the sidebar** — ✅ done (PR #47). `SwipeSidebar`'s touch handlers now branch on `isOpen`: when closed, a touch starting within 20px of the left edge that drags right pulls the sidebar in from -100% (clamped/rubber-banded), committing past a 50px threshold → `onOpen`. Mirrors the existing swipe-to-close. _(was high/M, Navigation)_
- [x] **Unify session-switch ordering across chevrons, swipe, and Alt+arrows over the *visible* list** — ✅ done (PR #37). New `lib/session-navigation.ts` `getSwitchableSessionOrder(sessions, projects)` is the single source of truth for the switch order: worker sessions excluded, project-grouped order in projects view (matches `ProjectsSection`), `group_path` grouping as the no-projects fallback, orphans appended so every session stays reachable (unit-tested). All four paths now consume it — `selectRelativeSession` (Alt+arrows, app/page.tsx), the `MobileTabBar` chevrons + dropdown, and the `Pane` swipe — so chevrons no longer leak workers and Alt+arrows follow the sidebar layout instead of MRU. The fixed 500ms nav lock is now backend-aware (pty 150ms / tmux 500ms via `getActiveBackend`). _(was medium/M, SessionSwitching)_
- [x] **Cut the hardcoded terminal startup/attach delays (~250ms+)** — ✅ done (PR #46, pty path). The 150ms pre-init `setTimeout` is now a `requestAnimationFrame` gated on the container being laid out (~16ms typical; a 5-frame fallback + the ResizeObserver refit cover a not-yet-sized container), and the pty attach fires immediately on connect (the 100ms wait was dead time after `onConnected`). The tmux 100ms+50ms dance is left byte-identical (locked path). _(was medium/M, Terminal)_
- [x] **Optimistically remove/move sessions on mutation** — ✅ done (PR #18): pure cache transforms (`removeSessionFromCache`/`patchSessionInCache`, unit-tested) feed `onMutate`/`onError`/`onSettled` on `useDeleteSession` + `useMoveSessionToGroup`; `useRenameSession` refactored onto the same helpers. **Move-to-project intentionally left non-optimistic** — see the server gap below. Dev-server-stop not covered (separate data layer). _(was medium/M, SessionList/mutations)_
- [x] **Fix server-side move-to-project (PATCH ignores `projectId`)** — ✅ done (PR #24): `PATCH /api/sessions/[id]` now persists `projectId` (sidebar groups flat by `project_id`, so this relocates the session); re-enabled the optimistic `useMoveSessionToProject` (no longer flashes-and-reverts). _was:_ `PATCH /api/sessions/[id]` only updates name/status/workingDirectory/systemPrompt/groupPath, so `useMoveSessionToProject` is a silent no-op (the session never actually moves). Add a `projectId` branch to the route and decide the `group_path` interplay (deprecated in favor of `project_id`); then make the mutation optimistic. _(high/S, API/SessionList; see app/api/sessions/[id]/route.ts:104-122, data/sessions/queries.ts useMoveSessionToProject, components/SessionCard.tsx:320-332)_
- [x] **Convert mobile New Session / QuickSwitcher to bottom sheets** — ✅ done (PR #48). Added an opt-in `sheet` prop to `DialogContent` (bottom-anchored, full-width, rounded-top, slide-up, `env(safe-area-inset-bottom)` padding); the default centered path is byte-identical. `NewSessionDialog` + `QuickSwitcher` pass `sheet={isMobile}` so inputs/actions stay above the on-screen keyboard. _(was medium/M, Mobile/Dialogs)_
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
