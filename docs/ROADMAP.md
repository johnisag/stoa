# Stoa — Roadmap

Stoa is a **mobile-first, self-hosted web UI for running AI coding agents
(Claude Code, Codex, Hermes) in real terminals — native on Windows, macOS, and
Linux.**

**Status (2026-06-12):** the roadmap was reset to a clean slate and repopulated
from a deep UI/UX analysis. **Stoa is in test + bug-fix mode** — the **Fixes &
issues** below are fair game now; the **usability / advancements** are queued for
when the feature freeze lifts.

> **How this was generated:** a multi-agent research pass (36 agents) — a
> surface-map scout → 3 analysis lenses (UI · UX · mobile/a11y) reading the real
> components → every candidate **adversarially verified against the code**
> (anything already solved was dropped) → synthesis → a completeness critic.
> **30 candidates → 26 verified → 21 ranked items** (14 synthesized + 7 from the
> critic). Each carries `category · value/effort` (1-5) and a file pointer.
>
> **The recurring theme:** the _"render verdicts from anywhere (incl. a phone)"_
> half of the product is under-surfaced on mobile, and several tinted surfaces
> are dark-mode-only and wash out in the **default light** theme.

---

## 🔥 Tier 1 — high priority

### Fixes — shippable now (bug-fix mode)

- **Light-mode-illegible verification log** · `fix · V2/E1` —
  `VerdictInboxView/InboxCard.tsx:265` + `DispatchView/InFlightBoard.tsx:223` use
  a hardcoded `bg-black/20` pre block; muddy / low-contrast on the default light
  themes. → swap to `bg-muted` / `bg-muted/50`. _One line, two sites — the
  highest-leverage fix in the batch._
- **One-tap merge has no confirmation** · `issue · V4/E2` — `InboxCard.tsx:274`
  merge + `InFlightBoard.tsx:252` `doMerge` land a PR with a single tap; every
  other destructive action uses `useConfirm`. → gate both behind the existing
  confirm dialog. (Merge is still `canMerge`-gated — this is guardrail
  consistency, not a hole.)

### Mobile reachability — the headline surface

- **Compose modal hides behind the on-screen keyboard** · `issue · V5/E3` —
  `PromptQueueModal.tsx:139` is `fixed inset-0` (100vh), not visualViewport-
  tracked, so the Send button drops below the keyboard. The fix already exists
  in-repo (`h-app` / `--app-height`, the `sheet` dialog variant). → make the
  overlay track the visual viewport. _This is THE mobile long-prompt affordance —
  fix first._
- **Notification / sound / web-push settings are desktop-only** · `issue · V4/E3`
  — `NotificationSettings` renders only in the desktop header; `MobileView` never
  mounts it, so on a phone you can't enable sound, pick events, grant permission,
  or subscribe to push — the channel that makes mobile monitoring viable. →
  render it in `MobileView` (as a sheet).
- **Review surfaces aren't on mobile's one-tap bar** · `usability · V4/E2` —
  Dispatch + Workflows were promoted to `MobileTabBar`, but Verdict Inbox + Fleet
  Board are swipe-drawer-only. → add a one-tap Verdict Inbox via the proven
  `onDispatchClick` plumbing (pair with the badge below).

### "Needs me" never surfaces ambiently

- **No "needs me" badge on the Verdict Inbox / Fleet Board nav** · `issue · V5/E3`
  — the count data exists (`needsMe`, `attentionCount`) and the session list
  already shows an amber pill, but the review nav icons show nothing; a user with
  3 PRs waiting has no signal. → shared selector + a lightweight always-on count
  + an amber badge on both `DesktopView` and `SidebarFooter`.
- **Fleet cards link only to the PR — no jump to the live agent** · `usability ·
  V5/E3` — when a card is `stuck` / `CHANGES_REQUESTED`, you're told it needs you
  but given no in-app path to the session / worktree terminal to unblock it. →
  add an "Open session / Attach" action (pass `onOpenSession` down from
  `page.tsx`).
- **Fleet views don't cross-link** · `usability · V4/E2` — Dispatch / Inbox /
  Board / Workflows are mutually-exclusive dialogs; the natural "dispatch →
  review" loop forces close-and-reopen. → add cross-links (the open-setters are
  already in `ViewProps`).

### Nav consistency

- **Desktop nav + mobile footer are duplicated and already drifting** ·
  `usability · V4/E3` — the same five fleet destinations are reimplemented in
  `DesktopView` and `SidebarFooter` with diverged aria-labels and entries; no
  shared component. → extract a `FLEET_NAV` descriptor + a `NavIconButton`,
  consume in both. _Unlocks the overflow-menu, keyboard-shortcut, and badge items
  below — sequence first._

---

## 🎯 Tier 2 — medium priority

- **Dark-only colors wash out in light mode** · `issue · V3/E1` — AnalyticsView
  `IssueRow` (`text-red-300` / `text-yellow-200`, `index.tsx:575`) and the
  `SessionCard` PR badge (`text-green-400` / `-purple-400` / `-red-400`, 583-586)
  skip the `dark:` guard. → adopt the repo's `text-X-600 dark:text-X-400`
  convention. _Two quick fixes._
