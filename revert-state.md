# Stoa Recovery State

This checkout is intended to be the clean, normal-development Stoa repo after
backing away from the dogfoot/self-hosting setup.

## What Happened

Dogfoot/self-hosting made the Windows development loop unstable:

- many Console Window Host / OpenConsole processes appeared
- terminal typing in the Stoa UI stopped working
- logs showed terminal attach failures such as:

```text
pty attach failed: Error: host request timeout
```

The decision was to stop using dogfoot for now and return to a simple local
development workflow.

## Known Good Commit

The known-good point is the last `main` commit from Friday June 5, 2026:

```text
4cdd39b feat(dispatch): add repo from a GitHub repo, clone-if-needed (source picker, layer 3/3) (#112)
```

This clone should be checked out from that commit on a local branch such as:

```powershell
git checkout -b stable-june5 4cdd39b
```

## Cleanup Already Done

The dogfoot runtime was removed from the Windows machine:

- removed `C:\Users\johnis\.stoa`
- removed global npm `stoa` shims:
  - `C:\Users\johnis\AppData\Roaming\npm\stoa.ps1`
  - `C:\Users\johnis\AppData\Roaming\npm\stoa.cmd`
  - `C:\Users\johnis\AppData\Roaming\npm\stoa`
- removed the global npm package junction:
  - `C:\Users\johnis\AppData\Roaming\npm\node_modules\@johnisag\stoa`

After this, the global `stoa` command should no longer exist.

## Clean Clone Steps

From PowerShell:

```powershell
cd C:\my-projects
git clone https://github.com/johnisag/stoa.git stoa-clean
cd C:\my-projects\stoa-clean
git checkout -b stable-june5 4cdd39b
```

If the clone already exists, just enter it and check the state:

```powershell
cd C:\my-projects\stoa-clean
git status --short --branch
git log -1 --date=iso --pretty=format:"%h %cd %s"
```

Expected commit:

```text
4cdd39b
```

## Install

```powershell
npm install --include=dev --legacy-peer-deps
```

## Verify

Run the full local gate:

```powershell
npx tsc --noEmit
npm test
npm run build
```

## Run For Development

Use the normal dev server:

```powershell
npm run dev
```

Then open:

```text
http://localhost:3011
```

## Development Lifecycle

Use a normal local development workflow:

```powershell
git switch -c feature/my-change
npm run dev
```

Before opening a PR:

```powershell
npx tsc --noEmit
npm test
npm run build
```

Do not use dogfoot/self-hosting for now.

## CLI Smoke Tests

If the CLI needs to be tested, isolate it from real user state:

```powershell
$env:STOA_HOME="$env:TEMP\stoa-smoke"
node scripts/stoa.js start
node scripts/stoa.js status
node scripts/stoa.js stop
Remove-Item -Recurse -Force "$env:TEMP\stoa-smoke"
Remove-Item Env:\STOA_HOME
```

This avoids recreating `C:\Users\johnis\.stoa` as the daily runtime and keeps
CLI lifecycle tests separate from normal development.

## Important Notes

- `origin/main` is ahead of `4cdd39b` and contains later dogfoot/lifecycle work.
- Do not fast-forward this recovery branch until the later commits are reviewed.
- If Windows starts showing many new Stoa-owned `OpenConsole.exe` or `conhost.exe`
  processes again, stop and inspect before continuing.

## Work To Redo

This revert intentionally brings the current tree back to `4cdd39b` while
preserving later history. Reapply later work one topic at a time from fresh
branches, with the full gate green on Windows before merging.

### Issues Noticed During Recovery

- Dogfoot/self-hosting made the Windows development loop unstable enough to
  abandon it for now.
- Terminal input in the Stoa UI stopped working during the unstable period.
- Logs included `pty attach failed: Error: host request timeout`.
- Windows accumulated many `OpenConsole.exe` / `conhost.exe` processes while the
  dogfoot setup was active.
- Local verification on June 8, 2026 passed, but `npm test` printed repeated
  `node-pty` `AttachConsole failed` messages after Vitest reported success.
- The test run left orphaned dummy `node -e setInterval(...)` processes from pty
  tests; they were stopped manually after verification.
- PowerShell on this machine blocks `npm.ps1`, so use `npm.cmd` / `npx.cmd` there
  unless execution policy changes. Bash can still use `npm`.

### Non-Dogfoot Work Worth Reapplying

The commits below are post-`4cdd39b` work that appears separable from the
dogfoot/self-hosting rollback. Reapply only after review; several later fixes
touch lifecycle or process management and may need redesign before replay.

- `769c85c` - create GitHub issues from Stoa dispatch.
- `b91110a` - make the three-agent review gate explicit in AGENTS docs.
- `900366c` - schedule dispatch issues for later.
- `a675421` - merge cockpit for reviewing diffs and merging worker PRs.
- `cbf2ced` - reviewer gate with optional auto-critic verdicts.
- `263df7a` - dispatch fix loop for changes-requested PRs.
- `fb2c02f` - dismiss and retry actions for failed dispatch cards.
- `3f6de94` - in-app Dispatch "How it works" guide.
- `a467fca` - Android terminal typing lag fix via TCP/resize handling.
- `182af2e` - on-demand issue triage from the cockpit.
- `52679c9` - pass `STOA_PORT` to the spawned CLI server.
- `0874972` - load repo-root `.env` for CLI configuration.
- `ae09008` - ignore `.claude/settings.local.json`.
- `978dc17` - keep foreign model names from leaking into Hermes.
- `37c32ed` - keep the Tier-2 pty-host daemon alive when a frame/listener throws.
- `5d71c69` - append-only session audit event ledger at the backend seam.
- `3bc059f` - on-box analytics insight layer over the audit ledger.
- `22f240a` - remove duplicate sidebar-collapse toggle.
- `48c534c` - declarative agent-pipeline DAG engine and executor.
- `fab2c23` - label analytics merged-PR stat with its coverage caveat.
- `d29f35a` - capture pipeline Stage-1 ultra-review findings.
- `80e2981` - reap pipeline workers on terminal runs.
- `156adc0` - retry npm install in CI for flaky Windows native builds.
- `21400de` - cache `node_modules` in CI.
- `b641470` - pin CI to Node 24.
- `4335f1b` - raise project baseline to Node 24.
- `38451ca` - default the SQLite DB to `STOA_HOME`.
- `f149e7e` - verify `.next` build artifacts.
- `6050464` - make install survive `NODE_ENV=production`.
- `9440f4b` - improve plain-user install reachability on Linux and Windows.
- `127ed1e` - launch the Windows server hidden to avoid popup windows.
- `739db14` - reap orphaned Windows processes.

### Dogfoot/Lifecycle Work To Reconsider Before Reapplying

These commits are either explicitly dogfoot/self-hosting related or close enough
to the unstable lifecycle path that they should not be blindly replayed:

- `d2f23d7` / `f3b4413` - always-on service infrastructure and its revert.
- `7521448`, `3ae30dd`, `fd4c2dd` - dogfoot and setup documentation changes.
- `ed7f415`, `3aa1db5`, `a5f9d41`, `1767882`, `925400c`, `a1b5285`, `32885e0` -
  update/start/stop/process/lifecycle hardening that may contain useful pieces
  but must be split and tested carefully.
- `be1528c` - malformed `@` commit; inspect before deciding whether anything
  should be recovered.
