# Stoa Setup Guide

This guide covers installing and running Stoa on your machine.

## Quick Install (Recommended)

Run this one-liner to install Stoa:

```bash
curl -fsSL https://raw.githubusercontent.com/johnisag/stoa/main/scripts/install.sh | bash
```

The installer will:

1. Download the `stoa` CLI to your PATH
2. Check for prerequisites (Node.js 20+, git, tmux) and offer to install any missing ones
3. Detect installed AI CLIs or prompt you to install one (Claude Code recommended)
4. Clone the repository to `~/.stoa/repo`
5. Install dependencies and build for production

## Manual Install

If you prefer to install manually:

```bash
# Clone the repository
git clone https://github.com/johnisag/stoa ~/.stoa/repo
cd ~/.stoa/repo

# Install dependencies
npm install

# Build for production
npm run build

# Start the server
npm start
```

## CLI Commands

After installation, use the `stoa` command to manage the server:

| Command          | Description                     |
| ---------------- | ------------------------------- |
| `stoa start`     | Start the server in background  |
| `stoa stop`      | Stop the server                 |
| `stoa restart`   | Restart the server              |
| `stoa status`    | Show status, PID, and URLs      |
| `stoa logs`      | Tail server logs                |
| `stoa update`    | Pull latest version and rebuild |
| `stoa enable`    | Enable auto-start on boot       |
| `stoa disable`   | Disable auto-start              |
| `stoa uninstall` | Remove Stoa completely          |

> On **Windows**, `enable` / `disable` / `uninstall` aren't part of the CLI — use
> the service scripts instead (see [Auto-Start on Boot](#auto-start-on-boot)).

## Prerequisites

The installer can automatically install these on macOS and Linux:

- **Node.js 20+** - JavaScript runtime
- **npm** - Package manager (comes with Node.js)
- **git** - Version control
- **tmux** - Terminal multiplexer for session management

### AI Coding CLIs

You need at least one AI coding CLI installed. The installer will prompt you to choose:

| CLI         | Provider  | Install Command                            |
| ----------- | --------- | ------------------------------------------ |
| Claude Code | Anthropic | `npm install -g @anthropic-ai/claude-code` |
| Codex       | OpenAI    | `npm install -g @openai/codex`             |
| Aider       | Multi-LLM | `pip install aider-chat`                   |
| Gemini CLI  | Google    | `npm install -g gemini-cli`                |

## Configuration

### Environment Variables

| Variable    | Default     | Description            |
| ----------- | ----------- | ---------------------- |
| `STOA_HOME` | `~/.stoa`   | Installation directory |
| `STOA_PORT` | `3011`      | Server port            |
| `DB_PATH`   | `./stoa.db` | SQLite database path   |

### Custom Port

```bash
# Start on a different port
STOA_PORT=8080 stoa start

# Or set permanently in your shell config
export STOA_PORT=8080
```

## Auto-Start on Boot

### macOS (launchd)

```bash
stoa enable
```

This creates a Launch Agent at `~/Library/LaunchAgents/com.stoa.plist`.

To disable:

```bash
stoa disable
```

### Linux (systemd)

```bash
stoa enable
```

This creates a user service at `~/.config/systemd/user/stoa.service`.

To disable:

```bash
stoa disable
```

### Windows (NSSM service)

Windows doesn't use `stoa enable`. Instead, register Stoa as a Windows **service**
with [NSSM](https://nssm.cc/) via the bundled script. It starts on boot/logon and
auto-restarts within seconds if the process ever stops or crashes.

```powershell
# Requires Chocolatey (the script installs NSSM through it if missing).
# Self-elevates with a UAC prompt.
powershell -ExecutionPolicy Bypass -File scripts\install-service.ps1

# Options:
#   -Port 3022   custom port (use one if you also run `npm run dev` on 3011)
#   -NoAuth      disable the access token (only behind a VPN — see below)
powershell -ExecutionPolicy Bypass -File scripts\install-service.ps1 -Port 3022 -NoAuth
```

Manage it with `nssm restart Stoa` / `nssm stop Stoa`, or via `services.msc`.
Logs go to `~/.stoa\service.out.log` and `service.err.log`.

> **`-NoAuth`** turns off the app-level token, so **anyone who can reach the port
> has full access**. Only use it when the port is reachable solely over a private
> network such as Tailscale.

## Mobile Access with Tailscale

Stoa is designed for mobile access. The easiest way to access it from your phone is with [Tailscale](https://tailscale.com):

1. **Install Tailscale on your machine:**

   ```bash
   # macOS
   brew install tailscale

   # Linux
   curl -fsSL https://tailscale.com/install.sh | sh
   ```

2. **Start Tailscale and authenticate:**

   ```bash
   sudo tailscale up
   ```

3. **Get your Tailscale IP:**

   ```bash
   tailscale ip -4
   # Example: 100.64.0.1
   ```

4. **Install Tailscale on your phone** (iOS App Store / Google Play)

5. **Sign in with the same account**

6. **Access Stoa:**
   ```
   http://100.64.0.1:3011
   ```

The `stoa status` command will show your Tailscale URL if Tailscale is installed.

## Directory Structure

```
~/.stoa/
├── repo/                # Cloned Stoa repository
├── stoa.pid             # PID file when running (CLI-managed)
├── logs/stoa.log        # Server logs (stoa start / stoa run)
├── service.out.log      # NSSM service stdout (Windows service only)
└── service.err.log      # NSSM service stderr (Windows service only)
```

## Updating

```bash
stoa update
```

This will:

1. Stop the server if running
2. Pull the latest changes from git
3. Install any new dependencies
4. Rebuild for production
5. Restart the server if it was running

On **Windows with the NSSM service**, use the paired script instead — `stoa update`
alone won't restart the service (it isn't tracked by Stoa's pid file), and rebuilding
while the service holds files open can fail with lock errors:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\update-service.ps1
```

It stops the service, runs the update + rebuild, then restarts it.

On **macOS/Linux** this is automatic: if you ran `stoa enable`, `stoa update` is
service-aware and restarts the launchd/systemd service through its manager (no
separate script needed).

## Troubleshooting

### Server won't start

Check the logs:

```bash
stoa logs
```

Common issues:

- Port already in use: Change `STOA_PORT`
- Missing dependencies: Run `stoa install` again
- Node.js version: Ensure Node.js 20+ is installed

### Can't connect from phone

1. Ensure both devices are on the same Tailscale network
2. Check `stoa status` for the correct URL
3. Verify the server is running: `stoa status`
4. Check firewall settings if not using Tailscale

### Build fails

Try a clean reinstall:

```bash
stoa stop
rm -rf ~/.stoa/repo/node_modules
rm -rf ~/.stoa/repo/.next
stoa install
```

## Uninstalling

```bash
stoa uninstall
```

This removes:

- The `~/.stoa` directory
- Auto-start configuration (launchd/systemd)

The `stoa` CLI script itself is not removed. Delete it manually:

```bash
rm $(which stoa)
```
