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

- **OS app-icon badge for attention** (S) — `setAppBadge(waitingCount)` from the
  state-change check that already computes it (+ the SW push payload). A red **N**
  on the home-screen icon is the only glanceable "agents need you" signal on an
  installed PWA; the tab title is never seen on a phone.
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
> (#311).

### Tier 1 — High impact (ranks 1–32)

> Ranks **1, 2, 4, 5, 6, 7, 8** are confirmed bugs — clear these first; they're
> cheap trust wins and several corrupt cost/analytics or break a first-class
> platform.

1. 🐛 **Fix native Claude fork cost double-count** — `bug` · L. A native Claude
   fork (`--resume <parent> --fork-session`) inherits the parent's entire
   transcript, so `parseClaudeUsage` books the parent's full history as the fork's
   usage. Capture a per-session `baselineTokens/baselineCost` at fork time and net
   it out. _Why:_ fleet cost badge ~doubles and the persisted curve spikes on every
   fork day. _Seam:_ `lib/session-cost.ts`, `lib/cost-history.ts`,
   `app/api/sessions/[id]/fork/route.ts`, `app/api/sessions/cost/route.ts`.
2. 🐛 **Fix Windows live-wall observer evicting pane resize** — `bug` · L. Re-key
   the pty-host `attached` map by `(key, sub-id)` so an observer attach gets its own
   slot and never evicts the real client's sizing slot. _Why:_ on the default
   Windows backend, observing a full-screen worker permanently breaks that pane's
   resize. _Seam:_ `lib/session-backend/pty/host.ts`, `host-client.ts`.
3. **OS app-icon badge for attention count** — `mobile` · S. `setAppBadge`/
   `clearAppBadge` from the state-change check + the SW push payload. _Seam:_
   `lib/notifications.ts`, `hooks/useNotifications.ts`, `app/sw.ts`, `lib/push*.ts`.
4. ✅ 🐛 **Map `STOA_PORT`→`PORT` for `npm run dev`** — `bug` · S. **SHIPPED (#311).**
   `portAlias()` in `lib/load-env.ts` bridges `STOA_PORT`→`PORT` on startup
   (STOA_PORT wins), so `npm run dev` honours the knob the same way the CLI and
   `stoa doctor` do. _Seam:_ `lib/load-env.ts`.
5. 🐛 **Fix Windows `.cmd` EINVAL in commit-message + summarize** — `bug` · S.
   Route the `claude` `.cmd` shim through `cmd.exe /c` via a shared helper. _Why:_
   two features fully broken on Windows. _Seam:_
   `app/api/git/commit-message/route.ts`, `app/api/sessions/[id]/summarize/route.ts`.
6. 🐛 **Key `session_costs` on the canonical backend key** — `bug` · S. Replace
   `tmux_name || name` with `backendKeyForSession(s)`. _Why:_ same-named pty
   sessions clobber each other's cost rows. _Seam:_ `lib/cost-history.ts`,
   `lib/analytics/queries.ts`.
7. 🐛 **Skip-if-queued / cap depth for recurring schedules** — `bug` · S. _Why:_ a
   schedule against a wedged session builds an unbounded queue then floods the
   agent. _Seam:_ `lib/scheduler.ts`, `lib/prompt-queue.ts`.
8. 🐛 **Self-resolve native-fork parent on respawn** — `bug` · M. Make
   `buildSpawnForSession` self-resolve the native-fork parent like `app/page.tsx`
   does. _Why:_ a fork that reconnects (flaky mobile WS) before its first turn
   silently becomes a blank session, losing the forked context. _Seam:_
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

---

_History: the autonomous maintainer (#203/#204), the small-big QoL campaign
(#205–#209), the early UX fixes (#210–#213), the UI/UX campaign (#214–#221), and
the amux-inspired advancement loop all live in git history. This forward roadmap
was generated 2026-06-30 from a 9-agent research + engineering pass._
