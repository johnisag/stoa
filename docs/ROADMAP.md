# Stoa — Roadmap

Stoa is a **mobile-first, self-hosted web UI for running AI coding agents
(Claude Code, Codex, Hermes) in real terminals — native on Windows, macOS, and
Linux.** The native-Windows migration, the `PtyTransport` unification, the Stoa
rename, and the green 3-OS CI matrix are all done; **Priority A (UI/UX) +
Priority B (Performance)** shipped; and the **entire round-1 competitive scan —
the WS-events milestone, the security trio, actionable push, and cost &
governance — has now shipped (PRs #55–#91).**

The forward menu is the **🔭 competitive feature scan (round 2)** below — a fresh
5-segment web-research fan-out run against what Stoa already ships. Pick
deliberately. `D`=demand, `E`=effort, ⭐=differentiator for Stoa's angle.

**Round-2 update (2026-06-05):** the round-2 _flagship_ — the **review & rewind
layer** — has now **fully shipped** (Stages 1–3, PRs #93–#95), along with the
**prompt queue** (#96), **Dispatch / GitHub-issue ingestion** (#104 engine + #108
control-plane UI), and the **CRITICAL macOS scrollbar bug** (#98 + #106). See
"✅ Shipped since round 2" below; the remaining unbuilt horizons are re-ranked
under "🔭 Next horizons."

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

## ✅ Shipped since round 2 (PRs #93–#108)

- **The review & rewind layer — COMPLETE (the round-2 flagship)** — **Stage 1**
  session diff review, see exactly what the agent changed (#93); **Stage 2**
  per-turn snapshots + turn-history timeline, captured at each turn boundary as
  object-deduped shadow commits under `refs/stoa/snap/<sessionId>/<seq>` (#94);
  **Stage 3** rewind — restore the working tree to any snapshot, itself undoable
  via a safety snapshot (#95). One substrate, both flagship features.
- **Prompt queue** (#96) — line up the next tasks while an agent works; dispatch
  follow-ups in order on idle, no interrupt. The top "async cockpit" item.
- **Dispatch — GitHub issue → agent fleet** — the **engine** (#104, issue→fleet
  reconciler) + the **control-plane UI** (#108, allocation console + backlog +
  in-flight board). Covers "issue-tracker ingestion" and the server-side
  fire-and-forget dispatch path.
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

### ▶ NEXT BIG FEATURE — Independent reviewer-agent gate ⭐ _(D:high · E:M)_

**A fresh critic session that sees only the spec + the diff and returns
PASS / structured violations — blocking merge, with FAIL routed to an actionable
push.** This is the machine half of the review-bottleneck thesis: human review
just shipped (#93–95), so the next leverage is automating the first pass.
"Self-review is compromised" is cross-segment consensus. It's the **cheapest big
orchestration win** because a reviewer is just another spawned worker role — it
stacks directly on what already ships: the session diff (#93), the
conductor→worker spawn seam, and actionable approve/reject push (#90/#91).
_Where:_ spawn a reviewer worker with a locked prompt (spec + `getSessionDiff`
output, no repo write); parse its PASS/violations into a structured verdict;
gate the existing "approve & merge" path on it; FAIL → push with the violations.
_Risk:_ keep the critic read-only (no tools that mutate the tree); cross-platform
git via `execFile` (no shell); don't let a flaky critic hard-block — make the
gate advisory-with-override first, enforcing later.

### Async cockpit (lowest-effort; compounds the shipped push + mobile)

- [ ] **Prompt queue — type the next tasks while it works** ⭐ _(D:high · E:M)_ —
  dispatch follow-ups in order on idle, no interrupt (claude-code #50246 = 68
  reactions, closed "not planned" upstream → wrapper-shaped). Stoa owns stdin + the
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
- [ ] **Command audit log — "what did the agent run"** ⭐ _(D:high · E:M)_ — a
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

- [ ] **Independent reviewer-agent gate** ⭐ _(D:high · E:M)_ — a fresh critic
  session sees only spec + diff, returns PASS / structured violations; blocks merge,
  FAIL → actionable push. "Self-review is compromised" is consensus. Cheapest big
  win: a reviewer is just another spawned worker role.
- [ ] **Agent merge queue — safe landing** ⭐ _(D:high · E:L)_ — serialize each
  worker's branch onto `main`, run the combined test suite, auto-rebase-and-retry,
  merge only if green. The endgame for a conductor that fans out N branches (today
  the human lands them by hand).
- [ ] **Issue-tracker ingestion (GitHub Issues first)** ⭐ _(D:high · E:M)_ — pull a
  ticket → spawn a worker with its context → PR/status back. The feature Emdash
  wins deals on; cheap via `gh` (already the sanctioned CLI); "triage your backlog
  and dispatch the fleet from your phone."

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
  _(P:med · E:S)_ — one unhandled throw in the Tier-2 daemon kills every live
  session; add per-connection keep-alive + `it.retry` on the node-pty spawn specs.
- [ ] **Lock the untested Tier-2 lifecycle contracts** _(P:med · E:M)_ — exit-over-IPC,
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