- **No keyboard shortcut opens any fleet view** · `advancement · V3/E2` —
  `NAV_KEYBINDINGS` wires 13 chords but none for Dispatch / Workflows / Inbox /
  Board / Insight. → add 5 bindings (auto-documented in the cheatsheet) + dispatch
  branches.
- **QuickSwitcher (⌘K) can't open fleet views or run commands** · `advancement ·
  V3/E3` — only sessions / files. → add a commands lane reusing the existing
  fuzzy search.
- **Error states say "Retrying…" with no manual retry / feedback** · `usability ·
  V2/E2` — Inbox / Board show a dead red line. → mirror SessionList's AlertCircle
  + Retry button + Loader2 (expose `refetch` / `isFetching`).
- **ConductorPanel empty state is a dead-end** · `usability · V3/E2` — "use the
  MCP tools or API" with no affordance. → at least a Copy-conductor-id button + a
  help link.
- **Workflow runs / workers are observe-only** · `usability · V3/E3` — a finished
  run / worker offers no jump to its session / branch / PR. → add "Open session /
  View PR" on completion.
- **Git diff is stage / unstage-only** · `usability · V3/E4` — no discard / revert
  of a hunk or file, and no commit→PR next step. → per-file/hunk discard
  (confirm-gated) + a post-commit "Create PR" affordance.
- **Desktop header: 8 icons, no responsive collapse** · `usability · V3/E3` —
  narrow / split-screen collapses the session name (now truncated as of #213). →
  an overflow "…" menu below a breakpoint (renders from `FLEET_NAV`).
- **Mobile tab bar packs 8-9 controls** · `issue · V3/E3` — collapses the name on
  a 360px phone. → fold Dispatch / Workflows / Compose into the menu, or move the
  view-mode toggles to a second row.

---

## 🧹 Tier 3 — simplifications & onboarding

- **Two segmented-control tab strips reimplemented 5×** · `simplification · V2/E2`
  — Dispatch / Inbox / Workflows / Analytics + a file-private one in
  `AllocationConsole`. → extract `<SegmentedTabs>` into `components/ui/` (carry
  AnalyticsView's `role=tablist` + touch-target baseline).
- **First-run empty state only offers "New Project"** · `usability · V2/E2` — a
  new user is never pointed at creating a session; "No sessions yet" has no button
  (worse on mobile, which lacks a header New-Session button). → an inline "New
  session" in the empty project body.

---

## 🅿️ Parked — features on hold (no new features for now)

### Deferred fixes (small, ready when we are)

- **Per-attach generation guard** — drop a superseded in-flight `error` / `exit`
  WS frame from a rapid A→B→C session switch (a sub-second race; both frame types
  share it). Surfaced in the #211 review.
- **Editable approval command** — let the user edit a proposed command before
  approving it in the auto-steer escalation. The last small-big item; touches the
  sensitive auto-steer core (V3/E4), needs a focused pass with tests.

### 💬 Big bet — "Ask / Command Stoa" (a natural-language operator)

A meta-agent whose tools are Stoa's **own** operations (not the coding agents in
the terminals). Directly attacks the surface-area / discoverability problem the
fixes above keep circling — _ask, don't hunt_ — and is maximally on-brand for
mobile (type or dictate one request).

- **Phase 1 — "Ask Stoa" (read-only):** Q&A over the audit ledger + transcripts +
  statuses + cost, plus how-to. Low risk; doubles as in-app help. _e.g. "what did
  the fleet do yesterday?", "which sessions are stuck on me?"_
- **Phase 2 — "Command Stoa" (act):** NL → Stoa ops (spawn / dispatch / worktree)
  via the existing `stoa` MCP tool surface, always **propose → confirm →
  execute**, fail-closed + audited. _e.g. "start 3 sessions on the-grid: x1
  hermes / x2 claude / x3 codex."_

### Bigger bets (full features — salvaged from the retired must-have.md / small-big.md)

- **Plan-approve-execute gate** — a worker emits an editable plan first;
  approve / redirect from the phone before any code is written.
- **Best-of-N + side-by-side compare** — one task to N workers (different
  model / run), compare diffs, keep one.
- **Visual verification artifacts** — UI workers drive the app in a real browser
  (Playwright), attach screenshots / video to the verdict + PR.
- **Generalized intake — webhooks** — inbound CI / Sentry / generic events → saved
  task templates.
- **Warm worktree bootstrap** — per-repo setup + dependency-cache reuse so a fresh
  worktree starts ready.
- **Task playbooks** — saved parameterized recipes ("bump dep {X} and fix
  breakage"), one-tap dispatch.
- **Hot-swap manual QA** — one dev server at the repo root; hot-swap any worker's
  worktree into it on demand.
- **One-tap structured mobile approvals** — escalated permission prompts as
  Allow / Deny tap targets + push actions.
- **Maintainer v2** — auto-dispatch + deploy / monitor / self-heal (the autonomous
  fleet's next arc).

---

_History: the PART-0/1/2 campaigns, the small-big QoL campaign (#205–#209), the
autonomous maintainer (#203 / #204), and the recent UX fixes (#210–#213) live in
git history; the prior roadmap's shipped log was retired with this reset._
