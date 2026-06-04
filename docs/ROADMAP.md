# Stoa — Roadmap

Stoa is a **mobile-first, self-hosted web UI for running AI coding agents
(Claude Code, Codex, Hermes) in real terminals — native on Windows, macOS, and
Linux.** The native-Windows migration, the `PtyTransport` unification, the Stoa
rename, and the green 3-OS CI matrix are all done; **Priority A (UI/UX) +
Priority B (Performance)** shipped; and the entire **2026-06 opportunity scan,
the WS-events milestone, and the security trio** have now shipped (PRs #55–#86).

The forward menu is the **🔭 competitive feature scan** below — from a 5-segment
web-research fan-out (similar products + community demand), ranked against what
Stoa already ships. Pick deliberately. `D`=demand, `E`=effort, ⭐=differentiator
for Stoa's angle.

---

## ✅ Shipped since the last scan (PRs #55–#86)

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

## 🔭 Next horizons — competitive feature scan (2026-06)

5-segment web research — agent IDEs (Cursor, Devin, OpenHands, Cline, Conductor,
Vibe Kanban, Crystal, Sculptor, Factory, Jules…), web/remote terminals,
mobile remote-control (Omnara, Happy, Terragon…), multi-agent orchestration,
and community demand (HN / Reddit / GitHub issues) — synthesized against Stoa's
shipped features. Ordered by leverage.

### ▶ NEXT BIG FEATURE — Actionable push notifications ⭐ _(D:high · E:M)_

**Approve / reject / reply / kill an agent straight from the lock-screen
notification — no app open.** The #1 ask across ALL FIVE research segments
(Claude Code issues #25115 / #9878 / #6454 / #29928; Omnara, Happy, Agent-Approve
are whole products built on it) — and **Stoa is one edit from owning it.** We
already ship the hard 80%: the `/ws/events` live channel, server-authoritative
"waiting on input" status from the rendered VT, the send-keys seam, and Web Push
(SW + VAPID). The missing 20% is additive: add `actions[]` to the
`showNotification` payload (`app/sw.ts` only focuses the window today) and route
`notificationclick` actions back through the send-keys seam. Turns the passive
"a session needs you" ping into the active loop that Omnara / Happy / Anthropic
Remote Control gate behind native apps and $100–200/mo — delivered self-hosted,
provider-agnostic, and **on Windows** where the official tooling doesn't run.
_Where:_ app/sw.ts (notification actions), a small `/api/sessions/[id]/respond`
seam over send-keys, server-side push payload. _Risk:_ additive; reuses shipped
Web Push + status + send-keys.

### Mobile remote-control loop (the signature angle)

- [ ] **Mobile kill switch** ⭐ _(D:high · E:S)_ — one-tap stop a drifting run from
  the card AND the notification; reuses the #71 authoritative kill. "Stop a run
  before it wastes more time" ranks among the highest-leverage phone workflows.
- [ ] **Glanceable quick-action card chrome** ⭐ _(D:high · E:S)_ — per-card
  reply/approve/kill so the board is mission-control, not just a viewer (board +
  preview + `/ws/events` already there).

### Cost & governance (the loudest unclaimed surface)

- [ ] **Per-session token/cost tracking + a fleet total** ⭐ _(D:high · E:M)_ —
  runaway-spend horror stories ($8k–$47k single runs); "htop for AI costs." Stoa
  owns the pty/session layer and knows which agent ran what → attribute cost per
  session/worker on the board (parse usage output or estimate tokens). Confirmed
  absent today.
- [ ] **Budget caps — soft alert / hard pause-or-kill** ⭐ _(D:high · E:M)_ — $50
  soft / $100 hard is becoming standard practice; almost no parallel-agent tool
  enforces pre-spend. Pairs with cost tracking + the authoritative kill.

### Safe parallel autonomy (guardrails without approval fatigue)

- [ ] **Granular per-tool Allow / Ask / Deny auto-approve** ⭐ _(D:high · E:M)_ —
  today it's all-or-nothing YOLO per provider; users are "tired of Claude asking
  for everything" (~15 prompts to start) yet wary of blanket-skip. Auto-allow
  reads/edits, ask on bash/destructive; pairs with the notification-approve path.
- [ ] **Destructive-action guardrails** _(D:high · E:M)_ — pattern-match `rm -rf` /
  `drop db` / mass-delete off the rendered screen and require confirmation. Claims
  the "don't wipe your prod DB" high ground the self-hosted posture implies.

### Terminal-transport robustness (perceived speed + reliability on mobile)

- [ ] **Bulletproof reconnect UX** _(D:high · E:M)_ — heartbeat ping-pong,
  exponential backoff, a visible "Reconnecting…" + manual retry; closes the client
  replay loop over the already-persistent server pty (5G↔WiFi/sleep drop streams).
- [ ] **Mosh-style predictive local echo** ⭐ _(D:high · E:L)_ — client-side
  prediction over the existing WS; the biggest perceived-lag cure on a phone, a
  pure-frontend win (sshx ships this; xterm.js #887 is unsolved for most).

### Self-hosted collaboration

- [ ] **One-link shareable session (read-only or write)** ⭐ _(D:med · E:L)_ —
  sshx-grade live-session sharing on the user's own box, no cloud account; reuses
  the shipped token-auth + Origin allowlist, scoped to a single session. (Narrower,
  shipped-infra version of the deferred read-only transcript share.)

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
