# Stoa

**Stoa is a self-hosted cockpit for running AI coding agents in real terminals — from any browser, including your phone.**

Point it at a repo, pick an agent (Claude Code, Codex, Hermes, Kilo Code, or Kimi Code), and Stoa spawns a real terminal session you can watch stream live, steer, and reconnect to from anywhere on your network. It runs **natively on Windows, macOS, and Linux** — no WSL or tmux required on Windows — and your sessions keep running even after you close the tab.

It's built for the way agents actually work: run several side by side from a mobile-first UI — with a **worktree-conflict warning** when two live sessions share a checkout and could overwrite each other's edits. Open many repos at once as a **multi-repo workspace** (one session, a worktree per sub-repo) with a session-scoped Git panel. Compose pipelines in the **visual workflow builder** (drag-and-drop DAG canvas, saved and reloadable). Drive Stoa itself in plain language with the **Ask / Command Stoa** chatbox. Let your agents coordinate through a **shared fleet memory** — a key→value scratchpad they read and write over MCP (and a plain `/api/memory` route) to pass interface contracts and gotchas across worktrees — and a shared markdown **Notes** knowledge base you edit in a dialog and your agents read/write over the same endpoint, plus **inter-agent channels** for direct 1:1 messages between sessions (pull by default; opt-in to inject a message into the recipient's terminal at its next turn boundary). Put the fleet on a clock with the **scheduler** — fire a prompt into a session once or hourly/daily/weekly (a nightly test run, a scheduled summary), enqueued so it lands at the session's next idle turn. Watch every agent at once on the **live wall** — a read-only grid of their terminals, streamed over the same WebSockets the panes use (no polling), on the native pty backend. Turn team conventions into one-keystroke **commands** — author a slash command in the UI and Stoa writes it to the agent's native command dir (`~/.claude/commands/`) so it becomes a real `/name` its terminal autocompletes. Branch any agent's conversation with **fork** — Claude forks **natively** (the full history), and every other agent forks via a **scrollback fallback** that seeds a fresh session with the parent's recent transcript as a "continue from here" prompt. Find any Claude session by what its agent actually said with **cross-session output search** (⌘K → Output) — "which of my agents hit a `TypeError`?" (Claude transcripts today — the only transcript Stoa reads; other providers as their transcript readers land). And — when you're ready to scale past hands-on — let **Dispatch** turn GitHub issues into reviewed, merged PRs autonomously: the fleet reviews its own PRs (a 3-critic gate), lands them (a self-rebasing merge train), splits a spec into conflict-free parallel tasks, verifies its changes, and learns from every review. An opt-in **self-healing watchdog** keeps an unattended run from dying quietly — it reaps a hung worker that would otherwise pin a concurrency slot forever, and pages you when a session wedges (spinner never settles). Opt-in **rate-limit auto-resume** picks a parked session back up the moment its limit resets — capped per-day and skipped while a session is still working, so it stays safe overnight. Keep an eye on the bill with **persisted spend tracking** — an estimated token cost per session (tinted against per-session budget caps), now sampled into a durable daily history so the spend sparkline survives a session being deleted or its transcript scrolling off (it accrues whenever the cost badge is open, or unattended with `STOA_AUTO_COST_SAMPLE=1`). And because phones drop connections, an **offline queue** stashes a prompt you send in a dead spot on-device and replays it the moment you're back online — de-duplicated on replay, so a flaky reconnect doesn't double-send.

For a plain-English tour of every feature, open the **Guide** (the compass icon in the sidebar) once Stoa is running.

## Installation

> **Heads-up:** Stoa isn't published to npm yet, so `npm install -g @johnisag/stoa`
> won't work — use one of the methods below (they clone the repo). npm
> distribution is planned.

### Quick install (curl)

Installs prerequisites, clones the repo, installs dependencies, builds for
production, and links the `stoa` command:

```bash
curl -fsSL https://raw.githubusercontent.com/johnisag/stoa/main/scripts/install.sh | bash
stoa start
```

### Manual install

```bash
git clone https://github.com/johnisag/stoa
cd stoa
npm install --include=dev --legacy-peer-deps
npm run build
npm start  # http://localhost:3011
```

### Windows (native)

Stoa runs natively on Windows — no WSL or tmux required.

Requires Node.js 24+ and Git. Install them via [winget](https://learn.microsoft.com/windows/package-manager/winget/) if needed:

```powershell
winget install OpenJS.NodeJS.LTS
winget install Git.Git
```

Then clone and run:

```powershell
git clone https://github.com/johnisag/stoa
cd stoa
npm install --include=dev --legacy-peer-deps
npm run build
npm start  # or: stoa start
```

Or use the PowerShell installer:

```powershell
irm https://raw.githubusercontent.com/johnisag/stoa/main/scripts/install.ps1 | iex
```

On Windows the native pty backend is selected automatically (no tmux/WSL needed). Set `STOA_BACKEND=tmux|pty` to override the choice on any platform.

> **Session persistence:** Sessions survive browser disconnects everywhere. The
> underlying terminal process also survives a Stoa server restart — via tmux on
> macOS/Linux, and via the Tier-2 pty-host daemon (default-on) on Windows.
> Agent-level resume after restart is guaranteed for Claude (its resume id is
> read from on-disk project files). For Hermes and Kimi Code the resume id is
> captured from the startup banner and is lost once the banner scrolls off, so
> re-attached sessions may resume as fresh conversations if the banner was not
> captured before the restart. If the daemon is unavailable, Windows falls back
> to Tier-1 (in-process), where sessions survive disconnects but not a server
> restart.

### Prerequisites

- Node.js 24+
- tmux (macOS/Linux only — Windows uses the native pty backend)
- [ripgrep](https://github.com/BurntSushi/ripgrep) (for code search - auto-installed by installer script, or run `stoa update`)
- At least one AI CLI: [Claude Code](https://github.com/anthropics/claude-code), [Codex](https://github.com/openai/codex), Hermes, [Kilo Code](https://github.com/Kilo-Org/kilocode), or [Kimi Code](https://github.com/MoonshotAI/kimi-code)

## Supported Agents

| Agent       | Resume | Fork          | Auto-Approve                                 |
| ----------- | ------ | ------------- | -------------------------------------------- |
| Claude Code | ✅     | ✅ native     | `--dangerously-skip-permissions`             |
| Codex       | ❌     | ✅ scrollback | `--dangerously-bypass-approvals-and-sandbox` |
| Hermes      | ✅     | ✅ scrollback | `--yolo`                                     |
| Kilo Code   | ❌     | ✅ scrollback | —                                            |
| Kimi Code   | ✅     | ✅ scrollback | `--yolo`                                     |

_**Resume**/**Fork** reflect what Stoa manages per session, not the CLI's raw
capability. **Fork** branches a conversation: Claude does it **natively**
(`--fork-session`, the full history); every other agent forks via a
**scrollback** fallback — a fresh session seeded with the parent's recent
terminal transcript as a "continue from here" prompt (#11). **Auto-Approve** is the
flag Stoa passes when you enable "skip permissions". Hermes resume works by
capturing its session id from the startup banner. Codex resume and its native
`codex fork` subcommand (today Codex forks via the scrollback fallback) are
planned — see [docs/ROADMAP.md](docs/ROADMAP.md). **Kimi Code**
resume works by capturing its session id from its startup banner, exactly like
Hermes. **Kilo Code** launches as a real terminal session like any other agent;
its per-session resume capture is a follow-up._

## CLI Commands

```bash
stoa run       # Start and open browser
stoa start     # Start in background
stoa stop      # Stop server
stoa status    # Show URLs
stoa logs      # Tail logs
stoa update    # Update to latest
stoa doctor    # Preflight checks (Node, port, build, agents) with fix hints
```

`stoa doctor` is a quick environment preflight — it verifies your Node version,
that port 3011 is free (or Stoa is already running on it), the production build
and dependencies are present, and at least one agent CLI is installed, printing an
actionable hint for anything wrong. It exits non-zero if a hard requirement fails,
so it doubles as an install/CI gate.

## Updating

```bash
stoa update
```

Stops the server (if running), pulls the latest `main`, reinstalls dependencies,
rebuilds, and restarts after the production build artifacts are verified. It
pins to `main`; if an update fails, it refuses to start from an incomplete build.

## Mobile Access

Use [Tailscale](https://tailscale.com) for secure access from your phone:

1. Install Tailscale on your dev machine and phone
2. Sign in with the same account
3. Access `http://100.x.x.x:3011` from your phone

## Documentation

See [AGENTS.md](AGENTS.md) for the architecture and contributor principles, and
[docs/](docs/) for setup notes and known issues.

## License

MIT License - Free and open source. See [LICENSE](LICENSE) for full terms.

Stoa is a fork of the original AgentOS project; the upstream copyright is
retained in [LICENSE](LICENSE) per the MIT terms.
