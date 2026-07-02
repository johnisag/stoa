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
  - ✅ **M2b — SHIPPED (#322).** The statusline-hook INSTALLER.
    `scripts/claude-statusline-hook.js` (a dependency-free hook Claude runs per
    session) maps Claude's **verified** statusline JSON
    (`rate_limits.{five_hour,seven_day}.{used_percentage 0..100, resets_at epoch
sec}`) → the M2a record at `~/.stoa/rate-limits.json` — fail-open, and skips the
    write when no window is present so a free-tier / pre-first-response session can't
    clobber a good record. `stoa statusline` merges the `statusLine` into
    `~/.claude/settings.json` WITHOUT clobbering existing config or a user's own
    statusLine; `stoa doctor` advertises it (warn + hint) when Claude is installed but
    the hook isn't. The M2a quota gauge now lights up. _Seam:_
    `scripts/claude-statusline-hook.js`, `scripts/stoa.js`.
  - ✅ **M2c — SHIPPED (#324).** Proactive backoff: when Claude's binding 5h/7d window
    is saturated, the Dispatch reconciler HOLDS new claude workers (candidates stay
    pending, FIFO) and the age-reaper spares a throttled (not hung) worker. Pure
    `isWindowSaturated` + an opt-in threshold (`STOA_DISPATCH_RATELIMIT_BACKOFF`, a
    fraction or percent; off by default → zero I/O and no behavior change). Fail-OPEN:
    absent window data never throttles. The `fs` reader was split into a server-only
    `lib/rate-limit-window-source.ts` so the client-safe model stays node-builtin-free.
    The wedged-session watchdog is intentionally NOT touched (escalate-only → no API
    load to back off; suppressing it on proactive saturation would mask real wedges).
    Reactive resume (`lib/rate-limit.ts`) still drains sessions already AT the limit.
    _Seam:_ `lib/rate-limit-window.ts`, `lib/rate-limit-window-source.ts`,
    `lib/dispatch/reconciler.ts`, `server.ts` banner, `.env.example`.
- ✅ **M3 — MCP-server + subagent/child-process tree per session** — `feature` · M.
  **SHIPPED (#326).** A new `getPid(name)` on the SessionBackend seam (tmux
  `#{pane_pid}`; pty via a `pid` IPC message mirroring `panePath`) gives each session a
  root pid; `lib/process-tree.ts` snapshots the host (POSIX `ps` / Windows PowerShell
  `Get-CimInstance`, fail-closed) and walks the subtree → `{ childCount, mcpServers }`.
  The MCP classifier is segment-anchored and rejects mcp-ish files/flags. Surfaced as a
  per-row "N proc · Mmcp" cell (+ MCP names tooltip) in the Monitor via on-demand
  `/api/monitor/processes`. Only counts + sanitized names cross to the client. _Seam:_
  `lib/process-tree.ts`, `lib/session-backend/*` (getPid), `app/api/monitor/processes`,
  `components/views/AgentMonitorView`. _Deferred: a full interactive tree view._
- ✅ **M4 — Orphan-port-per-session attribution** — `feature` · M. **SHIPPED (#327).**
  `lib/listening-ports.ts` snapshots host listening ports (Windows `netstat -ano` /
  POSIX `lsof`, fail-closed); `attributePorts` (lib/process-tree.ts) intersects them with
  each session's process tree (M3) → `{ port, orphan }`, where orphan = not in the
  session's PER-SESSION managed set (its own `dev_server_port` + its project's dev-server
  ports). Surfaced as a per-row "port" cell (amber + ⚠ on an orphan, numbers in a
  tooltip) via the extended `/api/monitor/processes`. Only counts + port numbers cross to
  the client. _Seam:_ `lib/listening-ports.ts`, `lib/process-tree.ts`,
  `app/api/monitor/processes`, `components/views/AgentMonitorView`.
- ✅ **M5 — Telemetry Snapshot schema + JSON export** — `feature` · S.
  **SHIPPED (#328).** `lib/monitor-snapshot.ts` (pure `buildTelemetrySnapshot`) maps the
  Agent-Monitor rows + per-session process/port info (M3/M4) + the rate-limit record (M2)
  into a versioned, snake_case `stoa.monitor.v1` shape aligned to abtop's serde field
  names (`context_percent`, `cache_read_tokens`, `orphan_ports`, `rate_limits`,
  `mcp_servers`, …); `GET /api/monitor?format=json` emits it. The heavy per-session gather
  was extracted to a shared `lib/monitor-collect.ts` (both monitor routes use it). Only
  fields already on the wire (cost/processes) cross — no raw command lines. _Seam:_
  `lib/monitor-snapshot.ts`, `lib/monitor-collect.ts`, `app/api/monitor`.
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
9. ✅ **Inline-reply push notifications** — `mobile` · M. **SHIPPED.** Web push has no
   free-text input affordance, so "reply" ships as a one-tap **Approve** action on the
   lock-screen notification — reusing the existing `/api/sessions/[id]/respond` route (no
   new `/reply` route) → `SessionBackend.sendEnter`. **Opt-in** via `STOA_PUSH_APPROVE=1`
   (OFF by default → notifications stay attention-only), enforced at the push-build AND the
   route. Offered ONLY for a structurally-benign press-Enter-to-continue / `[Y/n]` prompt
   (`continue`); a permission MENU's single-shot "Yes" (`affirmative`) and any
   blanket/destructive/free-text prompt are deliberately withheld — a blind lock-screen tap
   can't show the gated command, so those stay attention-only (swap to the app). The route
   RE-VERIFIES the live prompt before pressing Enter (push→tap TOCTOU) and an in-flight guard
   makes a double-tap 409. _Seam:_ `app/sw.ts` (unchanged), `lib/notification-actions.ts`,
   `lib/session-status.ts`, `lib/auto-steer.ts`, `app/api/sessions/[id]/respond/route.ts`,
   `server.ts`.
10. ✅ **Audit/activity timeline read surface + export** — `adoption` · M. **SHIPPED.**
    A read/export surface over the existing `session_events` ledger (no migration):
    `GET /api/sessions/[id]/events` (per-session) and fleet `GET /api/audit` (optional
    `?session=<id>`, enriched with the human session name), both filterable by
    `types`/`since`/`until` with `limit`/`offset` paging and a `?format=csv|json`
    download. An **Activity** pane view (FLEET_NAV + Quick-switch) filters by time
    window + category, pages the newest events, and exports the filtered set. The SQL
    is built by a PURE, unit-tested core (`lib/audit/query.ts`) — every value a bound
    placeholder, event types validated to the known set; CSV is formula-injection-guarded
    (`lib/audit/csv.ts`). _Seam:_ `lib/audit/{query,csv,response}.ts`, `lib/db/queries.ts`,
    `app/api/audit/route.ts`, `app/api/sessions/[id]/events/route.ts`,
    `components/views/ActivityView`, `data/audit`, `FLEET_NAV`.
11. ✅ **`stoa share` — one-command secure remote access** — `adoption` · M. **SHIPPED.**
    `stoa share` starts a Tailscale funnel (else cloudflared) to the local server,
    appends `?token=`, prints the URL + a terminal QR, and registers the tunnel origin
    in `~/.stoa/shared-origins` (read LIVE per WS upgrade → no restart). **Fail-closed on
    TWO gates**, not just auth-off: it refuses unless (a) auth is on AND (b) the server
    enforces the token for local requests — verified by an unauthenticated `HEAD /` probe
    that must return 401. This closes the real trap — a tunnel reaches the server FROM
    localhost, so a loopback-trusting server (the default) would otherwise be exposed to
    the internet with NO token. All tunnel detection/parsing/decision logic is pure +
    unit-tested (no real binaries); cross-platform binary resolution + spawn.
    _Seam:_ `scripts/stoa.js`, `lib/auth.ts` (`readSharedOrigins`), `server.ts`.
12. ✅ **Prompt-cache-aware launch + cache-hit panel** — `perf` · M. **SHIPPED.**
    Cache-aware launch: a pure `composeLaunchPrompt` (`lib/prompt-compose.ts`) orders the
    initial prompt so the cacheable PREFIX is byte-identical across sibling sessions — the
    worktree/workspace boundary note is SPLIT so its stable, path-free instruction leads
    (still fixing worktree-drift) while the VOLATILE `${worktreePath}`/branch trails as an
    annotation (it used to sit at byte 0, poisoning every prefix). Honest scope: the big
    system-prompt/tools cache is **Claude Code's automatic** caching; this reorder is prefix
    HYGIENE for Stoa's small initial message so a unique path doesn't poison what little
    prefix siblings share. Cache-hit panel: pure `cacheHitRate` + `cacheSavingsUsd`
    (`lib/pricing.ts`) over the cache-read/-write tokens Stoa already parses, surfaced in the
    Agent Monitor — per-session cache % + a fleet total (`cache 84% (saved ~$0.42)`), which
    mostly makes Claude Code's automatic caching VISIBLE. _Seam:_ `lib/prompt-compose.ts`,
    `app/api/sessions/route.ts`, `lib/pricing.ts`, `lib/agent-monitor.ts`,
    `components/views/AgentMonitorView`. (Deferred: an Insight/analytics cache-trend lens —
    needs new token-bucket plumbing through the analytics path.)
13. ✅ **Project Playbooks + auto-recalled Knowledge** — `feature` · M. **SHIPPED.**
    ONE unified `playbooks` table (migration 45): a row is a named prompt snippet used
    two ways — SELECT it as a RECIPE (its body seeds a session's prompt) or set
    `pinned` on a project-scoped one so its body is AUTO-prepended to every session
    there (curated per-project KNOWLEDGE). Composes cache-aware via `composeLaunchPrompt`
    (pinned knowledge + recipe lead the stable prefix; see #12). Pure `lib/playbooks.ts`
    (validate/buildKnowledgeBlock/rowToPlaybook) + server `lib/playbooks-server.ts`
    (`resolvePlaybookParts` — project-scoped, so a foreign recipe id can't pull another
    project's body). `/api/playbooks` CRUD, `data/playbooks` hooks, a compact
    `PlaybookSelector` in NewSessionDialog (load / save-as / pin / delete), and
    Command-Stoa `playbookId` support. _Seam:_ `lib/playbooks.ts`, `lib/playbooks-server.ts`,
    `lib/prompt-compose.ts`, `app/api/playbooks`, `data/playbooks`,
    `components/NewSessionDialog/PlaybookSelector.tsx`, `lib/command/{actions,create-session}.ts`.
    (Deferred: feeding the assisted workflow generator + a richer playbook editor.)
14. ✅ **Reusable warm-environment snapshots (#14a)** — `feature` · M. **SHIPPED.**
    A fresh git worktree ships without `node_modules`, so every fan-out worktree paid a
    cold `npm install` — the biggest fan-out tax, worst on Windows (no copy-on-write).
    `lib/env-snapshot.ts` content-addresses an installed `node_modules` by
    `lockfile-hash + platform + Node-major`, caches it under
    `${STOA_HOME:-~/.stoa}/env-snapshots/<key>/`, and copies it into the next worktree
    with the same deps (skipping install). **FAIL-OPEN by construction:** any miss, copy
    error, or unsupported case (Windows path length, pnpm symlink farm, publish race)
    silently falls back to a normal install — it can only make a launch faster, never
    break one. Atomic temp→rename publish (first-writer-wins), version-led key (a format
    bump orphans old dirs cleanly), LRU prune (8) + stale-temp GC, capture is
    fire-and-forget so it never delays the agent's launch, `fs.cp` with
    `COPYFILE_FICLONE` (reflink on APFS/Btrfs, plain copy on Windows). Opt out with
    `STOA_ENV_SNAPSHOTS=0`. _Seam:_ `lib/env-snapshot.ts`, `lib/env-setup.ts`
    (`setupWorktree` install branch), `docs/setup/README.md`.
    ✅ **#14b: startup commands — SHIPPED.** Per-project commands (build/codegen/
    db-migrate) that run when a new session's worktree is set up, AFTER dependency
    install — warming the worktree beyond `npm install`. Unlike the repo-file
    `.stoa/worktrees.json` `setup[]` (shell strings, run as-authored), these are
    UI-authored + DB-backed and follow the AGENTS.md hard rule: **safe argv exec
    only** — `tokenizeCommand` (rejects shell metacharacters) → `resolveBinary` →
    `.cmd`/`.bat` shims routed via `cmd.exe /c` with shell:false (CVE-2024-27980)
    → `execFile`; env vars (WORKTREE_PATH/PORT) ride the spawn env, never string
    interpolation. Runner (`lib/startup-commands.ts`) is deliberately DB-FREE with
    injectable exec/resolve seams (OS-agnostic tests); a failed step is recorded
    and non-fatal (the rest still run). Table `project_startup_commands`
    (migration 46, CASCADE FK locked by test), CRUD mirroring `project_dev_servers`,
    routes `/api/projects/[id]/startup-commands` (+`[cmdId]`) with tokenize
    validation at save, a "Startup Commands" editor in ProjectSettingsDialog (with
    inline help: plain commands, no pipes/&&/$VARs), and session-create passes the
    project's commands into `setupWorktree`. _Seam:_ `lib/startup-commands.ts`,
    `lib/env-setup.ts`, `lib/projects.ts`, `app/api/projects/[id]/startup-commands`,
    `components/Projects/ProjectSettingsDialog.tsx`.
15. ✅ **Attention-first fleet bar** — `feature` · M. **SHIPPED.** An always-visible
    strip that ranks live sessions by WHO NEEDS YOU NOW. New pure core in
    `lib/session-attention.ts` (`attentionTier`/`attentionRank`/`rankSessionsByAttention`)
    orders blocked > errored > idle-done > running > other — deliberately ranking
    idle-done ABOVE running (the "who needs me" order, the opposite of the htop-style
    `monitorStatusRank`). The strip (`components/FleetBar`) chips only the ACTIONABLE
    tiers (blocked/errored), ranked + clickable-to-focus, and summarizes idle/running
    as trailing counts so it stays attention-focused, not a session dump. It reuses
    `countNeedsAttention` for the "N need you" count (can't drift from the sidebar
    badge) and reads the SAME live `sessionStatuses` (no new polling; React Query
    structural sharing keeps the memo effective). Mounted in both DesktopView + MobileView
    (one thin `h-8` row, minimal terminal cost). v1 keeps it simple — no new DB state
    ("idle-done" = "idle", since a session only goes idle after working). _Seam:_
    `lib/session-attention.ts`, `components/FleetBar/FleetBar.tsx`,
    `components/views/{DesktopView,MobileView}.tsx`.
16. ✅ **iOS push self-healing on launch** — `mobile` · M. **SHIPPED.** iOS silently
    invalidates a PWA's push subscription; the client believed it was subscribed and
    Stoa went quiet forever. Now the user's opt-in INTENT is persisted
    (`stoa-push-intent` in localStorage, backfilled from a live subscription for
    pre-existing subscribers), and on launch + every visibility regain the hook
    compares intent vs reality: intent + permission-granted + subscription GONE →
    silent re-subscribe (no gesture needed while granted); a LIVE subscription →
    throttled idempotent re-POST (repairs the opposite drift — a server that pruned
    the endpoint while the client still holds a valid subscription; throttle marks
    only on SUCCESS so a failed resync retries next focus); no intent / permission
    revoked → never heals. **An explicit opt-out STICKS by construction:** intent is
    TRI-STATE ("out" is written as `0`, never removed, so the backfill — which acts
    only on the never-set state — can't resurrect it from a lingering subscription),
    unsubscribe opts out first then serializes behind any in-flight heal, and a heal
    re-checks intent after subscribing and rolls the fresh subscription back if the
    user opted out mid-flight. Decision logic is a pure matrix (`decideSelfHeal` in
    `lib/push-selfheal.ts`) with storage-injectable intent helpers (fail-closed on
    Safari-private-mode storage errors) — fully unit-tested, no browser needed. Gating on intent+granted is a strict superset of
    the roadmap's "standalone" phrasing (an iOS Safari TAB has no PushManager at all;
    desktop browsers get healed too). Dead-endpoint pruning already ships server-side
    (`sendPushToAll` deletes on 404/410). _Seam:_ `lib/push-selfheal.ts`,
    `hooks/useWebPush.ts`.
17. ✅ **Manifest shortcuts + Web Share Target** — `mobile` · M. **SHIPPED.**
    Long-press the installed icon → app SHORTCUTS (New Session / Fleet Board /
    Ask Stoa / Live Wall), each launching `/?action=<id>`; and the OS share sheet
    can send text/URLs INTO Stoa (`share_target` POSTs title/text/url to
    `/share`, which composes a prompt and 303-redirects into the app shell as
    `/?action=new-session&prompt=…`). The app had ZERO URL handling before — a
    once-only mount reader in HomeContent now parses `?action=` (pure grammar in
    `lib/share-intake.ts`: unknown actions DROP to a plain open; prompts clamped
    to 4k chars) and dispatches to the same handlers the keybindings use, then
    strips the query via history.replaceState so a reload can't re-fire.
    NewSessionDialog gains a `promptSeed` prop (applied on open, cleared on
    close — never clobbers user edits). Stateless by design: the share endpoint
    stores nothing (an unauthenticated share can't write); the redirect lands on
    the normally-authed app page. Platform notes: shortcuts work on
    Android + desktop + iOS 15.1+; `share_target` is Android/ChromeOS/desktop
    (iOS Safari doesn't support receiving shares — its users get the shortcuts +
    Ask Stoa). Images deferred (text/URL is the core loop). _Seam:_
    `public/manifest.json`, `app/share/route.ts`, `lib/share-intake.ts`,
    `app/page.tsx` (mount reader), `components/NewSessionDialog`.
18. ✅ **Transcript cost cache (stat-gated)** — `perf` · M. **SHIPPED.** Every cost
    consumer — the cost route, the budget tick (30s), the cost sampler (60s), the
    auto-compact tick (60s), analytics, and the monitor — funnels through
    `readClaudeSessionUsage`, which previously re-read + re-parsed the same large
    append-only transcript JSONL on every tick (the biggest avoidable steady-state
    CPU/IO). New generic `createStatGatedCache` (`lib/transcript-cache.ts`) memoizes
    the parsed usage keyed by transcript PATH, gated on **mtime AND size** (size
    catches a `/compact` truncation that mtime alone would miss; a hit costs one
    `resolve` + one `stat`, no read/parse), LRU-bounded (512) so a long-lived fleet
    can't grow it without limit. `readClaudeSessionUsage` is wired through it; the
    parse functions stay pure and fork baselines are still applied by the caller
    after (so caching raw parsed usage is safe). `resolveClaudeTranscriptPath` splits
    the path-resolution (+ its traversal guard) out of the reader for the cache key.
    Kill switch `STOA_TRANSCRIPT_CACHE=0` (default on) for an NFS/Tailscale home with
    unreliable mtime. The cache `stat`/`load` seam is injected so it's unit-tested
    with a fake filesystem (append/truncate/mtime invalidation, LRU, null handling).
    _Seam:_ `lib/transcript-cache.ts`, `lib/session-cost.ts`, `lib/claude-transcript.ts`,
    `docs/setup/README.md`.
19. ✅ **Outcome-based verify badge on interactive sessions** — `feature` · L.
    **SHIPPED.** On a "done" claim (a running/waiting→idle turn boundary with no
    real prompt on screen), Stoa actually RUNS the project's verify command in the
    session's worktree and the session card shows a real red/green badge —
    independent of the agent's self-report. Reuses the dispatch verify harness
    wholesale (`runVerify`: no-shell argv steps chained with `&&`, timeout, bounded
    output, never throws) + the same `VERIFY_MAX_CONCURRENT` local-CPU cap. New
    `lib/session-verify.ts`: a pure turn-boundary decision matrix
    (`decideSessionVerify`: done→run, new-turn-starts→CLEAR the stale verdict —
    turn-scoped evidence, a green badge always refers to the tree as the agent left
    it) + a fire-and-forget tick pass hooked into the server status tick. Config:
    `projects.verify_command` (migration 47, edited in ProjectSettingsDialog,
    validated with `parseVerifySteps` at PATCH — no shell ever). Opt-in by
    construction: no command → no badge, zero cost. Verdict rides the existing
    status poll (`/api/sessions/status`) into a SessionCard badge (pass=green,
    fail=red w/ output-head tooltip, error=amber, running=spinner). _Seam:_
    `lib/session-verify.ts`, `server.ts` tick, `lib/db` migration 47,
    `app/api/projects/[id]`, `app/api/sessions/status`, `components/SessionCard.tsx`,
    `components/Projects/ProjectSettingsDialog.tsx`.
20. ✅ **Cost-aware model routing + cascade escalation** — `orchestration` · L.
    **SHIPPED (v1).** Two deterministic levers, no speculative classifier:
    **(1) Routing:** a dispatch repo can pin its workers to an economical catalog
    model (`dispatch_repos.default_model`, migration 48 — a "worker model" field in
    the Allocation Console, strictly validated at PATCH: `isSafeModel` + must be a
    catalog member for static agents). The initial worker, the review panel (all 3
    critics — same-tier invariant), and merge-train fixers all run the repo base.
    **(2) Cascade escalation:** when a fix round FAILED and a new fixer spawns
    (review fixer via `fix_rounds`, CI fixer via `ci_fix_rounds`), the new fixer
    runs ONE tier above the base — `modelForFixRound(agent, base, round)`: round 1
    → base, round ≥2 → base+1 tier. Purely derived from the round number:
    deterministic, no history column, re-spawns can't compound the climb. New pure
    `lib/model-router.ts` (`MODEL_TIER_LADDER` = claude: haiku→sonnet→opus, dated
    variants tier-matched; Codex deferred — its mini/spark variants lack a clean
    ladder; free-text agents are NEVER escalated — their model rides verbatim into
    the launch). Every routed value re-clamps through `resolveModelForAgent` at
    spawn (`WorktreeSpawnTarget.model`), so nothing un-vetted reaches `tmux -m`.
    v2 deferred: task-difficulty classifier + cost-signal feedback. _Seam:_
    `lib/model-router.ts`, `lib/dispatch/{dispatcher,reviewer,ci-fix}.ts`,
    migration 48, `app/api/dispatch/repos/[id]`, AllocationConsole.
21. ✅ **Per-session cost budgets with alert + opt-in auto-pause** — `adoption` · M.
    **SHIPPED (v1: lifetime cap).** A session may carry a lifetime USD budget
    (`sessions.budget_usd`, migration 49; set in the New Session dialog's advanced
    settings). A dedicated 30s tick computes live costs for budgeted sessions and
    runs pure edge-triggered stage detection (`lib/budget-park.ts`): crossing 80%
    → ONE push alert; crossing 100% → ONE push alert — and, with
    `STOA_BUDGET_PARK=1` (opt-in, default OFF), the session is PARKED: passive
    fail-closed, Stoa stops FEEDING it work (prompt queue, rate-limit auto-resume,
    channel delivery all skip it) but nothing is killed and the user can still
    type. Unpark = raise/clear the budget (the tick clears the park below cap).
    Distinct from the GLOBAL `STOA_BUDGET_HARD_USD` kill. SessionCard shows a
    stage badge (amber 80% / red cap / "parked") via the status route. v2
    deferred: daily/monthly windows (cost-history already keeps per-day data).
    _Seam:_ `lib/budget-park.ts`, migration 49, `server.ts` tick + 3 park skips,
    `app/api/sessions` (+`/status`), AdvancedSettings, SessionCard.
22. ✅ **`computeSessionCosts` direct test (budget-kill path)** — `test` · M.
    **SHIPPED.** Direct contract tests over the mocked transcript boundary
    (`test/session-cost.test.ts`): supported:false short-circuits never touch
    the reader (no reader / no transcript id / no cwd), unreadable transcript =
    best-effort zero, unpriced model = tokens with costUsd null, an entry for
    EVERY input session, and the 12-wide concurrency cap (in-flight peak
    tracked across a 30-session fleet). Plus `test/session-cost-route.test.ts`:
    GET /api/sessions/cost against a real in-memory DB — 200 on empty fleet /
    mixed fleet / garbage transcripts, budget-level mapping, and a catastrophic
    DB failure returning a clean 500 JSON error (never an unhandled crash).
23. ✅ **Clickable `file:line` jump-to-error in terminal** — `feature` · M.
    **SHIPPED.** A custom xterm link provider (registered in `terminal-init.ts`,
    disposed on cleanup) over a PURE extractor (`lib/terminal-links.ts`, client-
    safe): colon form `path.ext:12[:col]` and paren form `path.ext(12[,5])`,
    Windows drive / POSIX / `./`+`.\` relative paths, conservative by design
    (extension required; URLs, timestamps, versions, mid-token latches all
    rejected — 28-case matrix in `test/terminal-links.test.ts`). Desktop click
    → `fileOpenActions.requestOpen(resolved, line)` → the Files view opens the
    file AND scrolls/selects the line (CodeMirror `scrollIntoView` via a new
    `jumpToLine` prop — this also closed the pre-existing Pane TODO, so Quick
    Switcher code search now lands on its line too). Mobile tap inserts the
    reference into the agent prompt (same path as the 📎 picker). Relative
    paths resolve against the session cwd client-side; the files/content route
    still sandbox-validates server-side. Guide card added.
24. ✅ **@-mention file autocomplete in the send bar** — `feature` · M.
    **SHIPPED.** Typing `@` in the Compose/Queue send bar (PromptQueueModal —
    the LIVE send surface; `MessageInput.tsx` is a legacy path not mounted by
    the pane) opens an inline dropdown over the session cwd's file tree: pure
    detection/rank/replace in `lib/mention-files.ts` (mid-word `@` like emails
    and `foo@1.2` never triggers; name matches weighted 2× over path matches
    via the shared `fuzzyScore`; picks insert the RELATIVE forward-slashed
    path, quoted when it has spaces), React glue in
    `components/FileMentions.tsx` (useFileMentions hook + dropdown; ↑/↓ /
    Enter / Tab / Escape, Escape scoped so it closes the dropdown not the
    modal, mousedown-pick so blur can't eat the click). The file index is the
    picker's bounded `useRecursiveFilesQuery` (depth 4, sandbox-validated
    server-side), fetched only while a mention is open. Discoverable via the
    placeholder ("@ mentions a file"). 19-case pure matrix in
    `test/mention-files.test.ts`.
25. ✅ **Compaction control + external-memory injection** — `orchestration` · M.
    **SHIPPED** (trigger #329; external-memory half here). Three opt-in pieces
    around the auto-/compact trigger (`lib/compact-memory.ts`, pure +
    unit-tested; wiring in the server tick):
    1. **Custom compaction prompt** — `STOA_AUTO_COMPACT_PROMPT` is sanitized
       to one line (control bytes stripped, 400-char cap) and appended to
       `/compact` to steer what the summary preserves; empty keeps the bare
       command byte-identical.
    2. **PreCompact flush** (`STOA_COMPACT_MEMORY=1`; requires
       `STOA_AUTO_COMPACT=1` — the whole tick is gated on the trigger, and
       startup warns when set alone) — just before /compact,
       the recent conversation tail (deterministic `extractTranscriptEntries`,
       tail-biased 24k cap, sanitized) is written to `.stoa/compact-memory.md`
       in the session cwd, so the detail compaction drops survives on disk.
       A flush failure logs and never blocks the compaction.
    3. **PostCompact re-inject** — one-shot pointer pasted at the next
       idle-AND-no-prompt boundary AFTER the live context occupancy fell back
       under the threshold (the transcript itself is the completion signal),
       with a 2-min settle delay and 30-min expiry; budget-parked sessions are
       skipped (#21). A session pending its pointer never starts another
       compaction in the same tick.
       v2 ideas: agent-driven flush (ask the model to write its own TODO state)
       and NOTES-table integration. _Seam:_ `lib/compact-memory.ts`,
       `lib/auto-compact.ts` (#329), `server.ts` tick, `lib/summarize.ts` helpers.
26. ✅ **LLM-as-judge rubric review gate** — `orchestration` · M. **SHIPPED.**
    Opt-in per repo (`dispatch_repos.judge_gate`, migration 50; "judge" toggle
    in the Allocation Console): the reconciler runs a BINARY rubric judge over
    each open PR's diff — tests added? no secret left? matches AGENTS.md
    conventions? no injection shape? — alongside the critic panel + verify
    harness, and gates auto-merge on a pass. Mirrors verify.ts's anatomy
    (`lib/dispatch/judge.ts`): SHA-pinned verdict trio
    (judge_status/output/sha), once per head, fire-and-forget off the tick,
    stale verdicts cleared on head moves, crash recovery for wedged 'running'
    rows, concurrency-capped. The diff is read via `gh pr diff` (argv, no
    shell) from the stable checkout, bounded (60k head-biased + truncation
    note), and fed to `runClaudeOneshot` with the diff EXPLICITLY marked
    untrusted (instructions inside it are data). The parser is FAIL-CLOSED:
    only a well-formed, internally consistent PASS (all four checks true)
    passes; an inconsistent PASS is a fail; unparseable output is an 'error'
    that waits visibly in the Verdict Inbox — never a silent merge. The
    auto-merge gate is ADDITIVE (like verify) and the merge pin chain is
    review_sha ?? verify_sha ?? judge_sha ?? head. _Why:_ the safeguard that
    makes cheap-model routing (#20) safe. _Seam:_ `lib/dispatch/judge.ts`,
    migration 50, `auto-merge.ts`, `reconciler.ts`, `verdict-inbox.ts`,
    AllocationConsole, repos PATCH route.
27. **OS-level sandbox launch tier (replace all-or-nothing yolo)** — `security` · L.
    Tri-state Prompt/Sandboxed-auto/Full-bypass; wrap the agent in FS+net isolation
    (Seatbelt/bubblewrap/restricted-worktree+proxy). _Why:_ workers run with full
    host access today — the biggest blast radius for unattended fleets. _Seam:_ new
    `lib/sandbox/`, `lib/providers/registry.ts`, `lib/orchestration.ts`.
28. **Embedded live app preview with click-to-comment** — `feature` · L. An iframe
    over the worktree dev-server URL with a device selector + element-picker that
    turns a note into a structured message to the worker. _Seam:_ new PreviewPanel,
    `lib/dev-servers.ts`, `lib/diff-comment.ts`.
29. ✅ **Terminal gestures (cursor-drag, double-tap, pinch)** — `mobile` · L.
    **SHIPPED.** A pure gesture state machine
    (`components/Terminal/hooks/useTerminalGestures.ts`: detectGesture /
    dragToArrowKeys / pinchToFontSize + a `gestureStep` reducer over {x,y,t}
    samples — 47-test matrix, no DOM simulation) with a thin hook wiring:
    LONG-PRESS(400ms)+DRAG moves the cursor via arrow-key sequences (one per
    cell, diagonal dominance, sub-cell remainder carried, runaway cap),
    DOUBLE-TAP sends Tab, PINCH sets the font size clamped 8–24px (refresh +
    resize, mirroring updateTerminalForMobile). Escape sequences built via
    `String.fromCharCode(27)` (no literal control bytes). Touch-scroll safety:
    capture-phase listeners + `TAP_SLOP_PX` (8) matched to touch-scroll's 8px
    direction threshold (invariant documented in both files) — plain scrolling
    and select mode untouched; gated `isMobile && !selectMode`. Guide card
    added. _Deferred:_ swipe-to-switch-session (needs pane-level wiring; would
    collide with horizontal touch-scroll), pinch-size persistence across the
    mobile/desktop breakpoint.
30. ✅ **First-run onboarding wizard** — `adoption` · M. **SHIPPED.** A 5-step
    checklist on the empty state (`components/OnboardingChecklist.tsx`, mounted
    in Desktop+Mobile views behind `sessions.length === 0`): install an agent
    CLI → sign in → pick a working directory → open-from-your-phone hint →
    create the first session (the CTA drives the SAME NewSessionDialog handler
    the header uses; steps 3+5 resolve through that dialog's own directory
    picker). Server side: `stoa doctor`'s checks live in a non-importable CJS
    script, so a minimal equivalent ships as `lib/readiness-server.ts`
    (resolveBinary probes for claude/codex/hermes/kilo/kimi + gh, best-effort
    sign-in evidence at the known credential paths — all dependency-injected
    for tests) behind `GET /api/readiness`; the PURE step logic lives in
    client-safe `lib/readiness.ts` (the established client/server split).
    Auth step requires BOTH a found CLI and auth evidence (a stale
    ~/.claude.json can't read as signed-in). Dismissible (localStorage), never
    nags. 18-test payload→steps matrix.
31. **Refactor `server.ts` tick into a write-arbiter orchestrator** — `tech-debt` · L.
    A `TickContext` + ordered pure "tick actors" each exposing `decide()` with one
    shared `claimWrite()` arbiter, so "one write per session per tick" is structural,
    not per-pair predicates. _Why:_ the 460-line mega-loop with 9 cross-coupled maps
    is the highest-risk, least-testable module (already a source of composition bugs).
    _Seam:_ `server.ts`, `lib/tick-guards.ts`, new `lib/status-tick.ts`.
32. ✅ **Single `buildAgentArgsForSession` chokepoint** — `tech-debt` · M.
    **SHIPPED.** New `lib/session-launch.ts` is the ONE place a Session becomes
    launch options: `resolveSessionLaunchOptions(session, opts)` does the shell
    short-circuit, the `resolveModelForAgent` STATIC-CATALOG model clamp (the
    injection defense — an untrusted/free-text model is dropped to the safe
    default, NOT `isSupportedModelForAgent`), the MCP-arg parse, and native-fork
    parent resolution; `buildAgentArgsForSession` feeds those clamped options to
    `buildAgentArgs`. The two independent Session-shaped builders — the pty
    re-attach (`lib/client/backend.ts`) and first-launch (`app/page.tsx`, which
    now feeds the SAME clamped options to both the tmux `buildFlags` and the pty
    path so they can't diverge) — route through it, so the clamp is
    non-bypassable. Pure refactor, argv byte-identical. 17 tests prove the clamp
    fires on every caller path (an injection-shaped model never reaches
    `--model`) + argv equivalence. _Seam:_ `lib/session-launch.ts`,
    `lib/client/backend.ts`, `app/page.tsx`.

### Tier 2 — Medium impact (ranks 33–49)

33. ✅ **Customizable snippet/quick-command chips + template variables** —
    `mobile` · M. **SHIPPED.** One-tap snippet chips above the mobile toolbar
    (`SnippetChipBar`, hidden when no snippets) + `{{placeholder}}` fill-in
    (`SnippetFillInDialog`, shared by the chips and both SnippetsModal
    surfaces). Pure template core in new `lib/snippets.ts`
    (extract/substitute/build — single-pass, `$`-inert, own-properties-only,
    null-prototype map so `{{__proto__}}`/`{{toString}}` can't pollute), every
    insert sanitized via `formatTerminalTextForAgent`, and ALL mobile snippet
    inserts route through xterm's bracketed paste (one paste, never
    char-by-char — a multi-line snippet must not auto-execute per newline;
    parity with the desktop Pane path). Surfaces sync via
    `SNIPPETS_CHANGED_EVENT`. _Seam:_ `lib/snippets.ts`,
    `components/Terminal/SnippetChipBar.tsx`, `SnippetFillInDialog.tsx`,
    `SnippetsModal.tsx`, `TerminalToolbar.tsx`.
34. ✅ **Issue-tracker intake beyond GitHub (Linear)** — `feature` · M.
    **SHIPPED (Jira deferred).** The Dispatch issue source is generalized behind
    an `IssueSource` interface (`lib/dispatch/issue-source.ts`:
    `listEligible`/`listOpen` → a normalized `EligibleIssue[]`, degrade-to-`[]`
    on failure). GitHub becomes one adapter (`github-source.ts`, delegating to
    the untouched `issues.ts` gh functions — byte-identical argv + contract);
    a new `LinearIssueSource` (`linear.ts`) runs Linear's GraphQL over an
    injectable transport (real impl fetch-over-HTTPS, AbortController timeout,
    `LINEAR_API_KEY`), with STRUCTURED filter objects so a hostile label rides
    as a `{eq}` value never as query text, and every failure degrades to `[]`.
    Source is picked by repo slug — plain `owner/name` → GitHub (default),
    `linear:TEAM` → Linear — so NO schema/migration was needed;
    `resolveIssueSource` wires kind→impl. **SCOPE (per review): Linear repos are
    INTAKE/BROWSE-ONLY** — the dispatch→PR loop downstream (`gh issue view`,
    PR-linking) is still GitHub-hardcoded, so `dispatchSupported()` gates EVERY
    gh-touching path to github: auto-dispatch (reconciler), all 3 manual dispatch
    routes, issue CREATE (before `gh issue create`), and the PLANNER (plan-spawn
    - approve routes + the PlanConsole picker). A Linear slug's issues are
      ingested + browsable (search/Dispatch controls disabled) but never handed to
      the gh-only worker. A `jira:` slug is rejected at add-repo (400) rather than
      silently falling back to gh; the UI renders a non-github slug as plain text
      (no broken `github.com/linear:…` link). GitHub Dispatch flows are
      byte-identical. 31 issue-source/route tests (create + plan gh-never-spawned
      regressions). _Seam:_ `lib/dispatch/issue-source.ts`, `github-source.ts`,
      `linear.ts`, `sources.ts`, `reconciler.ts`, the create/dispatch/plan/add-repo
      routes, the DispatchView renderers + PlanConsole/OpenIssuesBrowser,
      `.env.example`. _Deferred:_ Jira; the Linear dispatch→PR loop (source-aware
      `buildIssuePrompt` + PR-linking); Linear free-text browse search; a
      DispatchHelp Linear section; skipping the github-flavored maintainer survey
      for a non-github repo (harmless today — it runs a bare `gh issue list` in
      the worktree, never `gh --repo linear:…`, and its proposals are fenced out
      of auto-dispatch).
35. ✅ **Reusable scoped subagent library** — `orchestration` · M. **SHIPPED
    (library + role mapping + one-click install; Claude-only).** New
    `lib/subagents.ts`:
    `SubagentDef {name, description, tools[] allowlist, model?, systemPrompt?}` +
    a pure serializer to Claude Code's VERIFIED `~/.claude/agents/<name>/AGENT.md`
    YAML-frontmatter format (confirmed against the real `code-reviewer/AGENT.md`,
    not guessed), with the same hardening as `lib/skills.ts` (name/tool/model
    charset guards so a hostile token can't forge a second frontmatter key or
    traverse paths; empty tools ⇒ inherit-all). Materialization behind an
    injectable `SubagentFs` seam; `roleToSubagentDef` maps a workflow role
    (ADDITIVE — no existing behavior changed) to a scoped def (read-only roles
    get Read/Grep/Glob, write roles add Edit/Write/Bash), with subagent-owned
    description + persona strings kept independent of the generator's
    `ROLE_GUIDANCE`. Wired end-to-end: `POST /api/subagents { provider }`
    bulk-installs every role non-destructively (existing hand-authored files
    left untouched) and returns `{written, skipped, dir}`; a one-click "Install
    roles" affordance in the Commands dialog invokes it and names the
    destination. Registry gains an optional `agentsDir` (Claude only — other
    providers' native formats unverified). Unit-tested (serializer hardening,
    role mapping, the clobber guard, and a description-cap guard so a future
    guidance edit can't silently break install). _Deferred:_ wiring non-Claude
    providers once their subagent format is verified. _Seam:_
    `lib/subagents.ts`, `app/api/subagents/route.ts`,
    `components/Commands/CommandsDialog.tsx`, `lib/providers/registry.ts`.
36. ✅ **Secrets guard at session creation** — `security` · S. **SHIPPED (warn
    half).** Pure name-only matcher `lib/secret-scan.ts`
    (`SECRET_FILE_PATTERNS` + `classifySecretFiles` — .env/.env.*, *.pem,
    id_rsa/id_ed25519, credentials.json, .npmrc; case-insensitive, sorted,
    capped 10; `.envrc` deliberately excluded — direnv code, not a dotenv,
    documented + test-locked) behind `GET /api/secret-scan?path=` (ONE shallow
    readdir, names only, never file contents; sandboxed via
    resolveSandboxedPathOrHome mirroring the sibling /api/git/check the same
    dialog fires — strict resolveSandboxedPath would 403 every not-yet-
    registered dir a user browses to). WorkingDirectoryInput shows a debounced
    amber warning ("agents launched here can read these files") — advisory,
    never blocks. 28-test matrix + db-holder route tests. _Deferred:_ the
    one-click deny rule (needs provider-level settings work).
37. ✅ **Undo toast for destructive actions** — `feature` · S. **SHIPPED.** A
    delay+cancel wrapper (`lib/undoable-action.ts`: `createUndoableRunner` —
    schedule/cancel/flush, idempotent, same-id reschedule flushes the
    predecessor so no delete is ever lost; fake-timer test matrix) wired to
    session delete (`useSessionListMutations`), Notes delete, and Snippets
    delete — each shows a sonner "Deleted X — Undo" toast for the grace window
    before the destructive call actually fires. _Deferred:_ Git discard (call
    site entangled), "restart that session" pseudo-undo.
38. ✅ **Recents + pinned in the Quick Switcher** — `feature` · S. **SHIPPED.**
    Pure, storage-injected `lib/palette-recents.ts` (mirrors prompt-history):
    MRU recents (capped 20, deduped), pin toggle, and `rankWithRecents` whose
    contract is explicit — pins/recents only reorder the EMPTY-query default
    list (pinned → MRU → rest); with an active query fuzzyScore stays king
    (an order-preserving no-op over searchSessions output). Malformed stored
    JSON degrades to empty; storage failures swallowed. QuickSwitcher records
    on select (click + Enter + Output mode), renders a pin toggle per row
    (visible on hover/highlight/pinned). 21-test matrix.
39. ✅ **Screen Wake Lock while watching a live run** — `mobile` · S.
    **SHIPPED.** `hooks/useWakeLock.ts`: pure `decideWakeLock({active, visible,
hasLock})` → acquire|release|hold + an injectable `createWakeLockController`
    (serialized request/release queue that never interleaves or wedges,
    latest-wins desired state, a sentinel `release` listener so a UA auto-
    release on tab-hide/battery-saver re-acquires on the next sync, every
    error swallowed) driving a thin `useWakeLock(active)` hook (visibilitychange
    re-acquire, SSR-guarded, feature-detected — absent API = silent no-op).
    Wired one call each: Terminal (`connectionState === "connected"`) + Live
    Wall (while mounted). 25-test matrix (8-combo decision + controller
    transitions + hook wiring). _Deferred:_ per-status gating (hold only while
    "running"), isMobile gating (harmless on desktop).
40. ✅ **Copy command+output as Markdown** — `feature` · S. **SHIPPED.** Pure
    `lib/markdown-block.ts` `toMarkdownBlock(text, lang?)`: strips complete
    ANSI sequences (OSC/CSI/short escapes — regexes built via
    `String.fromCharCode`, no literal control bytes) then reuses
    `formatTerminalTextForAgent` for the C0/DEL strip; CRLF normalization;
    picks a fence LONGER than any backtick run in the body (a body containing
    ```can't close the block early); sanitized lang token; "" for
    empty/control-only input. A "Copy as Markdown" button rides next to the
    select-mode Copy in the mobile toolbar, reading the same DOM selection.
    12-test matrix (fence escalation, hostile ANSI/C0, CRLF, lang tag).
    _Follow-up noted:_ the desktop select-mode header could gain the same
    action.
    ```
41. ✅ **Pull-to-refresh + tap haptics** — `mobile` · S. **SHIPPED.** New
    `hooks/useHaptics.ts` (pure `hapticPattern(kind)` + SSR-safe
    feature-detected `navigator.vibrate` wrapper that swallows throwing
    engines) wired at the mobile send/approve/kill/copy call sites
    (`MessageInput`, `TerminalToolbar` Enter+copy, `SessionQuickActions`) —
    each a no-op on desktop where vibrate is unsupported. Pull-to-refresh
    (`hooks/usePullToRefresh.ts`) is a pure `pullReducer` that arms only when
    the drag STARTS at `scrollTop 0`, applies elastic resistance, fires once
    on the arm→release edge, and reuses the list's existing refresh; it is
    cooperative (never `preventDefault`s, so it doesn't fight touch-scroll)
    and gated `isMobile`, reading the Radix viewport via a new optional
    `viewportRef`. 30 tests (26 pure + 4 rendered-hook). _Seam:_
    `hooks/useHaptics.ts`,
    `hooks/usePullToRefresh.ts`, `components/SessionList/*`.
42. ✅ **Single-pass transcript parse** — `perf` · S. **SHIPPED.** New
    `parseClaudeTranscriptUsage(jsonl)` walks the JSONL ONCE returning
    `{tokens, contextTokens}`; `parseClaudeUsage`/`parseClaudeContextTokens`
    remain as thin wrappers (exports + exact semantics LOCKED by the existing
    suite — separate message-id dedupe sets preserved, so a main-thread turn
    reusing a sidechain turn's id still sets the context reading while staying
    deduped from the cumulative total); `loadClaudeUsage` (the #18 cache's
    load step) now calls the core once. Equivalence + exact-merged-value +
    divergent-dedupe + delegation-shape tests added; no existing assertion
    weakened. Behavior byte-identical (this feeds the budget-kill loop).
43. ✅ **StoaGuide in-app docs drift fix** — `docs` · S. **SHIPPED.** Four new
    Guide cards — Quick Switcher, Multi-repo workspace, Best of N, Ask Stoa —
    each fact-checked against the shipped implementation, plus the two README
    bullets that were missing (Quick Switcher, Best of N). Purely
    presentational (no logic, no tests needed). _Seam:_
    `components/StoaGuide.tsx`, `README.md`.
44. **Checkpoint / time-travel / fork-from-any-point** — `feature` · L. A persisted
    checkpoint timeline (worktree state + transcript point) with rewind + "fork from
    here"; watchdog auto-rewinds wedged workers. _Seam:_ `lib/snapshots.ts`,
    `lib/fork.ts`, `lib/db/migrations.ts`, `lib/fleet-board`, `lib/watchdog.ts`.
45. ✅ **OpenTelemetry GenAI trace export** — `orchestration` · M. **SHIPPED.**
    A dependency-light OTLP/HTTP-JSON exporter in new `lib/telemetry/otel.ts`
    that is a hard NO-OP unless `STOA_OTEL_ENDPOINT` is set (guarded up front —
    zero overhead, nothing loaded when unset). Pure span-builder helpers emit
    GenAI-semantic-convention spans (`gen_ai.system`/operation/request.model/
    usage tokens; timestamps injected, not `Date.now`) for the run (spawnWorker)
    and tool (MCP CallTool) boundaries; emit failures are swallowed (never throw
    into a run) with a warn-once diagnostic. Hardened per review: the endpoint
    FAILS CLOSED (validated http(s) URL, else off + warn — no SSRF/fetch-to-
    garbage), the fetch is bounded (5s AbortSignal timeout + a 64 in-flight cap
    so a black-hole collector can't pin sockets under load), CSPRNG span ids,
    and clamped timestamps. Documented in `.env.example` (STOA_OTEL_ENDPOINT +
    STOA_OTEL_HEADERS). 26-test pure suite. _Deferred:_ cross-process
    parent/child span linking + per-turn/model hooks in the pipeline executor.
    _Seam:_ `lib/telemetry/otel.ts`, `lib/orchestration.ts`,
    `mcp/orchestration-server.ts`, `.env.example`.
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

50. ✅ 🐛 **Channel push double-deliver race + orphan cleanup + DISTINCT scan** —
    `bug` · M. **SHIPPED (verify-then-fix).** The opt-in push
    (`STOA_AUTO_CHANNEL_DELIVER=1`) picked the oldest unread with a
    NON-consuming SELECT, PASTED it, then marked delivered — so two concurrent
    delivery attempts off one snapshot both pasted (double-deliver, reproduced
    first). Fix: `claimDelivery(id)` — one atomic claiming UPDATE guarded on the
    row still being pending, using `changes===1` as the claim; only the winner
    pastes, and a failed paste calls `resetDelivery(id)` to un-claim so the next
    tick re-delivers (at-least-once preserved without reopening the race).
    Orphan cleanup: schema has NO FK on `channel_messages` /
    `schedules.session_id` (a test PROVES this), so session delete now
    explicitly removes both (session + each worker). The per-session tick probe
    is replaced by one `SELECT DISTINCT` over the recipients with unread
    messages, intersected with the live snapshot. 15 tests (regression fails
    pre-fix). _Seam:_ `server.ts`, `lib/channels.ts`, `lib/db/queries.ts`,
    `app/api/sessions/[id]/route.ts`, `lib/scheduler.ts`.
51. ✅ 🐛 **Resolve rate-limit vs error classification** — `bug` · M.
    **SHIPPED (verify-then-fix).** Reproduced end-to-end first: a screen with
    BOTH error wording ("API Error: 429 … rate_limit_error") AND a reset time
    tripped `ERROR_PATTERNS` → status 'error' → the auto-resume loop hard-
    skips errored sessions → never resumed. Two minimal changes in
    `lib/status-detector.ts` (lib/rate-limit.ts needed none — its
    LIMIT_PATTERNS already parsed the reset): (1) precedence — an error-
    pattern hit with a detected limit carrying a non-null resetAt falls
    through to waiting/idle (no reset → still error); (2) ERROR_PATTERNS
    tightened from `(quota|rate limit) (exceeded|exhausted)` to quota-only.
    Deliberate behavior change: bare rate-limit wording with NO reset now
    classifies waiting + surfaced rateLimit (resumable via the opt-in
    fallback window) instead of error; bare "quota exceeded" REMAINS error
    (credit exhaustion isn't countdown-able). TDD-locked: the regression
    fixture failed before the fix; 157 tests across 12 suites green.
52. ✅ **Notification grouping + quiet hours + per-session mute** — `mobile` · M.
    **SHIPPED.** All four gates apply PER-DEVICE in the service worker (the
    server fans push to every device and can't know a device's local prefs).
    New pure `lib/notification-policy.ts`: `isQuietTime` (minutes-since-midnight,
    correctly wraps midnight, blanket-DND default OFF), `notificationTag` (needs-you
    kinds share a per-session tag so a newer prompt REPLACES the older banner;
    "done" gets its OWN tag so a silent completion can't dismiss an unanswered
    needs-you banner), `isSilentKind`/`shouldRenotify`, and `decideNotify(...)`
    with precedence test > mute > quiet-hours > show. Because the SW can't read
    localStorage, `lib/notification-policy-idb.ts` mirrors the policy into
    IndexedDB (reads fail LOUD → a needs-you push is never silently swallowed;
    a write retries once and returns success so a stale-after-unmute mirror is
    surfaced; `coercePolicy` guards hostile blobs). The two writers of the
    shared settings key (Bell menu + per-session mute) converge via
    `SETTINGS_CHANGED_EVENT` and merge-onto-fresh-read so neither clobbers the
    other. StoaGuide card added. `PushPayload` gains `kind`. 46 tests. _Seam:_
    `lib/notification-policy.ts`, `lib/notification-policy-idb.ts`, `app/sw.ts`,
    `server.ts`, `lib/notifications.ts`, `hooks/useNotifications.ts`,
    `hooks/useSessionMute.ts`, `components/NotificationSettings.tsx`,
    `components/SessionCard.tsx`.
53. **Jump-between-commands + sticky command header** — `feature` · L. Prompt-boundary
    navigation over the captured VT buffer (the Warp-blocks 80%, no OSC needed).
    _Seam:_ `components/Terminal/index.tsx`, new `lib/terminal-blocks.ts`,
    `lib/keybindings.ts`.
54. **Split `lib/db/queries.ts` into domain modules** — `tech-debt` · L. Split the
    194-builder god-object into domain files re-composed in an index (zero call-site
    churn); type the prepared-statement wrappers to drop `as Row[]` casts. _Why:_ a
    constant merge-conflict magnet; untyped casts feed the budget kill loop. _Seam:_
    `lib/db/queries.ts`, `lib/db/index.ts`.
55. ✅ **Centralize `STOA_AUTO_*` flags + guarded-interval helper** — `tech-debt` ·
    M. **SHIPPED (pure refactor).** New `lib/auto-features.ts`: one typed
    `getAutoFeatures()` snapshot of the parsed `STOA_AUTO_*` booleans (delegating
    to each feature's own `*Enabled()` helper so it can't drift), plus
    `anyTickEnabled()`, `describeEnabled()` (a human startup-log summary), and
    `makeGuardedInterval({ intervalMs, enabled, tick, unref, runAtStartup })`
    wrapping `setInterval` with the re-entrancy busy-guard + `.unref()` the six
    `server.ts` timers hand-rolled. The timers (budget enforcement, budget-park,
    dispatch reconciler, scheduler, cost sampler, auto-compact) move onto the
    helper with IDENTICAL cadences/guards/enable conditions (always-armed
    budget-enforcement keeps `unref:false`; budget-park keeps its immediate
    `runAtStartup`; the status ticker stays inline). No auto-feature semantics
    change. Unit-tested. _Seam:_ `server.ts`, new `lib/auto-features.ts`.
56. ✅ **Pin install/update to a verified release tag** — `adoption` · M.
    **SHIPPED (opt-in/guarded).** A `release` update channel that pins the
    checkout to the latest verified, immutable release TAG instead of `main`'s
    HEAD. The DEFAULT stays `main` (byte-identical git commands, today's
    behavior) — `release` is never the default, so this is a pure trust-boundary
    opt-in. `stoa update` resolves the channel `--channel <main|release>` >
    `STOA_UPDATE_CHANNEL` env > default `main`; on `release` it lists remote
    tags via `git ls-remote --tags` (execFile, no shell pipes), picks the
    highest semver via pure tested helpers (rejecting injection-shaped refs),
    and checks it out detached; unknown channel / no-tag / unreachable remote
    all fail LOUD rather than silently tracking main. `install.sh`/`install.ps1`
    take a matching `--channel`/`-Channel`/`STOA_CHANNEL`, default unchanged,
    symmetric across platforms. Checksum/signature verify deferred (tags ride
    git's authenticated transport). 41 pure tests (incl. an installer↔updater
    regex-parity lock read from the real scripts); scripts re-pinned. _Seam:_
    `scripts/stoa.js`, `scripts/install.sh`, `scripts/install.ps1`.
57. ✅ **Extract `WorkflowBuilder` into hooks + sibling components** —
    `tech-debt` · L. **SHIPPED.** The ~1800-line component is decomposed to ~850:
    three hooks — `useWorkflowDoc` (doc state + selection-coupled mutations,
    composing the existing `useBuilderHistory` undo/redo reducer),
    `useCanvasSelection` (node/edge selection), `useWorkflowPersistence`
    (load/save/saved-workflows store) — plus sibling components `WorkflowToolbar`,
    `WorkflowInspector`, `WorkflowDesignPanel`, `WorkflowCollapsibleSection`, and
    pure `builder-helpers.ts`. NO behavior change (byte-identical render/DAG/
    engine/store); a handful of DOM-orchestration handlers (export/import/fit/
    copy-JSON) stayed in the shell by design. 4 new tests for the extracted pure
    hook logic. _Seam:_ `components/views/WorkflowsView/*`, `hooks/useWorkflow*`,
    `hooks/useCanvasSelection.ts`.

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
- **Multi-repo delete safety** — the session-delete dialog should warn when a
  workspace's worktrees hold uncommitted/unpushed work, and `removeWorkspace`
  failures (best-effort, background via `runInBackground`) should surface
  instead of only logging — orphaned worktrees are invisible today (#43
  red-team).
- **Snippet-store undo-window edges (pre-existing, #33 round-3)** — three small
  SnippetsModal gaps around the #37 undo window, all verified pre-existing on
  main: (1) `handleAdd` persists from the modal's OPTIMISTIC list, committing a
  still-pending delete early so its Undo silently restores nothing — base the
  add on storage + re-sync via `getVisibleSnippets`, with a two-pending-actions
  regression test; (2) a second OPEN modal (desktop split-pane) goes stale —
  subscribe it to `SNIPPETS_CHANGED_EVENT` like the chip bar; (3) the useState
  initializer reads raw storage (one-frame flash in a contrived remount) — use
  `getVisibleSnippets()` there too.
- **Notification follow-ups (#52 review)** — (1) a MUTED session's budget-hit
  ("out of money", `kind:"error"` with the `budget-*` tag) is currently
  suppressed by the per-session mute; decide whether a terminal budget alert
  should pierce mute (exempt the budget tag) or stay silenced (document it).
  (2) `lib/notification-policy-idb.ts` opens the DB per call; cache a
  module-level `dbPromise` like `lib/offline-queue-idb.ts` if push volume ever
  makes the extra `open` matter. (3) An optional "allow urgent (waiting/error)
  during quiet hours" toggle, if blanket DND proves too aggressive. (4) Prune
  `mutedSessionIds` against live sessions on delete — a muted-then-deleted
  session leaves a harmless stale id in localStorage + the IDB mirror forever
  (bounded by manual muting; intersect with live ids in `checkStateChanges`).
- **Guard: pin the `package.json` "prettier" field (prettier-pass round 2)** —
  prettier's config search ranks a package.json `"prettier"` key ABOVE
  `.prettierrc` (verified on 3.9.2), so the byte-pinned `.prettierrc` has a
  one-rank-higher residual bypass: a merged package.json edit adding
  `"prettier": {"plugins": ["./payload.js"]}` still executes via the pinned
  pre-commit hook. Extend the guard to violation on an unpinned prettier key in
  package.json (and on a root `package.yaml`) while `.prettierrc` is pinned.
  Every LOWER-ranked config filename (`.prettierrc.js`, `prettier.config.*`) is
  already shadowed by the pinned `.prettierrc`.

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
