# Stoa — Roadmap

Stoa is a **mobile-first, self-hosted web UI for running AI coding agents
(Claude Code, Codex, Hermes) in real terminals — native on Windows, macOS, and
Linux.**

**Status (2026-06-12):** the **UI/UX campaign is COMPLETE** — all **21** items
from the multi-agent UI/UX research (#214) shipped across **7 waves, PRs
#215–#221**, each built by parallel worktree agents and merged through the full
ceremony (gate → multi-agent review → 3-OS CI). The next build is the
**"Ask / Command Stoa" chatbox** (below), promoted from the parked bets.

---

## 🎯 Active / Next — the "Ask / Command Stoa" chatbox

A natural-language operator for Stoa **itself** — a meta-agent whose tools are
Stoa's own data + operations, not the coding agents in the terminals. It's the
structural answer to the surface-area/discoverability problem the whole UI/UX
campaign kept circling: _ask, don't hunt_ — and it's the most mobile-native idea
on the board (type or dictate one request).

- **Settings — agent selector:** a setting to choose which agent backs the
  chatbox — **Claude / Codex / Hermes** (reuse the provider registry +
  `buildAgentArgs`; persist in settings; default to the latest Claude).
- **Phase 1 — "Ask Stoa" (read-only, build first):** Q&A over Stoa's own data —
  the audit ledger, transcripts, session statuses, cost — plus how-to. Low risk
  (no mutation), doubles as in-app help. _e.g. "what did the fleet do yesterday
  across all sessions?", "which sessions are stuck on me?"_
- **Phase 2 — "Command Stoa" (act, later):** NL → Stoa ops (spawn / dispatch /
  worktree) via the existing `stoa` MCP tool surface, always **propose → confirm
  → execute**, fail-closed + audited. _e.g. "start 3 sessions on the-grid:
  x1 hermes / x2 claude / x3 codex."_

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
