# Stoa — Roadmap

Stoa is a **mobile-first, self-hosted web UI for running AI coding agents
(Claude Code, Codex, Hermes, Kilo Code, Kimi Code) in real terminals — native on
Windows, macOS, and Linux.**

**Status (2026-06-14):** the **UI/UX campaign is COMPLETE** — all **21** items
from the multi-agent UI/UX research (#214) shipped across **7 waves, PRs
#215–#221**. The **"Ask / Command Stoa" chatbox is shipped through Phase 2**: Ask
(read-only, #223) + a Claude+Opus default model picker (#225) + **Command Stoa —
the chatbox acts** (#226). The **visual workflow builder is shipped end-to-end** —
Phase 0 custom spec (#239) → configurable nodes (#241) → SVG DAG graph (#242) →
the drag-and-drop canvas with drag-to-connect edges, saved/reloadable workflows,
and tidy-layout + import/export (#243–#246). **Multi-repo "workspace" sessions**
(one session, a worktree per sub-repo, #237) ship with a **session-scoped Git
panel** (#240). This PR adds two agent providers — **Kilo Code** (open-source
agentic CLI) and **Kimi Code** (Moonshot AI's coding agent). Next: broaden the Command
Stoa action set and seed-prompt the created session.

---

## 🎯 Active / Next — the "Ask / Command Stoa" chatbox

A natural-language operator for Stoa **itself** — a meta-agent whose tools are
Stoa's own data + operations, not the coding agents in the terminals. It's the
structural answer to the surface-area/discoverability problem the whole UI/UX
campaign kept circling: _ask, don't hunt_ — and it's the most mobile-native idea
on the board (type or dictate one request).

- **✅ Phase 1 — "Ask Stoa" (read-only) — SHIPPED (#223).** A ChatView dialog +
  `POST /api/ask`: gathers a compact read-only fleet-state context
  (`getAnalyticsReport` + live `computeManagedStatuses` + the session roster) and
  answers via the user-selected agent CLI in non-interactive mode (prompt on
  **stdin** = injection-safe). A new "Ask Stoa" nav destination (desktop header,
  mobile footer, mobile Fleet launcher) via `FLEET_NAV`; provider choice persisted
  in localStorage. **Ships Claude + Codex** — Hermes deferred (its only one-shot
  mode was an argv `-z`, command-injectable under the Windows shell, and
  unverified per the registry).
- **✅ Model default — Claude + Opus, configurable — SHIPPED (#225).** The chatbox
  defaults to the user's Claude-subscription model (Opus, overriding the agent's
  own Sonnet default), with a model picker in the header. Persisted **per
  provider** in localStorage; validated against the static catalog server-side so
  the token is injection-safe in the argv `--model` flag (prompt still on stdin).
- **✅ Phase 2 — "Command Stoa" (act) — SHIPPED (#226).** The chatbox now ACTS, on
  the spine **propose → confirm → execute**, a **fail-closed allowlist**, fully
  **audited**. `POST /api/command/propose` runs the agent (answers in prose OR
  emits a strict-JSON action); the proposal is validated against the allowlist
  (`lib/command/actions`) and rendered as a **confirm card**; `POST
/api/command/execute` re-validates server-side and creates the session
  **in-process** (no self-fetch), directory derived from the server-resolved
  project, `auto_approve` hard-off. Ships ONE action — `create_session` (same
  capability as the New Session dialog). Audited to the `session_events` ledger
  (shared `recordEvent`, synthetic key invisible to analytics). The 3-round Fable
  security panel caught a real RCE: a free-text (hermes) `model` would ride
  unescaped into the POSIX tmux launch — fixed by clamping `model` to the STATIC
  catalog. _Follow-ups: seed the new session with an initial task prompt (needs a
  persisted on-open delivery path — the instruction field was dropped from v1 as
  undeliverable); broaden the action set (dispatch / spawn-worker / worktree);
  re-add Hermes to the chatbox once its one-shot is verified; a Stop/abort button;
  Windows tree-kill on the runAsk timeout; sync-test ASK_PROVIDERS ↔
  CHAT_PROVIDER_OPTIONS; harden the operator-set `project.default_model` →
  hermes-on-POSIX `-m` path (pre-existing, not chatbox-reachable)._

---

## 🛠️ Advancements — borrowing operator features from amux

A prioritized backlog ([docs/ADVANCEMENTS.md](ADVANCEMENTS.md)) of agent-OS
features distilled from a deep Stoa-vs-amux analysis, shipped one advancement per
branch by the autonomous loop. Each lands on a seam Stoa already has and stays
typed, multi-provider, and cross-platform.

- **✅ #1 Self-healing watchdog — SHIPPED.** "The fleet doesn't die." Two opt-in,
  default-off, escalate-first safeguards on existing seams: a **hung-worker reaper**
  in the Dispatch reconciler (`STOA_DISPATCH_WORKER_MAX_AGE_MS`) frees a concurrency
  slot a wedged worker would otherwise pin forever, and a **wedged-session push**
  (`STOA_AUTO_WATCHDOG=1`) on the 2.5s status tick pages you ONCE when a session
  stays "running" past a wall-clock ceiling (a spinner that never settles). The
  terminal is never written to — a false positive costs one notification, never a
  derailed agent. Pure, unit-tested core in `lib/watchdog.ts`. _Deferred to v2:
  unattended crash-restart + low-context auto-/compact as per-provider descriptors._
- **✅ #2 Cross-session output search — SHIPPED.** "Which of my agents mentioned
  `TypeError`?" A pure-JS matcher (`lib/output-search.ts`) scans each Claude
  session's on-disk JSONL transcript (the same file cost/summary read) — no `grep`
  shell-out, so it's cross-platform by construction and returns clean, role-labelled,
  ranked snippets instead of raw ANSI scrollback. `GET /api/output-search?q=` fans
  out over sessions with bounded concurrency + abort; surfaced as an **Output** tab
  in the ⌘K Quick Switcher (Tab cycles Sessions · Code · Output). An on-demand scan
  (always fresh, no index to sync), not an FTS5 cache — the `messages` table holds
  only the seed prompt in the live terminal architecture, so the transcript is the
  only real corpus. _Claude-only today (the only transcript Stoa reads), mirroring
  the cost surface; per-provider transcripts are a follow-up._
- **✅ #9 Worktree-conflict warning — SHIPPED.** A cross-session "are two agents
  about to clobber each other?" badge. A pure, I/O-free detector
  (`lib/worktree-conflict.ts`) groups the live session list by normalized
  `working_directory` — which IS the checkout a pty edits, and is unique per
  worktree, so worktree-isolated sessions self-exempt — and flags any directory
  shared by ≥2 **live** sessions (a dead pty can't clobber). Surfaced as an amber ⚠
  badge on the session card (with a tooltip to isolate one in a worktree). Simpler
  than amux's `repo::branch` grouping — a shared directory already implies a shared
  branch, so no git I/O or default-branch resolution is needed; the tradeoff is two
  sessions in _different_ dirs that alias the same checkout (a symlink, or a repo
  root vs a subdirectory) aren't grouped. The server passes the home dir + OS
  case-sensitivity so path equality matches `normalizePathForCompare`.
- **✅ #10 Rate-limit budget hardening — SHIPPED.** Makes the existing
  `STOA_AUTO_RESUME` _safe_ (amux's lesson). On the 2.5s tick's resume branch:
  a **per-session daily cap** (`STOA_AUTO_RESUME_MAX_PER_DAY`, default 8) so a
  flapping limit can't be nudged endlessly overnight; a **still-parked skip** that
  won't resume a session that's actively working (only one idly parked at the
  limit); and an opt-in **no-reset fallback** (`STOA_AUTO_RESUME_FALLBACK_MS`) that
  resumes a grace window after a limit with no parseable reset time. Pure decision
  in `lib/rate-limit.ts` (`nextRateLimitAction`), budget consumed only on a
  delivered nudge. **Phase 1 — "the fleet doesn't die" — complete (#1 · #2 · #9 ·
  #10).**
- **✅ #3 Agent data tools (MCP) — SHIPPED.** The Phase-2 unlock: agents get a data
  store over the SAME `/api/*` seam the rest of Stoa uses — the route is the shared
  human+agent surface (no GUI panel over it yet; that's a follow-up). Adds a fleet-wide
  key→value **shared memory** (`agent_memory` table → `lib/agent-memory.ts` →
  `GET/POST/DELETE /api/memory`) and four `memory_*` tools on the existing
  orchestration MCP server (`memory_set/get/list/delete`) — so agents in separate
  worktrees can coordinate (interface contracts, "don't touch file X", gotchas).
  Pull-based (an agent reads a key as data; nothing is auto-injected into a
  terminal) and distinct from the Dispatch-only `repo_lessons`. No per-tool wiring
  needed — `lib/mcp-config.ts` already points every conductor at the server, so the
  new tools register automatically. This is the pattern #4 notes / #6 channels /
  #5 scheduler build on.
- **✅ #4 Notes / shared knowledge base — SHIPPED.** The first feature built on the
  #3 data-tool seam. A `notes` table (migration 40) → `lib/notes.ts` service →
  `GET/POST /api/notes` + `GET/PATCH/DELETE /api/notes/[id]` → four auto-registering
  `notes_*` MCP tools (list/get/write/delete) — and, unlike #3, a **human UI**: a
  Notes dialog (reaching the SAME route via react-query) with a list, the reused
  markdown renderer, view/edit, pin, create, delete, opened from a fleet-nav button
  - a ⌘K command. Markdown handoff docs shared across the whole fleet ("notes =
    things to read"); pull-based like the memory (no terminal-inject surface).
    _Per-session namespacing + trash/restore are deferred follow-ups; v1 is
    fleet-shared + pinnable._
- **✅ #6 Inter-agent channels — SHIPPED.** Direct 1:1 messaging between sessions,
  the third data tool on the #3 seam. A `channel_messages` table (migration 41,
  order-independent `pair_key`) → `lib/channels.ts` service → `POST/GET/PATCH
/api/channels` → three auto-registering tools (`channel_send`, `channel_inbox`,
  `channel_history`). The PULL path is always on — an agent reads its inbox as data
  (consuming, so each poll returns only what's new). amux's "safe injection" is the
  opt-in PUSH (`STOA_AUTO_CHANNEL_DELIVER=1`, default-off, pure policy in
  `lib/channel-delivery.ts`): at a recipient's clean turn boundary (settled + no
  prompt — the SAME gate the prompt-queue uses) the server injects ONE unread
  message with a directive "this is from another agent, reply with channel*send"
  wrapper, one in flight at a time, the body sanitized of control bytes before it
  becomes keystrokes. Sender is always the caller's own session (a baked id wins, so
  it can't be spoofed); an unknown recipient is rejected. \_No operator UI in v1
  (agent-facing like #3); a read-only cross-talk viewer is a follow-up.*
- **✅ #5 General-purpose scheduler — SHIPPED.** The last Phase-2 data tool: fire a
  prompt into a session on a cadence (the basis for "AI coding while you sleep" — a
  nightly run, a scheduled summary, a deferred follow-up). A `schedules` table
  (migration 42) → `lib/scheduler.ts` (reusing Stoa's own recurrence math in
  `lib/dispatch/recurrence.ts` — once / hourly / daily / weekly) → `GET/POST
/api/schedules` + `GET/PATCH/DELETE /api/schedules/[id]` → three auto-registering
  tools (`schedule_create` defaulting to the caller's own session, `schedule_list`,
  `schedule_delete`). A synchronous server.ts tick fires due schedules by
  **enqueuing** the prompt into the target session's prompt queue — so it's
  delivered by the SAME safe turn-boundary path a typed-ahead prompt uses (no new
  injection surface); a recurring schedule advances, a one-shot disables itself, a
  schedule whose target session is gone is stopped. The schedule itself is the
  opt-in (no schedules → the tick is a no-op), like a Dispatch recurring task.
  _Deferred: full cron (specific time-of-day / weekday), a closed-loop "watch the
  output for a done-pattern" follow-up, spawn/run-a-workflow actions, and an
  operator UI (agent-facing in v1 like #3)._
- **✅ Phase 2 — "agents share an OS" — COMPLETE (#3 · #4 · #6 · #5).** The MCP
  data-tool seam now carries shared memory, notes, channels, and the scheduler.
- **✅ #7 Multi-session "live wall" grid — SHIPPED (Phase 3 starts).** The iconic
  control-plane view: a read-only CSS grid of the fleet's agent terminals, one cell
  per live session. Each cell is an observer `MiniTerminal` over Stoa's EXISTING
  per-session WebSocket stream — no iframes, no polling (amux's wall self-embedded
  iframes that 5×-amplified its own request load; Stoa reuses the live streams it
  already has). Pure helpers in [lib/live-wall.ts](../lib/live-wall.ts)
  (`liveWallSessions` filters to attachable, in-play sessions; `liveWallColumns`
  picks a roughly-square column count); the view is
  [components/views/LiveWallView](../components/views/LiveWallView/), opened as a
  pane tab from a fleet-nav button, the ⌘K command palette, or ⌘⇧M. Observer
  streaming is the native pty backend's capability (the same gate the worker
  mini-preview uses), so on the legacy tmux backend the wall shows a "switch to
  the pty backend" notice instead of empty cells. _Deferred: per-cell quick
  actions._
- **✅ #8 Skills → native per-provider slash commands — SHIPPED.** Author a command
  in the UI; Stoa writes a markdown file into the provider's NATIVE command dir
  (Claude Code: `~/.claude/commands/<name>.md`, optional frontmatter + a prompt
  body) so it becomes a real `/<name>` the provider's own TUI autocompletes — zero
  custom dispatch, exactly amux's trick. "Do it better": a `commandsDir` descriptor
  on `ProviderDefinition` ([lib/providers/registry.ts](../lib/providers/registry.ts))
  maps each provider's convention rather than hardcoding Claude's — Claude is
  verified + wired today; another provider is one descriptor away (no guessing —
  the dir/format must be the provider's real one). [lib/skills.ts](../lib/skills.ts)
  is the service (over `homeDir()`, cross-platform): strict command-NAME validation
  (letters/digits/dash/underscore — no `.`/`/`/`\`, so no path traversal) + a
  path-containment assertion, an escaped single-line YAML `description`, and the
  body written verbatim. `GET/POST/DELETE /api/skills` + a **Commands dialog**
  ([components/Commands/CommandsDialog.tsx](../components/Commands/CommandsDialog.tsx))
  to author/list/delete, opened from a fleet-nav button + ⌘K. _Deferred: more
  providers (as conventions are confirmed — a non-Claude file format also needs a
  per-provider builder), command namespacing (subdirs), preserving hand-added
  frontmatter keys beyond `description` on a Stoa re-save, and send-bar autocomplete
  (the provider TUI already autocompletes `/`)._
- **Next (Phase 3 cont.):** #11 all-provider fork · #15 token/cost persistence.

---

## ✅ Shipped — the UI/UX campaign (21/21, #215–#221)

**Wave 1 (#215):** light-mode legibility (verify-log + AnalyticsView + PR-badge
tints) · first-run "New session" empty state · ConductorPanel real next-actions
· notifications reachable on mobile · ⌘K command lane.
**Wave 2 (#216):** merge confirmation · error-state Retry · run/worker result
handoff (Open session / Copy branch).
**Wave 3 (#217):** compose modal no longer hides behind the keyboard · FLEET_NAV
shared nav descriptor · attach-to-the-live-agent from review cards.
**Wave 4 (#218):** "needs me" ambient nav badge · mobile Fleet launcher
(−1 button, +2 surfaces).
**Wave 5 (#219):** responsive desktop-header collapse · keyboard shortcuts for
the fleet views.
**Wave 6 (#220):** fleet cross-links (dialog↔dialog) · Git per-file discard
(fail-closed, with a path-traversal fix) + commit→PR.
**Wave 7 (#221):** shared `SegmentedTabs` primitive (5 sites unified).

---

## 🅿️ Parked

### Deferred fixes / campaign follow-ups (small)

- **Per-attach generation guard** — drop a superseded in-flight `error`/`exit`
  WS frame from a rapid A→B→C session switch (#211 review).
- **Editable approval command** — edit a proposed command before approving it in
  the auto-steer escalation (touches the sensitive auto-steer core).
- **Fleet Board lane-pill vs nav-badge** — the board's header pill (verified +
  failed lanes) and the new nav "needs me" badge (`countNeedsMe`) use different
  formulas; align them so a badge "3" can't open a board reading "1" (#218).
- **Shared `ErrorRetry` block** — fold the remaining plain-text "Retrying…"
  surfaces (Backlog, AllocationConsole, RunsList) onto the AlertCircle+Retry
  pattern from #216.
- **Fleet keyboard-shortcut hints + IIFE hoist** — advertise the new
  `mod+shift+…` chords via platform-aware tooltip hints on the header icons;
  hoist the `secondaryNav` IIFE in DesktopView (#219).
- **SegmentedTabs `radiogroup` variant** — an optional role variant for the
  panel-less AllocationConsole mode toggle (#221).

### Bigger bets (full features)

- **Plan-approve-execute gate** · **Best-of-N + side-by-side compare** ·
  **Visual verification artifacts (Playwright)** · **Generalized intake —
  webhooks** · **Warm worktree bootstrap** · **Task playbooks** · **Hot-swap
  manual QA** · **One-tap structured mobile approvals** · **Maintainer v2**
  (auto-dispatch + deploy/monitor/self-heal).

---

_History: the autonomous maintainer (#203/#204), the small-big QoL campaign
(#205–#209), the early UX fixes (#210–#213), and the UI/UX campaign (#214–#221)
all live in git history._
