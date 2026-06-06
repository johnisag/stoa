<#
.SYNOPSIS
    Update the always-on Stoa Windows service in place.

.DESCRIPTION
    Stops the NSSM-managed service, pulls the latest `main` and rebuilds the
    install at %USERPROFILE%\.stoa\repo (via the Stoa CLI's `update`), then
    restarts the service so the new build goes live.

    Why a dedicated script: `stoa update` tracks the server through its own pid
    file (~/.stoa/stoa.pid), which only `stoa start` writes. The service is
    launched by NSSM directly, so `stoa update` on its own neither stops it
    (risking file-lock errors during `npm install`/`next build`) nor restarts it
    (leaving the old code running in memory). This wrapper hands stop/start to
    NSSM and lets `stoa update` do just the git pull + rebuild.

    Self-elevating: run it from any terminal and it prompts for admin (UAC).

.PARAMETER ServiceName
    NSSM service name. Default 'Stoa'.

.NOTES
    The service is always restarted at the end — even if the update is a no-op or
    fails — so an update can never leave your server down.
#>
param(
    [string]$ServiceName = "Stoa"
)

$ErrorActionPreference = "Stop"

# ---------------------------------------------------------------------------
# Self-elevate to admin if needed
# ---------------------------------------------------------------------------
$principal = New-Object Security.Principal.WindowsPrincipal(
    [Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host "==> Requesting administrator rights (UAC)..." -ForegroundColor Cyan
    $argList = "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" -ServiceName `"$ServiceName`""
    $proc = Start-Process powershell -Verb RunAs -ArgumentList $argList -Wait -PassThru
    exit $proc.ExitCode
}

function Write-Info { param([string]$m) Write-Host "==> $m" -ForegroundColor Cyan }
function Write-Ok   { param([string]$m) Write-Host "==> $m" -ForegroundColor Green }
function Write-Err  { param([string]$m) Write-Host "==> $m" -ForegroundColor Red }

$AgentHome = Join-Path $env:USERPROFILE ".stoa"
$Repo      = Join-Path $AgentHome "repo"
$Cli       = Join-Path $Repo "scripts\stoa.js"

$nssm = (Get-Command nssm -ErrorAction SilentlyContinue).Source
if (-not $nssm) { $nssm = "C:\ProgramData\chocolatey\bin\nssm.exe" }

# ---------------------------------------------------------------------------
# Preflight
# ---------------------------------------------------------------------------
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node)             { Write-Err "node not found on PATH."; exit 1 }
if (-not (Test-Path $Cli))  { Write-Err "Stoa CLI not found at $Cli."; exit 1 }
if (-not (Test-Path $nssm)) { Write-Err "NSSM not found ($nssm). Run install-service.ps1 first."; exit 1 }
if (-not (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue)) {
    Write-Err "Service '$ServiceName' not found. Run install-service.ps1 first."
    exit 1
}

Write-Host ""
Write-Host "Stoa service updater" -ForegroundColor White
Write-Host ""

# ---------------------------------------------------------------------------
# 1) Stop the service so the rebuild never fights file locks
# ---------------------------------------------------------------------------
Write-Info "Stopping service '$ServiceName'..."
& $nssm stop $ServiceName | Out-Null
# nssm stop is synchronous, but confirm it actually reached Stopped so the
# rebuild never fights file locks held by a lingering process.
for ($i = 0; $i -lt 10 -and (Get-Service -Name $ServiceName).Status -ne "Stopped"; $i++) {
    Start-Sleep -Seconds 1
}

# If a manual `stoa start` left a pid file, stop that stray instance too — it
# isn't owned by NSSM, so otherwise `stoa update` would relaunch a second copy
# that fights the service for the port (EADDRINUSE).
$pidFile = Join-Path $AgentHome "stoa.pid"
if (Test-Path $pidFile) {
    Write-Info "Found a leftover stoa.pid (manual 'stoa start') - stopping that instance..."
    & $node $Cli stop | Out-Null
}

# ---------------------------------------------------------------------------
# 2) Pull + rebuild via the CLI. It pins to main and refuses to clobber local
#    edits; with no pid file present it won't try to start/stop anything itself.
# ---------------------------------------------------------------------------
Write-Info "Updating + rebuilding $Repo ..."
& $node $Cli update
$updateExit = $LASTEXITCODE

# ---------------------------------------------------------------------------
# 3) Always restart, so a no-op (or even a failed update) never leaves it down
# ---------------------------------------------------------------------------
Write-Info "Starting service '$ServiceName'..."
& $nssm start $ServiceName
$startExit = $LASTEXITCODE
Start-Sleep -Seconds 3
$svc = Get-Service -Name $ServiceName

Write-Host ""
if ($startExit -ne 0 -or $svc.Status -ne "Running") {
    Write-Err "Service '$ServiceName' may not have started cleanly (nssm exit $startExit, status $($svc.Status))."
    Write-Host "    Check the logs: $AgentHome\service.err.log"
    exit 1
} elseif ($updateExit -eq 0) {
    Write-Ok "Update complete - '$ServiceName' is $($svc.Status)."
} else {
    Write-Err "Update reported errors (exit $updateExit), but the service is $($svc.Status)."
    Write-Host "    Check the logs: $AgentHome\service.err.log"
    exit 1
}
Write-Host ""
