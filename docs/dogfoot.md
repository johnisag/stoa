# Dogfooding Stoa

How to run Stoa "for real" on a machine — a long-lived server that serves your
phone/laptop over your private network, auto-starts on boot, auto-restarts on
crash, and updates with one command — **while you keep developing Stoa in a
separate checkout.**

This is the reproducible per-machine runbook. Repeat it on each machine you want
to host an instance. Each machine is **independent**: its own checkout, its own
database, its own port. (SQLite isn't shared across machines, so two hosts do not
see each other's sessions.)

---

## The model: dev checkout vs. install

Keep two copies of the repo, with different jobs:

|                           | **Dev checkout**                   | **Install**                                   |
| ------------------------- | ---------------------------------- | --------------------------------------------- |
| Path                      | wherever you clone for development | `~/.stoa/repo` (the installer's location)     |
| Role                      | edit, build, test, commit, merge   | runs the server that serves your devices      |
| You open it in an editor? | yes                                | **never** — hands-off                         |
| How it changes            | by editing                         | only by `stoa update` (pulls reviewed `main`) |

**Why separate?** If you develop in the same directory the server runs from,
every `npm run build` overwrites the `.next` the running server serves — your
phone can get half-built, broken assets mid-edit — and your scratch/test runs
share the live database. The install is the deployed copy; the dev checkout is
where you work. This separation is what makes "use Stoa on your phone _while_
building Stoa" actually work.

The **database** lives in `~/.stoa/stoa.db` **by default** (in `STOA_HOME`, beside
`token` and `vapid.json`), not inside either checkout — so a re-clone or
`git reset` of the install can never destroy your data. You don't need to set
`DB_PATH`; override it only to relocate the DB (a leading `~` is expanded).

---

## Prerequisites

- **Node.js 24+** and **Git** (the installer checks both).
- **[Tailscale](https://tailscale.com/)** (or any private network) if you want
  to reach the server from other devices. The tailnet authenticates devices at
  the network layer, which lets us run token-free over it (below).

---

## 1. Install

Run the one-liner for your OS. It clones to `~/.stoa/repo`, installs
dependencies, and builds for production.

**Windows (PowerShell):**

```powershell
irm https://raw.githubusercontent.com/johnisag/stoa/main/scripts/install.ps1 | iex
```

**macOS / Linux:**

```bash
curl -fsSL https://raw.githubusercontent.com/johnisag/stoa/main/scripts/install.sh | bash
```

> If `npm run build` is interrupted it can leave an incomplete `.next` (a missing
> `prerender-manifest.json`), and the server then crash-loops on start. If that
> happens, rebuild: `cd ~/.stoa/repo && npm run build`, and confirm
> `.next/prerender-manifest.json` exists.

## 2. Put `stoa` on your PATH

So `stoa start` / `stoa update` work from any directory and always target this
install:

```bash
cd ~/.stoa/repo
npm link
```

**Windows only:** npm's `stoa.ps1` shim is blocked by the default PowerShell
execution policy. Allow locally-created scripts (one time, per user):

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

Verify it resolves to the install:

```bash
stoa status     # should print "Install: <home>/.stoa/repo"
```

## 3. Configure the install

Create `~/.stoa/repo/.env`:

```dotenv
# Port the server listens on (pick one; 3011 is the default)
STOA_PORT=3011
PORT=3011

# Database — OPTIONAL. Defaults to ~/.stoa/stoa.db (STOA_HOME), outside the repo,
# so a re-clone/reset can't destroy data. Set only to relocate it (~ is expanded).
# DB_PATH=~/.stoa/stoa.db

# Token-free access over the Tailscale tailnet (devices are authenticated at the
# network layer). A non-tailnet LAN/Wi-Fi device still needs the token. Omit this
# line to require the token everywhere.
STOA_TRUST_TAILSCALE=1
```

> The `stoa` CLI reads this `.env`. On **Windows**, the auto-restart launcher
> (step 4) runs `node` directly and **bypasses `.env`**, so it must set the same
> values inline — they're included in the launcher template below.

## 4. Auto-start + auto-restart (keep-alive supervisor)

Pick the section for your OS. Each one runs the server at login and respawns it
if it exits.

### Windows — auto-restart `.cmd` loop + hidden Startup launcher

Create `~/.stoa/run-stoa.cmd` (replace `you` / port as needed):

```bat
@echo off
rem Stoa server launcher — auto-restart loop, started hidden at logon by the
rem Startup-folder shortcut. Runs the INSTALL clone (not a dev tree).
setlocal
cd /d "C:\Users\you\.stoa\repo"
set "PORT=3011"
set "NODE_ENV=production"
set "DB_PATH=C:\Users\you\.stoa\stoa.db"
set "STOA_TRUST_TAILSCALE=1"
if not exist "C:\Users\you\.stoa\logs" mkdir "C:\Users\you\.stoa\logs"
:loop
echo [%date% %time%] starting stoa >> "C:\Users\you\.stoa\logs\stoa.out.log"
rem Run via tsx's public CLI entry (stable across tsx versions).
node "C:\Users\you\.stoa\repo\node_modules\tsx\dist\cli.mjs" server.ts >> "C:\Users\you\.stoa\logs\stoa.out.log" 2>> "C:\Users\you\.stoa\logs\stoa.err.log"
echo [%date% %time%] stoa exited (code %errorlevel%) — restarting in 5s >> "C:\Users\you\.stoa\logs\stoa.err.log"
timeout /t 5 /nobreak >nul
goto loop
```

Create a hidden launcher `stoa.vbs` in your Startup folder
(`%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\stoa.vbs`):

```vbscript
' Start the Stoa launcher hidden at logon (window style 0 = hidden, no wait).
' The path is wrapped in doubled quotes so a username with spaces still works.
CreateObject("WScript.Shell").Run """C:\Users\you\.stoa\run-stoa.cmd""", 0, False
```

Start it now without rebooting:

```powershell
wscript "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup\stoa.vbs"
```

### macOS — launchd LaunchAgent

Create `~/Library/LaunchAgents/com.stoa.server.plist` (replace `you` / port):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.stoa.server</string>
  <key>WorkingDirectory</key><string>/Users/you/.stoa/repo</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string><string>-lc</string><string>exec npm start</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PORT</key><string>3011</string>
    <key>NODE_ENV</key><string>production</string>
    <key>DB_PATH</key><string>/Users/you/.stoa/stoa.db</string>
    <key>STOA_TRUST_TAILSCALE</key><string>1</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/Users/you/.stoa/logs/stoa.out.log</string>
  <key>StandardErrorPath</key><string>/Users/you/.stoa/logs/stoa.err.log</string>
</dict>
</plist>
```

Load it (starts now + on every login; `KeepAlive` restarts on crash):

```bash
mkdir -p ~/.stoa/logs
launchctl load -w ~/Library/LaunchAgents/com.stoa.server.plist
```

### Linux — systemd user service

Create `~/.config/systemd/user/stoa.service` (replace `you` / port):

```ini
[Unit]
Description=Stoa server

[Service]
WorkingDirectory=/home/you/.stoa/repo
Environment=PORT=3011
Environment=NODE_ENV=production
Environment=DB_PATH=/home/you/.stoa/stoa.db
Environment=STOA_TRUST_TAILSCALE=1
# If node/npm is installed via nvm/asdf/volta it is NOT on systemd's minimal
# PATH and the service fails with status=203/EXEC. Then either add the absolute
# bin dir here, e.g.  Environment=PATH=/home/you/.nvm/versions/node/v24.x.x/bin:/usr/bin:/bin
# or point ExecStart at the absolute npm path.
ExecStart=/usr/bin/env npm start
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
```

Enable it, and allow it to run without an active login session:

```bash
systemctl --user daemon-reload
systemctl --user enable --now stoa.service
sudo loginctl enable-linger "$USER"   # so it survives logout / starts at boot
journalctl --user -u stoa.service -f  # logs (Linux uses the journal, not a file)
```

## 5. Reach it from your phone

Over Tailscale, open `http://<this-machine's-tailscale-name-or-IP>:<port>`.
With `STOA_TRUST_TAILSCALE=1` set, **no token is required** from tailnet devices.

First connection after a fresh install regenerates `vapid.json` and `token`, so
**re-subscribe to push notifications once** on the device.

---

## Deploying updates

Because the server is run by a keep-alive supervisor (not by `stoa start`'s
pid-tracking), deploy in **three steps** — stop the supervisor, update, start it
again — so the rebuild never happens under a running process:

**Windows:**

```powershell
# 1) stop the loop AND the server (the loop respawns the server otherwise).
#    Match the loop ('run-stoa') and the node server (its cmdline contains the
#    install path '.stoa\repo') — narrow enough not to hit other node processes.
Get-CimInstance Win32_Process |
  Where-Object { $_.CommandLine -match 'run-stoa|\.stoa\\repo' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
# 2) update (pull latest reviewed main + rebuild)
stoa update
# 3) relaunch
wscript "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup\stoa.vbs"
```

**macOS:**

```bash
launchctl unload ~/Library/LaunchAgents/com.stoa.server.plist
stoa update
launchctl load -w ~/Library/LaunchAgents/com.stoa.server.plist
```

**Linux:**

```bash
systemctl --user stop stoa.service
stoa update
systemctl --user start stoa.service
```

> `stoa update` refuses to run if the install tree has uncommitted _tracked_
> edits (untracked scratch files are fine) — the install should never be edited
> by hand. If it complains, you accidentally modified the install; revert it.

---

## Developing against the live data (optional)

To inspect the running instance's database from your dev checkout, point the dev
`.env` at the same canonical DB **for reads only**:

```dotenv
# Dev checkout .env — READ-only visibility into the live install DB.
# Do NOT run a dev server (npm run dev) with this set, or it writes to live data.
DB_PATH=/home/you/.stoa/stoa.db          # macOS/Linux
# DB_PATH=C:/Users/you/.stoa/stoa.db     # Windows
# No PORT here — a stray dev server then defaults to 3011 and can't collide.
```

---

## Verifying

```bash
stoa status     # Install path + status (always available)
```

Check it responds (expect `200`):

```bash
# macOS / Linux
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3011/
```

```powershell
# Windows
(Invoke-WebRequest http://localhost:3011/ -UseBasicParsing).StatusCode
```

Logs depend on how it's running:

- **Windows / macOS supervisor** → `~/.stoa/logs/stoa.out.log` and `stoa.err.log`
- **Linux systemd** → `journalctl --user -u stoa.service`
- **Started via `stoa start`** (not a supervisor) → a single combined `~/.stoa/logs/stoa.log`

## Troubleshooting

- **Server crash-loops right after install** — incomplete build. Rebuild:
  `cd ~/.stoa/repo && npm run build`; confirm `.next/prerender-manifest.json`.
- **`stoa` won't run in PowerShell** — run `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`, or invoke `stoa.cmd`.
- **`stoa status` says "Stopped" but the server is up** — expected when a
  keep-alive supervisor (this guide) runs it instead of `stoa start`; status
  tracks only the CLI's own pid file.
- **No push notifications after reinstall** — the VAPID keys regenerated;
  re-subscribe on the device.
- **Port already in use** — another instance is running; stop the supervisor (see
  "Deploying updates") before starting a new one.
