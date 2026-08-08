# Stoa

**Stoa is a self-hosted cockpit for running AI coding agents in real terminals — from any browser, including your phone.**

Point it at a repo, pick an agent, and Stoa spawns a live terminal session you can watch, steer, and reconnect to from anywhere on your network. It runs **natively on Windows, macOS, and Linux** — no WSL or tmux required on Windows — and your sessions keep running after you close the tab.

The in-app **Guide** (compass icon in the sidebar) gives a plain-English tour of every feature.

## Features

- **Live wall** — watch every agent's terminal at once in a read-only WebSocket grid.
- **Agent Monitor** — htop-style view of status, model, context %, tokens, and cost, sorted by who needs attention.
- **Multi-repo workspace** — open many repos as one session with worktrees and a session-scoped Git panel.
- **Fork & search** — branch any conversation; find sessions by what the agent actually said (Claude transcripts today).
- **Fleet coordination** — shared memory, notes, and direct inter-agent messages across sessions.
- **Automation** — visual workflow builder, GitHub dispatch, scheduler, custom slash commands, Ask / Command Stoa, and Best-of-N runs.
- **Unattended ops** — self-healing watchdog, rate-limit auto-resume, spend tracking with budget caps, and an offline prompt queue.
- **Cross-platform** — native pty backend on Windows, tmux on macOS/Linux; `STOA_BACKEND=tmux|pty` overrides.

## Installation

> Stoa is not on npm yet. Use one of the methods below; `npm install -g @johnisag/stoa` will not work.

### Quick install (curl)

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

Requires Node.js 24+ and Git. Install via winget:

```powershell
winget install OpenJS.NodeJS.LTS
winget install Git.Git
```

Then:

```powershell
git clone https://github.com/johnisag/stoa
cd stoa
npm install --include=dev --legacy-peer-deps
npm run build
npm start
```

Or run the PowerShell installer:

```powershell
irm https://raw.githubusercontent.com/johnisag/stoa/main/scripts/install.ps1 | iex
```

Sessions survive browser disconnects everywhere. The underlying process also survives a server restart: via tmux on macOS/Linux, and via the Tier-2 pty-host daemon on Windows. If the daemon is unavailable, Windows falls back to Tier-1 (in-process), where sessions survive disconnects but not a server restart.

### Prerequisites

- Node.js 24+
- tmux (macOS/Linux only; Windows uses native pty)
- [ripgrep](https://github.com/BurntSushi/ripgrep) (for code search; auto-installed by the installer, or run `stoa update`)
- At least one agent CLI: [Claude Code](https://github.com/anthropics/claude-code), [Codex](https://github.com/openai/codex), Hermes, [Kilo Code](https://github.com/Kilo-Org/kilocode), or [Kimi Code](https://github.com/MoonshotAI/kimi-code)

## Supported Agents

| Agent       | Resume | Fork          | Auto-approve flag                            |
| ----------- | ------ | ------------- | -------------------------------------------- |
| Claude Code | ✅     | ✅ native     | `--dangerously-skip-permissions`             |
| Codex       | ❌     | ✅ scrollback | `--dangerously-bypass-approvals-and-sandbox` |
| Hermes      | ✅     | ✅ scrollback | `--yolo`                                     |
| Kilo Code   | ❌     | ✅ scrollback | —                                            |
| Kimi Code   | ✅     | ✅ scrollback | `--yolo`                                     |

**Resume**/**Fork** reflect what Stoa manages per session. **Fork** branches a conversation: Claude does it natively (`--fork-session`, full history); other agents use a scrollback fallback — a fresh session seeded with the parent's recent transcript. **Auto-approve** is the flag Stoa passes when you enable "skip permissions". Codex native fork is planned; see [docs/ROADMAP.md](docs/ROADMAP.md).

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

`stoa doctor` verifies your Node version, port 3011, build, dependencies, and at least one installed agent CLI, exiting non-zero for hard failures.

## Updating

```bash
stoa update
```

Stops the server, pulls latest `main`, reinstalls, rebuilds, and restarts after verifying production artifacts. It refuses to start from an incomplete build.

Track the latest immutable release tag instead of `main`:

```bash
stoa update --channel release
```

Return to `main` with `stoa update --channel main`. The piped installers accept the same opt-in: `STOA_CHANNEL=release curl -fsSL ... | bash`.

## Mobile Access

Use [Tailscale](https://tailscale.com):

1. Install Tailscale on your dev machine and phone
2. Sign in with the same account
3. Open `http://100.x.x.x:3011` from your phone

## Documentation

- [AGENTS.md](AGENTS.md) — architecture and contributor principles
- [docs/setup/README.md](docs/setup/README.md) — detailed setup notes
- [docs/ROADMAP.md](docs/ROADMAP.md) — what's coming next

## License

MIT License — see [LICENSE](LICENSE). Stoa is a fork of the original AgentOS project; the upstream copyright is retained in [LICENSE](LICENSE) per the MIT terms.
