# Dogfooding Stoa

How to run a long-lived Stoa instance on a machine that serves your phone/laptop
over your private network — while you keep developing Stoa in a **separate
checkout**.

There is **no background supervisor**: you start it with `stoa start`, update with
`stoa update`, and stop with `stoa stop`. If the machine reboots or you log out,
you start it again with `stoa start`. Simple by design — if the PC is down, Stoa
is down.

Repeat per machine; each is independent (its own checkout, database, and port).

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
every `npm run build` overwrites the `.next` the running server serves. The
install is the deployed copy; the dev checkout is where you work.

The **database** lives in `~/.stoa/stoa.db` by default (in `STOA_HOME`, beside
`token`/`vapid.json`), outside both checkouts — so a re-clone or `git reset` of
the install can't destroy your data. You don't need to set `DB_PATH`.

---

## Prerequisites

- **Node.js 24+** and **Git**.
- **[Tailscale](https://tailscale.com/)** (optional) to reach the server from
  other devices.

---

## 1. Install

Run the one-liner for your OS. It clones to `~/.stoa/repo`, installs, and builds.

**Windows (PowerShell):**

```powershell
irm https://raw.githubusercontent.com/johnisag/stoa/main/scripts/install.ps1 | iex
```

**macOS / Linux:**

```bash
curl -fsSL https://raw.githubusercontent.com/johnisag/stoa/main/scripts/install.sh | bash
```

## 2. Put `stoa` on your PATH

So `stoa start` / `stoa update` work from any directory and target this install:

```bash
cd ~/.stoa/repo
npm link
```

**Windows only:** if PowerShell blocks the `stoa` shim (execution policy), allow
locally-created scripts once: `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`
(or invoke `node ~/.stoa/repo/scripts/stoa.js <cmd>` directly).

## 3. Configure the install (optional)

Create `~/.stoa/repo/.env` if you want to change the defaults:

```dotenv
# Port (default 3011)
STOA_PORT=3022

# Token-free access over the Tailscale tailnet (the tailnet authenticates
# devices at the network layer). A non-tailnet LAN device still needs the token.
STOA_TRUST_TAILSCALE=1
```

`DB_PATH` defaults to `~/.stoa/stoa.db` (safe, outside the repo) — leave it unset
unless you want to relocate the DB. See `docs/setup/README.md` for the full list
of environment variables.

## 4. Run it — the three commands

```bash
stoa start     # start the server in the background (pid-tracked)
stoa status    # show status, PID, and the URL
stoa stop      # stop the server
stoa update    # pull the latest main, rebuild, and restart — one command
stoa logs      # tail the server log
```

That's the whole lifecycle. **There is no auto-start** — after a reboot or
logout, run `stoa start` again.

## 5. Reach it from your phone (Tailscale)

Open `http://<this-machine's-tailscale-name-or-IP>:<port>`. With
`STOA_TRUST_TAILSCALE=1`, no token is required from tailnet devices.

A fresh install regenerates `vapid.json`/`token`, so **re-subscribe to push once**
on the device. (To make push survive a re-clone, pin `STOA_VAPID_PUBLIC_KEY` /
`STOA_VAPID_PRIVATE_KEY` in `.env` — see `docs/setup/README.md`.)

---

## Developing against the live data (optional)

To inspect the running instance's database from your dev checkout, point the dev
`.env` at the same DB **for reads only**:

```dotenv
# Dev checkout .env — READ-only visibility into the live install DB.
# Don't run a dev server with this set, or it writes into live data.
DB_PATH=~/.stoa/stoa.db
```

---

## Verify / Troubleshooting

```bash
stoa status     # Running (PID ...) + URL
stoa logs       # ~/.stoa/logs/stoa.log
```

- **`curl http://localhost:<port>/` returns 200** once the server finishes
  starting (production Next.js takes ~10-20s after `stoa start`).
- **Server won't start after an update** — a partial build. `stoa update` aborts
  on an incomplete build; if you hit it, `cd ~/.stoa/repo && npm run build`, then
  `stoa start`.
- **Port already in use** — another `stoa start` is running; `stoa stop` first.
