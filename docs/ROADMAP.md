# Stoa — Roadmap

Stoa is a **mobile-first, self-hosted web UI for running AI coding agents
(Claude Code, Codex, Hermes) in real terminals — native on Windows, macOS, and
Linux.** The native-Windows migration, the `PtyTransport` unification, the Stoa
rename, and the green 3-OS CI matrix are all done; **Priority A (UI/UX) +
Priority B (Performance)** shipped; and the **entire round-1 competitive scan —
the WS-events milestone, the security trio, actionable push, and cost &
governance — has now shipped (PRs #55–#91).**

The 🔭 **Next horizons** scan (round 2) below is the _backlog menu_ of unbuilt
work, demand/effort-ranked (`D`=demand, `E`=effort, ⭐=differentiator for Stoa's
angle). The **committed near-term sequence** drawn from it is the **▶ ACTIVE
PLAN** section below — that is the single source of "what's next."

**Round-2 update (2026-06-05):** the round-2 _flagship_ — the **review & rewind
layer** — has now **fully shipped** (Stages 1–3, PRs #93–#95), along with the
**prompt queue** (#96), **Dispatch / GitHub-issue ingestion** (#104 engine + #108
control-plane UI), and the **CRITICAL macOS scrollbar bug** (#98 + #106). See
"✅ Shipped since round 2" below; the remaining unbuilt horizons are re-ranked
under "🔭 Next horizons."

**Reality-sync (2026-06-06):** this roadmap had drifted behind `main`. Two
corrections: (1) the **independent reviewer-agent gate** — listed below as the
"▶ NEXT BIG FEATURE" — **already shipped** (#118, `lib/dispatch/reviewer.ts`),
together with the full **Dispatch fleet** maturation (#109–#124: merge cockpit,
fix loop, schedule, source pickers, on-demand triage). (2) The **always-on
service / autostart** feature (#123) was **reverted by choice** (#125) —
autostart is the operator's decision, not Stoa's. The forward plan is now the
**▶ ACTIVE PLAN** section directly below.

---

## ▶ ACTIVE PLAN (2026-06-06) — agreed execution order

The current committed sequence. Each item ships as its own PR through the
3-OS CI matrix + 3-agent review gate; tick the box here as it lands.

1. [x] **Port-config bug fix** ✅ **DONE** — the CLI (`scripts/stoa.js`) read
   `STOA_PORT` for display/status, but the server (`server.ts`) reads `PORT`,
   and `cmdStart`/`cmdRun` spawned `npm start` **without passing the port
   through** — so the displayed port and the listening port silently diverged,
   and `STOA_PORT` didn't actually move the server. Fixed: a single resolved
   `PORT` (`STOA_PORT || PORT || 3011`) now drives both the displayed URL and a
   `serverEnv()` passed to every server spawn (case-collision-safe on Windows);
   `.env.example` documents `STOA_PORT`. Regression tests in
   `test/stoa-cli.test.ts`. _(Fixed the repo bug — not a per-machine
   `stoa.cmd` wrapper.)_
2. [x] **Tier-2 daemon `uncaughtException` guard + lifecycle tests** ✅ **DONE** —
   the pty-host daemon had no top-level exception guard, so one unhandled throw
   would kill **every** live session at once (the largest stability blast-radius
   in the tree). Fixed in three layers: (1) `PtySession.fanOut` isolates each
   output/exit subscriber in a try/catch, so a throwing listener can't abort the
   fan-out **or** escape node-pty's `onData`/`onExit` callback (the async seam
   the IPC decoder's try/catch doesn't cover); (2) the daemon's `send()` drops
   just the failing connection on a write/encode error (it reconnects + repaints
   from a fresh snapshot); (3) `installProcessGuards()` adds last-resort
   `uncaughtException`/`unhandledRejection` handlers that log-and-stay-alive,
   installed **only** in the standalone daemon entry (`scripts/pty-host.ts`),
   never in-process where they'd mask real crashes. Locked the three untested
   Tier-2 lifecycle contracts (exit-over-IPC, exit-during-socket-drop reported
   as gone, Tier-2→Tier-1 fallback re-resolution) plus the fan-out isolation and
   guard install/semantics — all in `test/pty-host.test.ts` + `pty-session.test.ts`.
3. [x] **Audit / event ledger** ⭐ ✅ **DONE** — an append-only per-session
   ledger (`session_events`: id, session_key, event_type, payload JSON,
   created_at epoch-millis) written at the **`getSessionBackend()` seam** via a
   `RecordingBackend` decorator (`lib/audit/ledger.ts`) — recording lifecycle
   (create / kill / rename) + input (text / paste / enter / escape) across tmux
   AND both pty tiers from one place. Recorded in the **web-server process**
   (where `better-sqlite3` lives — the Tier-2 daemon has no DB handle), best-effort
   (a failed audit write never breaks a terminal; failure logging is throttled).
   No FK to `sessions` ON PURPOSE so the trail outlives a deleted session — the
   **Windows-safety moat** ("what did the agent run") **and** the raw substrate
   for analytics (item 4). Input text is length-only by default (secrets aren't
   copied verbatim); `STOA_AUDIT_INPUT_TEXT=1` opts into capped full text.
   Default on; opt out with `STOA_AUDIT=0`. _Known limits (item-4 follow-ups):_
   events key on the mutable backend key (a rename splits the trail, with a
   `{from}` breadcrumb) — a stable correlation id is an analytics-model decision;
   raw pty output is not recorded (the rendered-screen capture serves that).
4. [x] **Analytics view on the ledger** ⭐ ✅ **DONE** — the **Insight layer**:
   a full on-box analytics cockpit over the item-3 ledger + session outcomes,
   spanning all three lenses of the Insight pillar in one strike. **Performance**
   (cost, tokens, median session duration, time-to-first-input, cost per merged
   PR, reviewer-gate pass rate), **Behavioural** (event-type mix, inputs/session,
   input cadence, paste ratio, abandoned sessions), **Intelligence** (per-provider
   merge rate + reviewer pass rate + a Laplace-smoothed, volume-weighted,
   sample-gated effectiveness score — no tiny-n vanity), **Trends** (dense daily
   time-series + least-squares slope), and **Issue detection** (cost spikes,
   stalls, runaway loops, failure clusters, low reviewer pass rate, abandonment).
   Architecture: a PURE engine (`lib/analytics/engine.ts`, exhaustively unit-
   tested over an injected snapshot) + a thin DB gather (`lib/analytics/queries.ts`,
   one indexed window query + bounded-concurrency cost reads) + a thin API
   (`/api/analytics`) + a dependency-free Dialog UI (`components/views/AnalyticsView`,
   inline SVG charts, mobile-first, a11y-labelled). **`better-sqlite3` stays the
   source of truth** (no DuckDB — see below). Shipped through 2× 3-agent review.
   This completes Insight-pillar **Stage 1 (Performance)** and lands much of
   **Stage 2 (Behavioural)** + **Stage 3 (Intelligence)** on the same substrate.

---

## ▶ ACTIVE PLAN — ✅ COMPLETE (2026-06-07)

All four committed items shipped (port fix #127/#128 · Tier-2 crash guard #132 ·
audit ledger #133 · Insight analytics layer). Next sequence to be drawn from the
🔭 Next horizons + 🧭 Strategic pillars below — candidate leads: the **Insight
pillar's** remaining depth (behavioural file-touch patterns, per-provider
intelligence correlated with richer outcome signals) once the ledger emits
cost/token/duration events, or the **Orchestration pillar** (declarative
multi-provider agent pipelines + unified cron/issue/manual triggers).

_Reference — the original DuckDB guidance for item 4:_ **Keep `better-sqlite3`
as the source of truth** (SQLite is right for the OLTP workload; a DuckDB native
addon adds 3-OS install pain). Only if SQLite's own aggregates prove
insufficient, add DuckDB **read-side** pointed at the existing sqlite file via
`sqlite_scanner` (zero ETL, zero migration).

---

## 🚨 CRITICAL — open bugs (fix first)

_None open._ The macOS · Hermes scrollbar + invisible jump-to-bottom bug is
**fixed**: #98 made the scroll-to-bottom button clickable/visible (hand cursor,
labeled), and #106 fixed the invisible scrollbar by gating the forced bar on
pointer type. ⚠️ Still wants a real-macOS-with-Hermes confirmation under the
human-in-the-loop verification gate (see 📌 Open notes) before we call it closed
for good.

---

## ✅ Shipped since the last scan (PRs #55–#91)

- **Actionable push — the full control loop** — approve / reject / stop an agent
  from the **lock-screen notification** (#90, `actions[]` + `/api/sessions/[id]/respond`
  over the send-keys/kill seam + a `sendEscape` backend method) AND **per-card
  quick actions** on the board (#91, self-contained `SessionQuickActions`, status-
  contextual). The round-1 "next big feature", now shipped on both surfaces.
- **Cost & governance** — per-session + fleet **cost estimation** from transcript
  tokens × model price (#88) and opt-in **budget caps** (#89, `STOA_BUDGET_SOFT_USD`
  alert / `STOA_BUDGET_HARD_USD` push-then-auto-stop; pure decision logic + a 30s
  server enforcement loop, off by default).
- **Roadmap refreshed** (#87) from the round-1 5-agent competitor scan.
- **Orchestration is reachable** — "Enable Orchestration" New-Session toggle wires
  the `stoa` MCP per provider: Claude (`.mcp.json` #55), Codex (`-c` flags #59),
  Hermes (global register + `.stoa-conductor` cwd marker #60). `spawn_worker`
  works across all three; conductor robustness hardened (#75).
- **Workspace / worktrees** (#62–#64) — POSIX→execFile port, `GET /api/worktrees`,
  attach-to-existing, orphan reclaim panel, auto dev-server port; safety-hardened
  (#74: separator-boundary `isStoaWorktree`, `feature/`-only `branch -D`).
- **WS-events milestone** (#70) — `/ws/events` live status push (5s poll backstops)
  + **live one-line previews** under each card (#65) + **status-aware ⌘K** and
  per-pane glyphs (#67).
- **Live worker mini-terminals** — observer pty attach (#79) + inline read-only
  xterm on the board (#80); relocated copy/paste/attach into the tab bar (#86).
- **Web Push closed-tab notifications** (#72) — service worker + VAPID; per-device
  dedupe + robustness (#76, #81).
- **Security trio** (#78) — `STOA_TOKEN` auth (loopback + Tailscale trusted, remote
  needs a token) + WS Origin allowlist + `/api/exec` off-by-default +
  `STOA_TRUST_TAILSCALE`; open-redirect guard (#83).
- **DELETE-authoritative** (#71) — kills the session's own pty (no lingering agents).
- **Hardening / hygiene** — dependency audit 11→0 (#77), mobile-keyboard input fix
  (#66), perf (#68 Prism-light, #69 shared TimeAgo ticker), and the macOS scrollbar
  fix (#85, Chrome-121 `::-webkit-scrollbar` regression).
- **Already shipped earlier** (confirmed by the scan, pruned from "wanted"):
  voice/dictation input (`useSpeechRecognition`), session export (md/json),
  resume (Claude/Hermes), the mobile missing-keys toolbar, projects/groups.

---

## ✅ Shipped since round 2 (PRs #93–#124)

- **The review & rewind layer — COMPLETE (the round-2 flagship)** — **Stage 1**
  session diff review, see exactly what the agent changed (#93); **Stage 2**
  per-turn snapshots + turn-history timeline, captured at each turn boundary as
  object-deduped shadow commits under `refs/stoa/snap/<sessionId>/<seq>` (#94);
  **Stage 3** rewind — restore the working tree to any snapshot, itself undoable
  via a safety snapshot (#95). One substrate, both flagship features.
- **Prompt queue** (#96) — line up the next tasks while an agent works; dispatch
  follow-ups in order on idle, no interrupt. The top "async cockpit" item.
- **Dispatch — GitHub issue → agent fleet (matured #104–#124)** — the **engine**
  (#104, issue→fleet reconciler) + the **control-plane UI** (#108, allocation
  console + backlog + in-flight board), then the full fleet build-out: source
  pickers (#110–#112 Stoa-project / disk-scan / GitHub-repo, clone-if-needed),
  create-an-issue from Stoa (#113), schedule-for-later (#115), **merge cockpit**
  (#117 review the diff + merge a worker's PR), **independent reviewer gate**
  (#118 auto-critic each PR, verdict in the cockpit — opt-in), **fix loop**
  (#119 re-task on changes-requested, then re-review), dismiss + retry for
  failed cards (#120), in-app "How it works" guide (#121), and on-demand issue
  triage (#124, browse a repo's open backlog from the cockpit). _Note:_ the
  reviewer gate is currently **advisory** (the verdict is surfaced; merge stays
  the user's tap) and the critic is read-only by prompt — making it
  merge-blocking + tool-enforced read-only is a tracked follow-up.
- **Reverted by choice** — always-on service / autostart parity (#123) was
  undone (#125); running Stoa as a supervised service is left to the operator.
- **Orchestration polish** — agent type shown on worker cards + sidebar rows
  (#99); conductor id is the baked id, authoritative over the agent's guess (#97).
- **Terminal / UI fixes** — bulletproof reconnect with no duplicated scrollback
  (#100); clickable/labeled scroll-to-bottom + quick-action labels (#98);
  optimistic quick-action dismiss (#101).
- **Push hardening** — sanitize untrusted text in notifications + on-demand test
  push (#103); plain-ASCII text so Windows doesn't render emoji as boxes (#102).
- **Security** — supply-chain surface guard, content-pinned + provider-agnostic
  (#107).

---

## 🔭 Next horizons — competitive feature scan (2026-06, round 2)

Second 5-agent web-research fan-out (agent IDEs · mobile/remote control ·
multi-agent orchestration · community demand · self-hosted/Windows/safety), run
after the entire round-1 scan shipped. **The dominant 2026 macro-signal across
every segment: the bottleneck moved from _writing_ code to _reviewing_ it** (AI
output up ~60%, PR-review time up ~91%). Ordered by leverage.

### ✅ SHIPPED — The review & rewind layer ⭐ _(was NEXT BIG FEATURE)_

Done in three stages (#93 diff review · #94 per-turn snapshots + timeline · #95
rewind/restore). One substrate — per-turn shadow-commit snapshots at the turn
boundary — powering both human diff review and checkpoint/rewind. _Follow-ups
still open:_ a **swipe-to-approve / per-hunk mobile diff** form factor (the
no-competitor-owns-it angle) and an **"approve & merge worktree"** action are not
yet built on top of the shipped diff + snapshot plumbing — candidates for a
fast-follow once the next flagship lands.

### ✅ SHIPPED — Independent reviewer-agent gate ⭐ _(was NEXT BIG FEATURE)_

**Shipped in #118** (`lib/dispatch/reviewer.ts`): a fresh critic session reviews
each worker PR and returns a PASS / request-changes verdict surfaced in the
merge cockpit, with the **fix loop** (#119) re-tasking the worker on
changes-requested and then re-reviewing (bounded by `MAX_FIX_ROUNDS`). This was
the machine half of the review-bottleneck thesis. _Follow-ups still open (tracked
as "Reviewer gate — enforcing mode" under Orchestration endgame):_ the gate is
**advisory** today — the verdict is shown but merge isn't blocked on it — and the
critic is kept read-only by **prompt wording only** (it's spawned with
auto-approve). Making it (a) merge-blocking with override and (b) tool-enforced
read-only is the remaining hardening.

### Async cockpit (lowest-effort; compounds the shipped push + mobile)

- [x] **Prompt queue — type the next tasks while it works** ⭐ ✅ **SHIPPED (#96)** —
  dispatch follow-ups in order on idle, no interrupt. Stoa owns stdin + the
  idle/working signal.
- [ ] **Auto-resume after rate-limit reset** ⭐ _(D:high · E:S–M)_ — detect "usage
  limit reached" off the rendered screen, count down, auto-continue when the window
  resets, ping via the shipped push. 8+ duplicate issues across Claude/Codex;
  Anthropic declined to ship → the natural wrapper home. Makes overnight/AFK runs
  actually finish.
- [ ] **Fire-and-forget dispatch from the phone** ⭐ _(D:high · E:S–M)_ — start a
  brand-new task server-side from mobile (not just steer running ones); matches
  Anthropic "Dispatch" / Codex "start something new". Stoa already spawns sessions
  on the host — mostly a mobile New-Session entry point + an authenticated spawn.

### Trust & safety (the self-hosted / Windows differentiator)

- [ ] **Runner-enforced permission policy — allow / ask / deny** ⭐ _(D:high · E:M)_ —
  an argv-matched gate at the transport seam, provider-agnostic, where "ask" routes
  through the shipped approve/reject push. In-agent probabilistic escalation is
  bypassable by subprocesses; a hard runner gate isn't.
- [ ] **Command audit log — "what did the agent run"** ⭐ _(D:high · E:M)_ **→ promoted to ▶ ACTIVE PLAN item 3 (audit/event ledger)** — a
  persisted, searchable per-session ledger of commands / writes / tool-calls + which
  approval gate each passed. Self-hosters value audit above all; compliance now
  requires the full execution chain.
- [ ] **Secret-protection guardrail** ⭐ _(D:high · E:M)_ — entropy/regex scan of
  reads / outputs / `.env` access; mask or block at the same interception seam as
  the policy engine. Hardcoded-secret leaks up ~81% in 2025.
- [ ] **Windows-native sandbox (SandboxedTransport)** ⭐⭐ _(D:high · E:L)_ — the
  category claim nobody else can make: Claude Code's `/sandbox` doesn't run on
  native Windows (#46740) and tells you to use WSL. A Job-Object/AppContainer-
  confined pty as a _transport_ (not a new backend) would make "the only way to run
  agents **safely** on native Windows" true. Highest differentiation, highest
  effort + the cross-platform-risk pick → ship opt-in behind a capability probe.

### Orchestration endgame (builds on conductor→worker)

- [ ] **Reviewer gate — enforcing mode** ⭐ _(D:high · E:M)_ — the reviewer-agent
  gate shipped advisory (#118); harden it to (a) block the merge path on a
  request-changes verdict (with explicit human override) and (b) enforce the
  critic's read-only contract at the runner/tool seam, not just in the prompt.
- [ ] **Agent merge queue — safe landing** ⭐ _(D:high · E:L)_ — serialize each
  worker's branch onto `main`, run the combined test suite, auto-rebase-and-retry,
  merge only if green. The endgame for a conductor that fans out N branches (today
  the human lands them by hand).
- [x] **Issue-tracker ingestion (GitHub Issues first)** ⭐ ✅ **SHIPPED (#104–#124)** —
  pull a ticket → spawn a worker with its context → PR/status back, now the full
  Dispatch fleet. The feature Emdash wins deals on; built on `gh`.

### Mobile inputs

- [ ] **Image / screenshot input** ⭐ _(D:high · E:M)_ — attach a screenshot/photo
  into the prompt from the phone (broken UI, stack trace, Figma). Stoa has voice-in
  but no vision-in; fully self-hosted (the image never leaves the box). The clearest
  "a phone can do what a terminal can't."
- [ ] **Two-way conversational voice** ⭐ _(D:med–high · E:M)_ — TTS read-back +
  turn-taking on top of the shipped dictation; browser `SpeechSynthesis`, no cloud
  dependency. Matches Omnara/Happy's eyes-free commute mode.

### Also surfaced (lower priority)

- **Best-of-N compare** _(D:med-high · E:M)_ — same task to N agents/providers →
  side-by-side diff → merge the winner; the multi-provider twist (Claude vs Codex
  vs Hermes) is Stoa-unique; gate behind budget caps.
- **Multi-account switching + auto-failover** _(D:high-raw · E:S–M)_ — per-session
  credential pick (claude-code #18435 = 593 reactions); the auto-failover-on-limit
  variant pairs with auto-resume.
- **Optional codebase indexing via MCP** _(D:med-high · E:L)_ — self-hosted
  embeddings/symbol index to cut token-burning grep sweeps (#4556 = 63 reactions);
  ship as an optional MCP server, not a default.
- **OpenTelemetry export** _(D:med · E:M)_ — emit session / cost / audit as OTel
  spans to the self-hoster's Grafana/Langfuse; reuses the audit event stream.

---

## 🧭 Strategic horizons (2026-06-06) — two pillars

Captured from a working session. Both are defensible *specifically* because Stoa
is self-hosted and multi-provider (Claude + Codex + Hermes under one roof) —
angles no single-vendor tool can own. Each lands through the standard PR + 3-OS
CI + 3-agent gate when picked up.

### Pillar 1 — Insight: the analytics layer (3 stages on one ledger)

Built on ACTIVE PLAN item 3's append-only audit/event ledger — three lenses on
one substrate, not three separate builds. Sequenced easiest→hardest:

- [x] **Performance analytics** ✅ **DONE** — tokens, cost, median session
  duration, time-to-first-input, cost per merged PR, reviewer-gate pass rate.
  Shipped as the Insight layer (ACTIVE PLAN item 4) over the audit ledger +
  `lib/session-cost.ts`/`pricing.ts`.
- [x] **Behavioural analytics** ✅ **MOSTLY DONE** — "what each agent actually
  does": event-type mix, inputs/session, input cadence, paste ratio, where
  sessions stall + abandonment. Shipped in the Insight layer's Behaviour lens.
  _Remaining depth (needs richer ledger events):_ command frequency + file-touch
  patterns require the ledger to record tool/command detail (today it records
  lifecycle + input at the SessionBackend seam, not per-command/tool streams).
- [x] **Intelligence analytics** ⭐ ✅ **DONE (v1)** — per-provider effectiveness
  (Claude vs Codex vs Hermes) correlated with outcome signals (PR merged?
  reviewer verdict?). Shipped as the Insight layer's Intelligence lens with a
  **Laplace-smoothed, volume-weighted, sample-gated** effectiveness score that
  honours the "resist a vanity score" guidance (withheld below a session floor;
  raw rates always shown with their denominators). _Deepens further_ as more
  outcome signals (tests passed, human approve/reject) flow into the ledger.

### Pillar 2 — Orchestration: declarative multi-provider workflows ⭐⭐

- [x] **Agent pipelines — engine + executor (Stage 1)** _(D:high · E:L)_ ✅ **DONE** —
  a declarative workflow spec (`lib/pipeline/types.ts`): steps, `dependsOn`
  edges, per-step provider/model, driven by a **PURE engine**
  (`lib/pipeline/engine.ts` — DAG validation incl. cycle detection, the
  ready/started/outcome reducer, failure cascade-skip, run-status derivation;
  exhaustively unit-tested over injected state) + a **thin executor**
  (`lib/pipeline/executor.ts` — injectable side-effects, parallel launch of
  ready steps, poll→outcome loop) wired to the existing `spawnWorker` seam via
  `lib/pipeline/default-deps.ts`. Reachable through `POST/GET /api/pipelines`
  (+ in-memory run registry) and the conductor MCP (`run_pipeline` /
  `get_pipeline`). E.g. "Claude drafts → Hermes reviews → Codex + Claude
  implement in parallel → merge." Also shipped the **first regression tests for
  `lib/orchestration.ts`** (was untested). Hardened through a 2× 3-agent
  supremacy review: spec validation rejects shell-metachar injection in
  `model`/`workingDirectory`; the executor caps real fan-out
  (`maxParallelism`, default 4), is crash-safe (an unexpected throw drives the
  run terminal, never a zombie snapshot), and the run registry has a
  hard-ceiling eviction so it can't grow unbounded. _Follow-ups (Stage 2):_ a
  pipeline **UI** (author/visualize the DAG), **run persistence** across
  restarts (the registry is in-memory today), richer **PR-grounded step
  outcomes** (see the merge-signal note below), and **rewind/snapshot
  integration**.
- [ ] **Unified triggers (cron + issue + manual)** _(D:med–high · E:M)_ — rather
  than a standalone cron, make scheduling a TRIGGER TYPE that feeds the same
  workflow executor: manual, cron ("every morning at 9, run this workflow on
  this repo"), or GitHub-issue (the existing Dispatch path, #115 reconciler
  already proves fire-on-schedule plumbing). One executor, three front doors —
  avoids three half-built schedulers.

#### ⚠️ Insight merge-signal blind spot (found 2026-06-07) — folds into Orchestration

The Intelligence lens reports **0 merges** because a session's merge is only
recorded from two paths: the **Dispatch** outcome (`issue_dispatches.status`)
or the **in-app PR panel** (`GET /api/sessions/[id]/pr`, pull-on-demand). Every
real PR in this repo (#1–#135) was created + squash-merged via `gh`/`git` in the
**terminal** during the ceremony — so none of it ever reached Stoa's DB. The
engine math is correct; the **signal coverage** is the gap.

**Decision (durable fix, Stage-2 of pipelines):** add **branch-based PR-status
reconciliation** for ALL sessions with a `branch_name` (interactive + Dispatch +
orchestration workers) via `gh pr view <branch>` / git "did this branch land on
main", following the `lib/dispatch/github.ts` convention (`resolveBinary("gh")`,
`execFile` argv, a pure parse fn split out for tests). **Segment merges by
origin** (autonomous worker vs human-steered interactive) so an autonomous
merge and a human-rescued one never blend into one effectiveness score — keep
the existing Laplace-smoothed, sample-gated guard. Until then the lens should
not headline a "0% / 100% merge rate" off a near-empty tracked-merge
denominator (extend the existing minimum-sample floor to the merge metric).



---

## 🔧 Carried-over engineering backlog

Still-valid items from the prior codebase scan + the ultra-review follow-ups.
Lower-profile than the feature horizons but real.

**Performance**

- [ ] **Binary WS frames browser-ward** _(P:high · E:M)_ — the daemon→server hop is
  binary, but server→browser still `JSON.stringify`s ANSI per message per socket.
  Send output as a binary WS frame (1-byte kind + raw UTF-8). _Risk:_ preserve the
  Claude top-scroll rAF fix + snapshot-then-stream ordering.
- [ ] **Dedupe the duplicated CodeMirror chunks (2× ~663KB)** _(P:med · E:M)_ —
  FileExplorer + FileExplorerDrawer each statically import FileEditor; hoist behind
  one shared dynamic wrapper + lazy per-language grammars.
- [ ] **Throttle headless-VT parsing for sessions with zero subscribers**
  _(P:med · E:M)_ — gate the full per-byte parse on `subscriberCount`; flush before
  `capture()`/`serialize()`. Biggest per-session server-CPU lever under a fleet.
- [ ] **Prefetch the Terminal chunk on idle + strip the prod debugLog ring** + **disable
  cursorBlink on inactive terminals** _(P:low/med · E:S)_ — minor cold-start / repaint wins.

**Stability**

- [ ] **Main-terminal WS `error` frame** _(P:med · E:S)_ — the mini-terminal handles
  it (#80/#82) but the main terminal still leaves a dead "Switching…" overlay on a
  failed attach. Add the `error` branch + a Relaunch toast.
- [ ] **M1 — Tier-2 per-subscription daemon slots** _(P:med · E:M)_ — the shared
  HostClient keys one slot per session key, so a worker open full-screen AND
  observed can evict the viewer's sizing slot (the freeze half is guarded via
  ref-counted detach in #84). Proper fix: `Map<key, Set<sub>>` + a sub-id in the
  detach protocol.
- [ ] **Daemon `uncaughtException` guard + scoped retry on the flaky Windows pty test**
  _(P:med · E:S)_ **→ promoted to ▶ ACTIVE PLAN item 2** — one unhandled throw in the Tier-2 daemon kills every live
  session; add per-connection keep-alive + `it.retry` on the node-pty spawn specs.
- [ ] **Lock the untested Tier-2 lifecycle contracts** _(P:med · E:M)_ **→ folded into ▶ ACTIVE PLAN item 2** — exit-over-IPC,
  exit-after-reconnect (a short agent exiting during a socket drop repaints as
  alive), Tier-2→Tier-1 fallback.

**Deferred follow-ups**

- [ ] **M3 — push settings-awareness** — Web Push can't see in-app notification
  settings, so a visible tab with an event toggled off in-app gets no alert. Needs
  server-side (or SW-readable) settings.
- [ ] **tmux read-only mini-terminal (mac/linux parity)** — the observer attach is a
  pty primitive; the tmux path needs a `tmux attach -r` equivalent (the `lastLine`
  preview is the fallback there today).
- [ ] **Codex resume + a resume/continue picker at New Session** — verify Codex's
  flag via `--help`, capture its id additively; `status-detector` is shared/locked
  (strictly additive).
- [ ] **Per-session MCP capability toggles** — a curated MCP catalog + per-session
  checkboxes in New Session, merged non-destructively (only `stoa` is wired today).

---

## 📌 Open notes

- **Hermes status detection** — the per-provider `waiting/running/idle` patterns are
  vestigial; `status-detector` uses its own global lists (shared, locked by the
  Claude path). Tuning Hermes needs a live observation of its busy/waiting output.
- **Human-in-the-loop Windows verification** (§ gate) — real-browser checks for
  spawn→stream→resize→reconnect, Tier-2 restart-survival, orchestration on native
  Windows, and the shell drawer / file picker / Git+PR flow against a real repo.
- **`create()` dual-representation unify (deferred)** — collapsing `buildFlags`
  (tmux string) and `buildAgentArgs` (pty argv) is NOT byte-identical (tmux omits
  Hermes `--resume`), so it changes the locked macOS/Linux path → needs a real
  Mac/Linux check before merge. Implement test-first (argv→banner byte-identity).
- **Editor lightness (large bet)** — dropping `@monaco-editor/react` + `monaco-editor`
  and folding git-diff onto `@codemirror/merge` is the biggest bundle win but
  L-effort with real diff/inline-staging UX risk; pursue after the CodeMirror dedup.
