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
- **Next:** #2 cross-session output search · #9 worktree-conflict badge · #10
  rate-limit budget hardening (Phase 1), then the MCP data-tool unlock (#3 → #4 →
  #6 → #5).

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
