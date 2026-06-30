# Stoa — Roadmap

Stoa is a **mobile-first, self-hosted web UI for running AI coding agents
(Claude Code, Codex, Hermes, Kilo Code, Kimi Code) in real terminals — native on
Windows, macOS, and Linux.**

**Status (2026-06-30):** the big campaigns are **done** — the UI/UX campaign
(21/21, #215–#221), the Ask/Command Stoa chatbox (Phases 1–2, #223/#225/#226),
the end-to-end visual workflow builder (#239–#246) + assisted generator
(#262–#264), multi-repo workspace sessions (#237/#240), and the full
amux-inspired operator backlog (#1–#12, #14, #15) have all shipped (only #13,
native mobile shells, remains as a needs-human item). See **[Shipped to
date](#-shipped-to-date)** below. **This document is now the _forward_ roadmap:
the next wave of work, ordered by impact.**

---

## How this roadmap was built

Generated 2026-06-30 from a **9-agent research + engineering pass** (638k tokens):
**five web searchers** — competitor feature teardown (amux, Conductor, Vibe
Kanban, Crystal, Claude Squad, Sculptor, Terragon, Cursor/Copilot background
agents, Devin, OpenHands, Aider, Warp), mobile-first/remote-control wins,
small-but-loved QoL "big wins," the AI-orchestration capability frontier, and
adoption/distribution/trust — plus **three principal-engineer scans** of the repo
(architecture & simplification, correctness/cross-platform/security, and
DX/testing/perf). The findings were deduped and ranked by impact (highest first;
ties broken toward lower effort so true big-wins float up). Effort key: **S**
small · **M** medium · **L** large · **XL** very large.

---

## 🏆 Big wins — _simple thing, big win_ (do these first)

The highest impact-to-effort items the research surfaced (copy/paste was already
this archetype — solved). Most are **S/M** and land on seams that already exist.

- ✅ **OS app-icon badge for attention** (S) — **SHIPPED (#318).**
  `setAppBadge(waitingCount)` from the state-change check that already computes it.
  A red **N** on the home-screen icon is the only glanceable "agents need you"
  signal on an installed PWA; the tab title is never seen on a phone. (SW-push badge
  for a fully-closed PWA deferred.)
- **STOA_PORT honored by `npm run dev`** (S) — map `STOA_PORT`→`PORT` in
  `lib/load-env.ts`. The documented knob silently no-ops in dev and `stoa doctor`
  disagrees with the actual bind.
- **Windows `.cmd` EINVAL in commit-message + summarize** (S) — route the `claude`
  `.cmd` shim through `cmd.exe /c`; two features are 100% broken on Windows today
  and the fix already exists in-repo.
- **Cost-key collision for same-named Windows sessions** (S) — key `session_costs`
  on the canonical backend key, not the display name (NULL `tmux_name` on pty).
- **Recurring schedule floods a busy session** (S) — skip-if-already-queued / cap
  queue depth so an hourly schedule on a wedged session can't build an unbounded
  backlog.
- **Audit/activity timeline read surface + export** (M) — a read window over the
  immutable ledger Stoa already writes ("what did my agent / Command Stoa do?").
- **Inline-reply push notifications** (M) — answer a waiting agent (y/n, a path, a
  plan approval) from the lock screen without opening the app.
- **Prompt-cache-aware launch + cache-hit panel** (M) — keep the cached prefix
  byte-identical across a wave's workers; cached reads are ~0.1× input price and
  Stoa fans many workers over the same repo prefix.

---

## Backlog — ordered by impact

> Categories: `bug` `feature` `mobile` `orchestration` `adoption` `perf`
> `security` `tech-debt` `simplification` `test` `docs`. 🐛 = a **confirmed**
> defect in current code (verify-then-fix; ship a regression test).

> **✅ Shipped from this roadmap:** #4 Map `STOA_PORT`→`PORT` for `npm run dev`
> (#311) · #5 Windows `.cmd` EINVAL in commit-message + summarize (#312) · #6 Key
> `session_costs` on the canonical backend key (#313) · #7 Coalesce recurring
> schedules so a busy session isn't flooded (#314) · #8 Self-resolve the
> native-fork parent on re-attach (#315) · #1 Fix the native-fork cost
> double-count (#316) · #2 Stop a live-wall observer from evicting a pane's resize
> on the Windows pty-host (#317) · #3 OS app-icon badge for the "needs you" count
> (#318).
>
> **🐛 All seven confirmed bugs (#1, #2, #4, #5, #6, #7, #8) are now shipped.**

### Tier 0 — 🛰️ Agent Monitor (abtop-inspired) — TOP PRIORITY

A native "**htop for your AI agents**" observability surface, inspired by
[graykode/abtop](https://github.com/graykode/abtop) (Rust TUI, MIT). abtop is the
read-only OBSERVABILITY half of Stoa's domain; Stoa is the CONTROL plane. We port
the IDEAS natively in TypeScript (no Rust binary — keeps Stoa npm-only + native on
3 OSes) reusing seams Stoa already owns (`computeManagedStatuses`,
`computeSessionCosts`, `lib/rate-limit.ts`, `lib/dev-servers.ts` netstat/lsof), and
cover ALL providers, not just abtop's Claude/Codex/OpenCode. **It opens as its own
tab/session** (a new fleet view, mirroring the Live Wall). Built one PR at a time.

- ✅ **M1 — Agent Monitor view (new tab)** — `feature` · M. **SHIPPED (#319).** A
  read-only fleet view (mirrors `components/views/LiveWallView`) opened from a
  fleet-nav button + ⌘K — one row per live session showing the telemetry Stoa
  ALREADY computes: status, model, token usage, context-window % (with a saturation
  band), and cost, sorted attention-first. Pure, tested row/merge/sort/format
  helpers in `lib/agent-monitor.ts`; the view reuses the existing
  `/api/sessions/cost` (via `useSessionCosts`) + the session roster — **no new
  backend**. _Seam:_ `lib/agent-monitor.ts`, `components/views/AgentMonitorView`,
  `lib/panes.ts`, `view-meta.tsx`, `FLEET_NAV`, `QuickSwitcher`, `Desktop/MobileView`,
  `Pane`, StoaGuide. _Deferred follow-ups: a global keybinding (the mnemonic chords
  are browser-reserved), git change-counts, and a managed-status override._
- **M2 — Rate-limit window % (5h/7d quota)** — `orchestration` · M/L. abtop's crown
  jewel: surface the Claude rate-limit WINDOW utilization (5h/7d) — proactive,
  unlike today's reactive "limit reached" screen-scrape. **DECISION (2026-06-30):
  Stoa installs its OWN Claude statusline hook** (not reading abtop's file), so the
  capability is Stoa-owned. Build sub-plan (one PR each, in order):
  - ✅ **M2a — SHIPPED (#320).** Pure window MODEL in `lib/rate-limit-window.ts`
    (`parseWindowRecord`, `windowUtilization` = the binding max of the 5h/7d
    windows, `isWindowStale` — reject >10-min-old data, all fail-closed/null-on-
    doubt), unit-tested. The cost route reads the Stoa-defined
    `~/.stoa/rate-limits.json` best-effort and adds `rateLimitWindow` to its
    response; the Agent Monitor shows a global "quota" gauge when present (nothing
    until M2b installs the hook — fail-closed).
  - **M2b** — the statusline-hook INSTALLER: an opt-in `stoa` setup step that
    merges a `statusLine` command into `~/.claude/settings.json` (NEVER clobbering
    existing config) running a small Stoa script that maps Claude's statusline JSON
    → the M2a record. **Verify the Claude statusline JSON schema first** (claude
    `--help` / docs) — do not guess the field names.
  - **M2c** — feed the window % into Dispatch + the watchdog so the fleet backs off
    BEFORE a hard stall (reuse the `server.ts` tick + `lib/rate-limit.ts` resume
    gating). _Seam:_ new `lib/rate-limit-window.ts`, `lib/agent-monitor.ts`,
    `scripts/stoa.js`, `server.ts` tick, `lib/dispatch`.
- **M3 — MCP-server + subagent/child-process tree per session** — `feature` · M.
  Detect each session's child-process / subagent fan-out and its MCP servers
  (process inspection + the existing netstat/lsof primitive); surface in the
  Monitor. _Seam:_ `lib/agent-monitor.ts`, `lib/platform.ts`, `lib/dev-servers.ts`.
- **M4 — Orphan-port-per-session attribution** — `feature` · M. Attribute ANY
  agent-spawned listening port to its owning session (not just Stoa-spawned
  DevServers) and flag orphans in the Monitor. _Seam:_ `lib/dev-servers.ts`,
  `lib/ports.ts`, `lib/agent-monitor.ts`.
- **M5 — Telemetry Snapshot schema + JSON export** — `feature` · S. A normalized TS
  telemetry type aligned to abtop's serde `Snapshot` field names
  (`context_percent`, `cache_read_tokens`, `orphan_ports`, `rate_limits`,
  `mcp_servers`, …); `GET /api/monitor?format=json` emits an abtop-compatible
  snapshot for interop. _Seam:_ `lib/agent-monitor.ts`, `app/api/monitor`.
- **M6 — Optional `abtop --json` external sensor** — `orchestration` · M.
  _(deferred — the only option that adds a non-npm dependency.)_ When an `abtop`
  binary is present, best-effort `execFile abtop --json --once` (argv array, JS
  parse, fail-closed) to enrich Codex/OpenCode sessions Stoa can't parse natively,
  incl. agents started OUTSIDE Stoa. Strictly optional, never a hard dependency.

### Tier 1 — High impact (ranks 1–32)

> Ranks **1, 2, 4, 5, 6, 7, 8** are confirmed bugs — clear these first; they're
> cheap trust wins and several corrupt cost/analytics or break a first-class
> platform.

1. ✅ 🐛 **Fix native Claude fork cost double-count** — `bug` · L.
   **SHIPPED (#316).** A native fork's row now stores the parent's cumulative usage
   AT FORK TIME (`fork_cost_baseline` JSON, migration 44, written by the fork route
   from the parent's transcript); `computeSessionCosts` nets it out (`netForkUsage`,
   clamped ≥0) so only the fork's OWN spend counts — fixing the live badge, the
   persisted samples, AND the curve at one seam. contextTokens (live window) is left
   as-is. (Only new forks get a baseline; forks predating the change keep NULL — the
   parent-at-fork snapshot is unrecoverable.) _Seam:_ `lib/session-cost.ts`,
   `app/api/sessions/[id]/fork/route.ts`, `lib/db/{migrations,schema,types,queries}.ts`.
2. ✅ 🐛 **Fix Windows live-wall observer evicting pane resize** — `bug` · L.
   **SHIPPED (#317).** The daemon attach handler now REUSES the one output/exit sub
   per key per connection (the client fans out + sends a single detach) and
   PRESERVES the viewer's sizing `clientId` instead of detaching-and-recreating — so
   a live-wall observer attaching a full-screen worker no longer nulls that pane's
   sizing slot. Protocol-preserving (no host-client/IPC change), locked by a Tier-2
   IPC regression test. _Seam:_ `lib/session-backend/pty/host.ts`. _Deferred (S): true
   per-viewer min-sizing for two REAL same-key viewers on one connection (still
   last-size-wins) — needs per-subscription slots + a sub id in detach._
3. ✅ **OS app-icon badge for attention count** — `mobile` · S. **SHIPPED (#318).**
   `setAppBadge(waitingCount)` (pure `appBadgeAction` + a feature-detected,
   best-effort applier in `lib/notifications.ts`) is driven from the live
   state-change check in `hooks/useNotifications.ts` alongside the tab-title count.
   The badge is sticky on an installed PWA's home-screen icon (survives
   backgrounding). _Seam:_ `lib/notifications.ts`, `hooks/useNotifications.ts`.
   _Deferred (S): the SW-push-payload badge for a fully-CLOSED PWA — needs the
   server push to carry a fleet "needs you" count (`app/sw.ts`, `lib/push*.ts`)._
4. ✅ 🐛 **Map `STOA_PORT`→`PORT` for `npm run dev`** — `bug` · S. **SHIPPED (#311).**
   `portAlias()` in `lib/load-env.ts` bridges `STOA_PORT`→`PORT` on startup
   (STOA_PORT wins), so `npm run dev` honours the knob the same way the CLI and
   `stoa doctor` do. _Seam:_ `lib/load-env.ts`.
5. ✅ 🐛 **Fix Windows `.cmd` EINVAL in commit-message + summarize** — `bug` · S.
   **SHIPPED (#312).** New shared `lib/claude-oneshot.ts` (`runClaudeOneshot`,
   mirroring `lib/ask.ts`: `shell: isWindows` so the `.cmd` shim runs, prompt
   always on stdin) replaces the `shell:false` spawns in both routes. _Seam:_
   `lib/claude-oneshot.ts`, `app/api/git/commit-message/route.ts`,
   `app/api/sessions/[id]/summarize/route.ts`.
6. ✅ 🐛 **Key `session_costs` on the canonical backend key** — `bug` · S.
   **SHIPPED (#313).** `metasFromSessions` (cost-history) and the analytics event
   join now key on `backendKeyForSession(s)` (tmux_name, else the unique
   `{provider}-{id}`) instead of `tmux_name || name` — same-named pty sessions no
   longer clobber each other's cost row, and pty-session events are counted in
   analytics. _Seam:_ `lib/cost-history.ts`, `lib/analytics/queries.ts`.
7. ✅ 🐛 **Skip-if-queued / cap depth for recurring schedules** — `bug` · S.
   **SHIPPED (#314).** `fireSchedule` takes an injected `isQueued` predicate and
   coalesces a still-pending duplicate (advances the cadence but skips the enqueue);
   `server.ts` passes `listQueue(id).includes(p)`. A recurring schedule against a
   busy/wedged session no longer builds an unbounded backlog. _Seam:_
   `lib/scheduler.ts`, `server.ts`.
8. ✅ 🐛 **Self-resolve native-fork parent on respawn** — `bug` · M.
   **SHIPPED (#315).** A shared pure `resolveNativeForkParentId(session, allSessions)`
   in `lib/fork.ts` now backs BOTH the first launch (`app/page.tsx`) and the
   re-attach (`buildSpawnForSession`, fed `allSessions` from `Pane`) — so a native
   fork that reconnects before its first turn resumes its parent
   (`--fork-session`) instead of respawning blank. _Seam:_ `lib/fork.ts`,
   `lib/client/backend.ts`, `components/Pane/index.tsx`, `app/page.tsx`.
9. **Inline-reply push notifications** — `mobile` · M. Text reply action in the SW
   → POST to a new reply route → `SessionBackend.write`. _Seam:_ `app/sw.ts`,
   `lib/notification-actions.ts`, `app/api/sessions/[id]/reply/route.ts`.
10. **Audit/activity timeline read surface + export** — `adoption` · M. `GET
/api/sessions/[key]/events` + fleet `GET /api/audit` + an Activity panel
    (filterable, JSON/CSV). _Seam:_ `lib/db/queries.ts`, `lib/command/audit.ts`,
    new AuditView, `FLEET_NAV`.
11. **`stoa share` — one-command secure remote access** — `adoption` · M. Detect
    Tailscale funnel (else cloudflared), append `?token=`, print a QR, register the
    WS origin, fail-closed if auth is off. _Seam:_ `scripts/stoa.js`, `lib/auth.ts`.
12. **Prompt-cache-aware launch + cache-hit panel** — `perf` · M. Keep the cached
    prefix byte-identical across turns/siblings; surface a cache-hit stat. _Seam:_
    `lib/banner.ts`/`prompt-compose.ts`, `lib/cost-history.ts`, `lib/analytics/engine.ts`.
13. **Project Playbooks + auto-recalled Knowledge** — `feature` · M. Named
    launch-target recipes (success criteria/guardrails as seed) + short pinned
    per-repo facts auto-prepended; feeds the assisted generator. _Seam:_ new
    `lib/playbooks.ts`, `lib/prompt-compose.ts`, NewSessionDialog, `lib/command/actions.ts`.
14. **Reusable warm-environment snapshots + startup commands** — `feature` · M. A
    named snapshot of a prepared worktree (deps/.env/build cache); new sessions boot
    from it. _Why:_ cold `npm install`/build per worktree is the biggest fan-out tax
    (worse on Windows). _Seam:_ `lib/env-setup.ts`, `lib/multi-repo-worktree.ts`,
    `lib/workspace-session.ts`.
15. **Attention-first fleet bar** — `feature` · M. An always-visible strip ranking
    live sessions by who needs you now (blocked > errored > idle-done > running).
    _Seam:_ `lib/session-status.ts`, `lib/session-attention.ts`, new strip component.
16. **iOS push self-healing on launch** — `mobile` · M. On focus when
    standalone+subscribed, re-subscribe if the endpoint silently dropped; prune dead
    endpoints. _Why:_ directly fixes the known "iOS PWA push is flaky" gap. _Seam:_
    `hooks/useWebPush.ts`, `lib/push.ts`, `app/api/push/subscribe`.
17. **Manifest shortcuts + Web Share Target** — `mobile` · M. Home-screen
    shortcuts (New Session, Board, Ask, Live Wall) + a share target to forward
    text/URL/image into New Session/Dispatch. _Seam:_ `public/manifest.json`, new
    `app/share/page.tsx`, `app/sw.ts`.
18. **Transcript cost cache (stat-gated)** — `perf` · M. Module-level cache keyed
    by transcript path, invalidated on `mtime`+size; shared across cost route,
    budget tick, sampler, analytics. _Why:_ largest avoidable steady-state CPU/IO.
    _Seam:_ `lib/session-cost.ts`, `lib/claude-transcript.ts`, `server.ts`.
19. **Outcome-based verify badge on interactive sessions** — `feature` · L. On a
    "done" claim, actually run the project's verify command and show a real
    red/green badge — independent of the agent's self-report. _Seam:_
    `lib/dispatch/verify.ts`, `lib/status-detector.ts`, `components/SessionCard.tsx`.
20. **Cost-aware model routing + cascade escalation** — `orchestration` · L. Route
    routine work to a Haiku-class model, mid to Sonnet, hard to frontier; escalate a
    tier on verify/judge failure. _Why:_ Stoa persists cost but never acts on it.
    _Seam:_ new `lib/model-router.ts`, `lib/model-catalog.ts`, `lib/orchestration.ts`.
21. **Per-session cost budgets with alert + opt-in auto-pause** — `adoption` · M.
    Daily/monthly budget, soft alert at 80/100%, opt-in fail-closed park at cap
    (reuse the rate-limit park decision). _Seam:_ `lib/cost-history.ts`,
    `lib/rate-limit.ts`, `server.ts` tick, push path.
22. **`computeSessionCosts` direct test (budget-kill path)** — `test` · M. Inject a
    fake usage reader; assert short-circuits, concurrency cap, and that the cost GET
    never 500s. _Why:_ this feeds the loop that can kill sessions, yet only the pure
    parsers are tested. _Seam:_ `test/session-cost.test.ts`.
23. **Clickable `file:line` jump-to-error in terminal** — `feature` · M. An xterm
    link provider over a pure extractor; click opens the file at the line (or inserts
    the path on mobile). _Seam:_ `components/Terminal/hooks/terminal-init.ts`, new
    `lib/terminal-links.ts`, `components/FileExplorer/FileEditor.tsx`.
24. **@-mention file autocomplete in the send bar** — `feature` · M. On `@`, an
    inline fuzzy file dropdown from the working dir (reuse the recursive fuzzy +
    `fuzzyScore`). _Seam:_ `components/Terminal/index.tsx`, `components/MessageInput.tsx`.
25. **Compaction control + external-memory injection** — `orchestration` · M. Make
    the context gauge a trigger: custom compaction prompt, PreCompact flush of
    NOTES/TODO into the worktree, PostCompact re-inject. _Why:_ long runs silently
    drop load-bearing constraints at compaction. _Seam:_ `lib/context-window.ts`,
    `lib/snapshots.ts`, `lib/notes.ts`, `lib/summarize.ts`.
26. **LLM-as-judge rubric review gate** — `orchestration` · M. A binary rubric judge
    (tests added? no secret left? matches AGENTS.md? no injection shape?) alongside
    typecheck/test/build; block/downgrade auto-merge on failure. _Why:_ the
    safeguard that makes cheap-model routing safe. _Seam:_ `lib/dispatch/reviewer.ts`,
    `verify.ts`, `lib/verdict-inbox.ts`, `lib/dispatch/auto-merge.ts`.
27. **OS-level sandbox launch tier (replace all-or-nothing yolo)** — `security` · L.
    Tri-state Prompt/Sandboxed-auto/Full-bypass; wrap the agent in FS+net isolation
    (Seatbelt/bubblewrap/restricted-worktree+proxy). _Why:_ workers run with full
    host access today — the biggest blast radius for unattended fleets. _Seam:_ new
    `lib/sandbox/`, `lib/providers/registry.ts`, `lib/orchestration.ts`.
28. **Embedded live app preview with click-to-comment** — `feature` · L. An iframe
    over the worktree dev-server URL with a device selector + element-picker that
    turns a note into a structured message to the worker. _Seam:_ new PreviewPanel,
    `lib/dev-servers.ts`, `lib/diff-comment.ts`.
29. **Terminal gestures (cursor-drag, swipe, pinch)** — `mobile` · L. Long-press-drag
    to move the cursor, double-tap=Tab, pinch=font size, swipe=switch session. _Why:_
    positioning the cursor / hitting Tab is the worst part of a phone CLI. _Seam:_
    `components/Terminal/index.tsx`, new `hooks/useTerminalGestures.ts`.
30. **First-run onboarding wizard** — `adoption` · M. A 3–5 step checklist on the
    empty state: detect a CLI, confirm auth, pick a dir, enable remote access (QR),
    create the first session. _Seam:_ new OnboardingChecklist + a readiness endpoint
    reusing `stoa doctor` checks.
31. **Refactor `server.ts` tick into a write-arbiter orchestrator** — `tech-debt` · L.
    A `TickContext` + ordered pure "tick actors" each exposing `decide()` with one
    shared `claimWrite()` arbiter, so "one write per session per tick" is structural,
    not per-pair predicates. _Why:_ the 460-line mega-loop with 9 cross-coupled maps
    is the highest-risk, least-testable module (already a source of composition bugs).
    _Seam:_ `server.ts`, `lib/tick-guards.ts`, new `lib/status-tick.ts`.
32. **Single `buildAgentArgsForSession` chokepoint** — `tech-debt` · M. One builder
    doing the shell short-circuit + model clamp + MCP-arg parse + arg build, routed
    by every Session-shaped caller so the injection-defense clamp is non-bypassable.
    _Seam:_ `lib/providers.ts`, `lib/client/backend.ts`, `app/page.tsx`, `lib/fork.ts`.

### Tier 2 — Medium impact (ranks 33–49)

33. **Customizable snippet/quick-command chips + template variables** — `mobile` · M.
    A user-editable snippet bar above the keyboard + `{{placeholder}}` fill-in.
    _Seam:_ `components/Terminal/VirtualKeyboard.tsx`, `SnippetsModal.tsx`, new
    `lib/snippets.ts`.
34. **Issue-tracker intake beyond GitHub (Linear/Jira)** — `feature` · M. Generalize
    the issue source behind an interface; add Linear/Jira clients + a source picker.
    _Seam:_ `lib/dispatch/issues.ts`, `lib/dispatch/github.ts`, new Linear client.
35. **Reusable scoped subagent library** — `orchestration` · M. Promote workflow
    roles into first-class subagent defs (tools allowlist + per-role model),
    materialized into each provider's native subagent dir. _Seam:_
    `lib/command/workflow-roles.ts`, `lib/skills.ts`, `saved-workflows.ts`.
36. **Secrets guard at session creation** — `security` · S. Scan the chosen dir for
    `.env`/credentials, warn that agents auto-load them, offer a one-click deny rule.
    _Seam:_ new scanner, NewSessionDialog, `stoa doctor`, `lib/skills.ts`.
37. **Undo toast for destructive actions** — `feature` · S. Delay+cancel wrapper for
    kill session, Git discard, Notes/Snippets delete; "Restart that session" where a
    true undo is impossible. _Seam:_ new `lib/undoable-action.ts` + existing sonner.
38. **Recents + pinned in the Quick Switcher** — `feature` · S. Give the ⌘K palette a
    memory (MRU + pinned), mirroring `lib/prompt-history.ts`. _Seam:_
    `components/QuickSwitcher.tsx`, new `lib/palette-recents.ts`.
39. **Screen Wake Lock while watching a live run** — `mobile` · S. Acquire
    `wakeLock` when a terminal/Live Wall pane is foregrounded with an active agent.
    _Seam:_ new `hooks/useWakeLock.ts`, `components/Terminal/index.tsx`, Live Wall.
40. **Copy command+output as Markdown** — `feature` · S. A "Copy as Markdown" action
    that strips ANSI and fences the captured text — ready for an issue/Notes/channel.
    _Seam:_ `components/Terminal/TerminalToolbar.tsx`, new `lib/markdown-block.ts`.
41. **Pull-to-refresh + tap haptics** — `mobile` · S. Pull-to-refresh on the session
    list + feature-detected `vibrate` on send/approve/kill/copy. _Seam:_ new
    `hooks/useHaptics.ts`, `components/SessionList/*`.
42. **Single-pass transcript parse** — `perf` · S. Merge the usage + context-token
    parsers into one walk over the JSONL. _Why:_ two full passes per read today.
    _Seam:_ `lib/session-cost.ts`.
43. **StoaGuide in-app docs drift fix** — `docs` · S. Add Guide entries for
    Ask/Command Stoa, the Quick Switcher, multi-repo sessions, Best-of-N. _Why:_ all
    shipped + in README but absent from the in-app Guide. _Seam:_
    `components/StoaGuide.tsx`, `README.md`.
44. **Checkpoint / time-travel / fork-from-any-point** — `feature` · L. A persisted
    checkpoint timeline (worktree state + transcript point) with rewind + "fork from
    here"; watchdog auto-rewinds wedged workers. _Seam:_ `lib/snapshots.ts`,
    `lib/fork.ts`, `lib/db/migrations.ts`, `lib/fleet-board`, `lib/watchdog.ts`.
45. **OpenTelemetry GenAI trace export** — `orchestration` · M. An OTLP exporter
    (no-op unless `STOA_OTEL_ENDPOINT` set) emitting GenAI spans per run/turn/tool/
    model. _Why:_ instant Langfuse/any-OTEL compatibility. _Seam:_ new
    `lib/telemetry/otel.ts`, `lib/orchestration.ts`, `mcp/orchestration-server.ts`.
46. **Read-only spectator share links** — `adoption` · L. A scoped OBSERVER token
    that can stream the Live Wall WS but is rejected by every mutating op. _Why:_
    today the only token is the master = full control. _Seam:_ `lib/auth.ts`, new
    share-token table, LiveWall observer WS.
47. **Container/sandbox isolation transport** — `orchestration` · XL. A
    `ContainerTransport` implementing `PtyTransport` (not a new backend): run the
    agent in Docker/dev-container; "pairing" applies the diff back to the host.
    _Seam:_ new ContainerTransport, `lib/session-diff.ts`, `lib/multi-repo-stage.ts`.
48. **MCP elicitation + sampling (2025-11 spec)** — `orchestration` · L. Under-specified
    tool calls request structured input via the confirm UI; server tools request
    completions through the host (operator model/budget). _Seam:_
    `mcp/orchestration-server.ts`, `lib/verdict-inbox.ts`, `lib/ask.ts`.
49. **Per-device named revocable tokens** — `security` · L. Evolve the single shared
    token into a named, individually-revocable set (phone/laptop/spectator) with
    scope. _Seam:_ `lib/auth.ts`, new tokens table, Settings panel.

### Tier 3 — Lower impact / cleanups & tech-debt (ranks 50–57)

50. 🐛 **Channel push double-deliver race + orphan cleanup + DISTINCT scan** — `bug` · M.
    Atomically claim a channel row before paste; delete a session's
    `channel_messages`+`schedules` on delete; replace the per-session tick scan with
    one `SELECT DISTINCT`. _Seam:_ `server.ts`, `lib/channels.ts`,
    `lib/channel-delivery.ts`, `app/api/sessions/[id]/route.ts`, `lib/db/queries.ts`.
51. 🐛 **Resolve rate-limit vs error classification** — `bug` · M. Prefer the
    rate-limited classification when a reset time is present; tighten `ERROR_PATTERNS`
    so pure rate-limit wording isn't bucketed as error. _Why:_ those episodes are
    never auto-resumed today. _Seam:_ `lib/status-detector.ts`, `lib/rate-limit.ts`.
52. **Notification grouping + quiet hours + per-session mute** — `mobile` · M. Stable
    per-session tag, silent low-priority completions, a quiet-hours gate + mute swipe.
    _Why:_ fleet notification fatigue → users disable push entirely. _Seam:_
    `app/sw.ts`, `lib/push.ts`, `components/SessionCard.tsx`, `lib/notifications.ts`.
53. **Jump-between-commands + sticky command header** — `feature` · L. Prompt-boundary
    navigation over the captured VT buffer (the Warp-blocks 80%, no OSC needed).
    _Seam:_ `components/Terminal/index.tsx`, new `lib/terminal-blocks.ts`,
    `lib/keybindings.ts`.
54. **Split `lib/db/queries.ts` into domain modules** — `tech-debt` · L. Split the
    194-builder god-object into domain files re-composed in an index (zero call-site
    churn); type the prepared-statement wrappers to drop `as Row[]` casts. _Why:_ a
    constant merge-conflict magnet; untyped casts feed the budget kill loop. _Seam:_
    `lib/db/queries.ts`, `lib/db/index.ts`.
55. **Centralize `STOA_AUTO_*` flags + guarded-interval helper** — `tech-debt` · M.
    One typed `getAutoFeatures()` + `anyTickEnabled()`/`describeEnabled()`, and a
    `makeGuardedInterval()` so the 4–5 timers stop re-deriving the busy-guard/unref
    scaffolding. _Seam:_ `server.ts`, new `lib/auto-features.ts`, the auto-* libs.
56. **Pin install/update to a verified release tag** — `adoption` · M. Clone a
    documented release tag (+ optional checksum) instead of HEAD of `main`, with a
    `--channel main` escape hatch. _Seam:_ `scripts/install.sh`/`.ps1`,
    `scripts/stoa.js` `cmdUpdate`. _(Deferred trust boundary — ship opt-in/guarded.)_
57. **Extract `WorkflowBuilder` into hooks + sibling components** — `tech-debt` · L.
    Decompose the 1800-line/27-hook component into `useWorkflowDoc`/`useCanvasSelection`/
    `useWorkflowPersistence` + sibling toolbar/inspector/canvas. No behavior change.
    _Seam:_ `components/views/WorkflowsView/WorkflowBuilder.tsx`.

---

## ✅ Shipped to date

Condensed record (full detail in git history). All of the below is **done**.

- **Dispatch (the moat):** autonomous GitHub issue→PR fleet · 3-critic review gate
  · self-rebasing merge train · conflict-aware spec decomposition · verification
  harness · plan-approve-execute gate · Best-of-N + side-by-side compare · webhook
  intake · warm worktree pool.
- **Workflows:** end-to-end visual DAG builder (drag-and-drop canvas, drag-to-connect
  edges, saved/reloadable, import/export, #239–#246) + an LLM **assisted workflow
  generator** (#262–#264).
- **Operator surfaces:** Ask/Command Stoa chatbox (propose→confirm→execute, #223/
  #225/#226) · multi-repo workspace sessions + session-scoped Git panel (#237/#240)
  · ⌘K Quick Switcher (Sessions/Code/Output) · the 21-item UI/UX campaign
  (#215–#221).
- **amux-inspired operator backlog (#1–#12, #14, #15):** self-healing watchdog ·
  cross-session output search · worktree-conflict badge · rate-limit budget
  hardening · agent data tools over MCP (shared memory) · Notes · inter-agent
  channels · scheduler · live-wall grid · per-provider native slash commands ·
  all-provider conversation fork · token/cost persistence · offline command queue +
  replay · `stoa doctor`. _Only #13 (native iOS/Android shells) remains — needs a
  native toolchain (Xcode/Android SDK + signing); left for a human._
- **Earlier:** the autonomous maintainer (#203/#204), the small-big QoL campaign
  (#205–#209), and the early UX fixes (#210–#213).

---

## 🅿️ Parked

### Campaign follow-ups (small)

- **Per-attach generation guard** — drop a superseded in-flight `error`/`exit` WS
  frame from a rapid A→B→C session switch (#211 review).
- **Editable approval command** — edit a proposed command before approving it in the
  auto-steer escalation (touches the sensitive auto-steer core).
- **Fleet Board lane-pill vs nav-badge** — align the board's header pill and the nav
  "needs me" badge so a badge "3" can't open a board reading "1" (#218).
- **SegmentedTabs `radiogroup` variant** — an optional role variant for the
  panel-less AllocationConsole mode toggle (#221).

### Bigger bets (full features)

- **Still parked:** Task playbooks (superseded by **#13** above) · Hot-swap manual
  QA · One-tap structured mobile approvals (subsumed by **#9** inline-reply) ·
  Maintainer v2 (auto-dispatch + deploy/monitor/self-heal).

### Removed (don't re-add)

- **Playwright visual-regression gate** (added #290) — **removed 2026-06-30.** It
  was red since inception (no baselines were ever committed → `toHaveScreenshot`
  fails-to-write on every run), non-blocking, and ignored — pure CI noise that
  delivered zero caught regressions and cost a debugging session. `tsc` + the vitest
  suite (×3 OS) + the mandatory 3-agent review (whose Gate C is simplicity/UX) cover
  regressions. If a visual safety net is wanted later, _re-introduce it properly_
  (generate Linux baselines via a workflow + commit them + make it blocking) rather
  than restoring the perpetually-red job.

---

_History: the autonomous maintainer (#203/#204), the small-big QoL campaign
(#205–#209), the early UX fixes (#210–#213), the UI/UX campaign (#214–#221), and
the amux-inspired advancement loop all live in git history. This forward roadmap
was generated 2026-06-30 from a 9-agent research + engineering pass._
