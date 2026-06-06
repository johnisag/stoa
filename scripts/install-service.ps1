<#
.SYNOPSIS
    Register Stoa as an always-on Windows service (NSSM).

.DESCRIPTION
    Installs NSSM if missing (via Chocolatey), then registers the Stoa install at
    %USERPROFILE%\.stoa\repo as a Windows service that:
      - starts automatically on boot / restart / logon,
      - auto-restarts within seconds if the process stops or crashes,
      - runs in production mode.

    Self-elevating: run it from any terminal and it prompts for admin (UAC).

.PARAMETER Port
    Port the service listens on. Default 3011. Pick a different port (e.g. 3022)
    if you also run `npm run dev` from a working checkout, so the two never clash.

.PARAMETER NoAuth
    Disable Stoa's app-level access token (sets STOA_AUTH=off). Only use this when
    access is already gated at the network layer (e.g. Tailscale) — otherwise
    anyone who can reach the port has full access.

.PARAMETER ServiceName
    Windows service name. Default 'Stoa'.

.NOTES
    Idempotent: re-running reconfigures the existing service in place.
    Pairs with update-service.ps1 (stop -> `stoa update` -> start).
#>
param(
    [int]$Port = 3011,
    [switch]$NoAuth,
    [string]$ServiceName = "Stoa"
)

$ErrorActionPreference = "Stop"

# ---------------------------------------------------------------------------
# Self-elevate to admin if needed (preserving the chosen parameters)
# ---------------------------------------------------------------------------
$principal = New-Object Security.Principal.WindowsPrincipal(
    [Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host "==> Requesting administrator rights (UAC)..." -ForegroundColor Cyan
    $argList = "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Port $Port -ServiceName `"$ServiceName`""
    if ($NoAuth) { $argList += " -NoAuth" }
    $proc = Start-Process powershell -Verb RunAs -ArgumentList $argList -Wait -PassThru
    exit $proc.ExitCode
}

function Write-Info { param([string]$m) Write-Host "==> $m" -ForegroundColor Cyan }
function Write-Ok   { param([string]$m) Write-Host "==> $m" -ForegroundColor Green }
function Write-Err  { param([string]$m) Write-Host "==> $m" -ForegroundColor Red }

$AgentHome = Join-Path $env:USERPROFILE ".stoa"
$Repo      = Join-Path $AgentHome "repo"

Write-Host ""
Write-Host "Stoa service installer" -ForegroundColor White
Write-Host ""

# ---------------------------------------------------------------------------
# Sanity: the install must exist
# ---------------------------------------------------------------------------
if (-not (Test-Path (Join-Path $Repo "server.ts"))) {
    Write-Err "Stoa is not installed at $Repo (server.ts not found)."
    Write-Host "    Install it first:  irm https://raw.githubusercontent.com/johnisag/stoa/main/scripts/install.ps1 | iex"
    exit 1
}

# ---------------------------------------------------------------------------
# Ensure NSSM is available
# ---------------------------------------------------------------------------
$nssm = (Get-Command nssm -ErrorAction SilentlyContinue).Source
if (-not $nssm) { $nssm = "C:\ProgramData\chocolatey\bin\nssm.exe" }
if (-not (Test-Path $nssm)) {
    Write-Info "NSSM not found - installing via Chocolatey..."
    & choco install nssm -y
    if (-not $?) { Write-Err "choco install nssm failed (is Chocolatey installed?)."; exit 1 }
    $nssm = "C:\ProgramData\chocolatey\bin\nssm.exe"
}
if (-not (Test-Path $nssm)) { Write-Err "NSSM still not found at $nssm."; exit 1 }
Write-Info "NSSM: $nssm"

# ---------------------------------------------------------------------------
# Resolve node + the tsx runner (run node directly - no cmd/npm shims in a service)
# ---------------------------------------------------------------------------
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { Write-Err "node not found on PATH."; exit 1 }

$tsxCli = Join-Path $Repo "node_modules\tsx\dist\cli.mjs"
if (-not (Test-Path $tsxCli)) {
    Write-Err "tsx runner not found at $tsxCli (did 'npm install' complete?)."
    exit 1
}
Write-Info "Node:   $node"
Write-Info "Runner: $tsxCli"
Write-Info "Port:   $Port"
Write-Info ("Auth:   " + $(if ($NoAuth) { "OFF (STOA_AUTH=off)" } else { "on (token)" }))

# ---------------------------------------------------------------------------
# Remove any prior service so config is applied cleanly
# ---------------------------------------------------------------------------
$existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($existing) {
    Write-Info "Existing '$ServiceName' service found - reconfiguring..."
    if ($existing.Status -ne "Stopped") { & $nssm stop $ServiceName | Out-Null }
    & $nssm remove $ServiceName confirm | Out-Null
    Start-Sleep -Seconds 1
}

# ---------------------------------------------------------------------------
# Register the service
# ---------------------------------------------------------------------------
Write-Info "Registering service '$ServiceName'..."
& $nssm install $ServiceName $node "`"$tsxCli`" server.ts"
& $nssm set $ServiceName AppDirectory $Repo

# Build the environment list, adding STOA_AUTH=off only when -NoAuth is given.
$envPairs = @("NODE_ENV=production", "PORT=$Port")
if ($NoAuth) { $envPairs += "STOA_AUTH=off" }
& $nssm set $ServiceName AppEnvironmentExtra $envPairs

& $nssm set $ServiceName Start SERVICE_AUTO_START
& $nssm set $ServiceName AppExit Default Restart
& $nssm set $ServiceName AppRestartDelay 2000
& $nssm set $ServiceName AppThrottle 1500
& $nssm set $ServiceName DisplayName "Stoa AI Cockpit"
& $nssm set $ServiceName Description "Stoa - self-hosted cockpit for AI coding agents (always-on, port $Port)."
& $nssm set $ServiceName AppStdout (Join-Path $AgentHome "service.out.log")
& $nssm set $ServiceName AppStderr (Join-Path $AgentHome "service.err.log")
& $nssm set $ServiceName AppStdoutCreationDisposition 4
& $nssm set $ServiceName AppStderrCreationDisposition 4
& $nssm set $ServiceName AppRotateFiles 1
& $nssm set $ServiceName AppRotateBytes 1048576

# ---------------------------------------------------------------------------
# Start it
# ---------------------------------------------------------------------------
Write-Info "Starting service..."
& $nssm start $ServiceName
$startExit = $LASTEXITCODE
Start-Sleep -Seconds 3
$svc = Get-Service -Name $ServiceName

if ($startExit -ne 0 -or $svc.Status -ne "Running") {
    Write-Host ""
    Write-Err "Service '$ServiceName' did not start cleanly (nssm exit $startExit, status $($svc.Status))."
    Write-Host "    Check the logs: $AgentHome\service.err.log"
    exit 1
}

Write-Host ""
Write-Ok "Stoa service '$ServiceName' is $($svc.Status)."
Write-Host ""
Write-Host "  URL:      http://localhost:$Port"
Write-Host "  Logs:     $AgentHome\service.out.log  /  service.err.log"
Write-Host "  Update:   powershell -ExecutionPolicy Bypass -File update-service.ps1"
Write-Host "  Manage:   nssm restart $ServiceName  |  nssm stop $ServiceName  |  services.msc"
Write-Host ""
Write-Host "It will auto-start on boot/logon and auto-restart if it ever stops." -ForegroundColor Green
Write-Host ""
