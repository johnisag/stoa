<#
.SYNOPSIS
    AgentOS installer for native Windows.

.DESCRIPTION
    Mirrors scripts/install.sh for Windows / PowerShell. Checks prerequisites
    (Node 20+, Git), clones or updates the repo into %USERPROFILE%\.agent-os\repo,
    installs npm dependencies, builds for production, and prints how to start.

    Designed to be run via:
        irm https://raw.githubusercontent.com/johnisag/agent-os/main/scripts/install.ps1 | iex

.NOTES
    PowerShell 5.1 compatible: no `&&`/`||` chaining; uses `if ($?) {}` instead.
    Does NOT install tmux (removed) or ripgrep (bundled via @vscode/ripgrep).
#>

# Stop on the first unhandled error so a failed step doesn't cascade silently.
$ErrorActionPreference = "Stop"

$RepoUrl    = "https://github.com/johnisag/agent-os.git"
$AgentHome  = Join-Path $env:USERPROFILE ".agent-os"
$InstallDir = Join-Path $AgentHome "repo"

function Write-Info    { param([string]$Message) Write-Host "==> $Message" -ForegroundColor Cyan }
function Write-Ok      { param([string]$Message) Write-Host "==> $Message" -ForegroundColor Green }
function Write-Err     { param([string]$Message) Write-Host "==> $Message" -ForegroundColor Red }

Write-Host ""
Write-Host "AgentOS Installer" -ForegroundColor White
Write-Host ""

# ---------------------------------------------------------------------------
# Prerequisite: Node.js 20+
# ---------------------------------------------------------------------------
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
    Write-Err "Node.js is required but was not found."
    Write-Host "    Install it with:  winget install OpenJS.NodeJS.LTS"
    Write-Host "    Then re-open your terminal and run this installer again."
    exit 1
}

# `node -v` prints e.g. "v20.11.1"; strip the leading "v" and take the major.
$nodeVersionRaw = (& node -v).Trim()
$nodeMajor = [int]($nodeVersionRaw.TrimStart("v").Split(".")[0])
if ($nodeMajor -lt 20) {
    Write-Err "Node.js 20+ is required (found $nodeVersionRaw)."
    Write-Host "    Upgrade with:  winget install OpenJS.NodeJS.LTS"
    exit 1
}
Write-Info "Node.js: $nodeVersionRaw"

# ---------------------------------------------------------------------------
# Prerequisite: Git
# ---------------------------------------------------------------------------
$gitCmd = Get-Command git -ErrorAction SilentlyContinue
if (-not $gitCmd) {
    Write-Err "Git is required but was not found."
    Write-Host "    Install it with:  winget install Git.Git"
    Write-Host "    Then re-open your terminal and run this installer again."
    exit 1
}
Write-Info "Git: $((& git --version).Trim())"

# ---------------------------------------------------------------------------
# Clone or update the repository (idempotent)
# ---------------------------------------------------------------------------
if (Test-Path $InstallDir) {
    Write-Info "Updating existing installation..."
    Push-Location $InstallDir
    & git pull --ff-only
    if (-not $?) { Pop-Location; Write-Err "git pull failed."; exit 1 }
    Pop-Location
} else {
    Write-Info "Downloading AgentOS..."
    if (-not (Test-Path $AgentHome)) {
        New-Item -ItemType Directory -Force -Path $AgentHome | Out-Null
    }
    & git clone $RepoUrl $InstallDir
    if (-not $?) { Write-Err "git clone failed."; exit 1 }
}

# ---------------------------------------------------------------------------
# Install dependencies and build for production
# ---------------------------------------------------------------------------
Push-Location $InstallDir

Write-Info "Installing dependencies..."
& npm install --legacy-peer-deps
if (-not $?) { Pop-Location; Write-Err "npm install failed."; exit 1 }

Write-Info "Building for production..."
& npm run build
if (-not $?) { Pop-Location; Write-Err "npm run build failed."; exit 1 }

Pop-Location

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------
Write-Host ""
Write-Ok "AgentOS installed successfully!"
Write-Host ""
Write-Host "Installed at: $InstallDir"
Write-Host ""
Write-Host "Next steps:"
Write-Host "  agent-os start          (if the CLI is on your PATH)"
Write-Host "  - or -"
Write-Host "  cd `"$InstallDir`"; npm start"
Write-Host ""
Write-Host "Then open http://localhost:3011 in your browser."
Write-Host ""
