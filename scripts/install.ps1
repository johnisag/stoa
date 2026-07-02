<#
.SYNOPSIS
    Stoa installer for native Windows.

.DESCRIPTION
    Mirrors scripts/install.sh for Windows / PowerShell. Checks prerequisites
    (Node 24+, Git), clones or updates the repo into %USERPROFILE%\.stoa\repo,
    installs npm dependencies, builds for production, and prints how to start.

    Designed to be run via:
        irm https://raw.githubusercontent.com/johnisag/stoa/main/scripts/install.ps1 | iex

    CHANNEL (#56): default "main" keeps today's behavior — clone/track the main
    branch's HEAD. The OPT-IN "release" channel pins the checkout to the latest
    verified, immutable release tag (safer for production). Select it with the
    -Channel parameter or the STOA_CHANNEL environment variable (the parameter
    wins). When piping the script (irm ... | iex) params can't be passed, so set
    the env var first:
        $env:STOA_CHANNEL = "release"; irm .../install.ps1 | iex
    Behavior is identical to the POSIX installer (install.sh).

    SECURITY NOTE: This installer fetches code from the internet and executes it.
    For production deployments, pin the remote script to an immutable release tag
    or SHA and verify checksums before execution. See SECURITY.md for details.

.PARAMETER Channel
    Update channel: "main" (default) or "release".

.NOTES
    PowerShell 5.1 compatible: no `&&`/`||` chaining; uses `if ($?) {}` instead.
    Does NOT install tmux (removed) or ripgrep (bundled via @vscode/ripgrep).
#>

param(
    [string]$Channel = ""
)

# Stop on the first unhandled error so a failed step doesn't cascade silently.
$ErrorActionPreference = "Stop"

$RepoUrl    = "https://github.com/johnisag/stoa.git"
$AgentHome  = Join-Path $env:USERPROFILE ".stoa"
$InstallDir = Join-Path $AgentHome "repo"

# Channel selection (#56): -Channel param > STOA_CHANNEL env > default "main".
# Default is a no-op (clone/pull already leaves us on main); "release" is opt-in.
# Only fall back to the env/default when -Channel was NOT bound at all: a
# -Channel that WAS passed but is empty is an error (exits 1 at validation),
# matching install.sh and stoa.js resolveUpdateChannel exactly.
if (-not $PSBoundParameters.ContainsKey('Channel')) {
    if (-not [string]::IsNullOrWhiteSpace($env:STOA_CHANNEL)) {
        $Channel = $env:STOA_CHANNEL
    } else {
        $Channel = "main"
    }
}
$Channel = $Channel.Trim().ToLowerInvariant()
if ($Channel -ne "main" -and $Channel -ne "release") {
    Write-Host "==> Unknown channel `"$Channel`". Use: main or release." -ForegroundColor Red
    exit 1
}

function Write-Info    { param([string]$Message) Write-Host "==> $Message" -ForegroundColor Cyan }
function Write-Ok      { param([string]$Message) Write-Host "==> $Message" -ForegroundColor Green }
function Write-Err     { param([string]$Message) Write-Host "==> $Message" -ForegroundColor Red }

Write-Host ""
Write-Host "Stoa Installer" -ForegroundColor White
Write-Host ""

# ---------------------------------------------------------------------------
# Prerequisite: Node.js 24+
# ---------------------------------------------------------------------------
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
    Write-Err "Node.js is required but was not found."
    Write-Host "    Install it with:  winget install OpenJS.NodeJS.LTS"
    Write-Host "    Then re-open your terminal and run this installer again."
    exit 1
}

# `node -v` prints e.g. "v24.0.0"; strip the leading "v" and take the major.
$nodeVersionRaw = (& node -v).Trim()
$nodeMajor = [int]($nodeVersionRaw.TrimStart("v").Split(".")[0])
if ($nodeMajor -lt 24) {
    Write-Err "Node.js 24+ is required (found $nodeVersionRaw)."
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

$npmCmd = Get-Command npm.cmd -ErrorAction SilentlyContinue
if (-not $npmCmd) {
    $npmCmd = Get-Command npm -ErrorAction SilentlyContinue
}
if (-not $npmCmd) {
    Write-Err "npm is required but was not found."
    Write-Host "    npm should come with Node.js. Reinstall Node.js, then retry."
    exit 1
}

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
    Write-Info "Downloading Stoa..."
    if (-not (Test-Path $AgentHome)) {
        New-Item -ItemType Directory -Force -Path $AgentHome | Out-Null
    }
    & git clone "$RepoUrl" "$InstallDir"
    if (-not $?) { Write-Err "git clone failed."; exit 1 }
}

# ---------------------------------------------------------------------------
# Release channel (#56): pin the checkout to the latest verified release tag.
# Default "main" is a no-op here (the clone/pull above already left us on main).
# ---------------------------------------------------------------------------
if ($Channel -eq "release") {
    Push-Location $InstallDir
    Write-Info "Resolving the latest release tag (release channel)..."
    & git fetch --tags --quiet
    if (-not $?) { Pop-Location; Write-Err "git fetch --tags failed."; exit 1 }
    # Newest STABLE vMAJOR.MINOR.PATCH tag. The Where-Object is load-bearing: it
    # must mirror stoa.js parseReleaseTag EXACTLY — three numeric segments, NO
    # prerelease suffix and NO 4th segment — so install and `stoa update` on the
    # release channel always select the SAME tag. Without it git's -v:refname
    # sort ranks a prerelease (v2.0.0-rc.1) above the highest stable and a
    # release candidate would reach production.
    $latestTag = (& git tag --list 'v[0-9]*.[0-9]*.[0-9]*' --sort=-v:refname |
        Where-Object { $_ -match '^v\d+\.\d+\.\d+$' } |
        Select-Object -First 1)
    if ([string]::IsNullOrWhiteSpace($latestTag)) {
        Pop-Location
        Write-Err "No verified release tag found. Re-run without -Channel release (or with -Channel main) to track main."
        exit 1
    }
    $latestTag = $latestTag.Trim()
    Write-Info "Checking out release tag $latestTag"
    & git checkout --force "tags/$latestTag"
    if (-not $?) { Pop-Location; Write-Err "git checkout $latestTag failed."; exit 1 }
    Pop-Location
}

# ---------------------------------------------------------------------------
# Install dependencies and build for production
# ---------------------------------------------------------------------------
Push-Location $InstallDir

Write-Info "Installing dependencies..."
& "$($npmCmd.Source)" install --include=dev --legacy-peer-deps
if (-not $?) { Pop-Location; Write-Err "npm install failed."; exit 1 }

Write-Info "Building for production..."
& "$($npmCmd.Source)" run build
if (-not $?) { Pop-Location; Write-Err "npm run build failed."; exit 1 }

if (
    -not (Test-Path (Join-Path $InstallDir ".next\BUILD_ID")) -or
    -not (Test-Path (Join-Path $InstallDir ".next\prerender-manifest.json"))
) {
    Pop-Location
    Write-Err "Build incomplete (.next is missing required files). Re-run: npm run build"
    exit 1
}

Pop-Location

Push-Location $InstallDir
Write-Info "Attempting to link the 'stoa' command to your PATH (best-effort)..."
& "$($npmCmd.Source)" link
$linked = $?
Pop-Location

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------
Write-Host ""
Write-Ok "Stoa installed successfully!"
Write-Host ""
Write-Host "Installed at: $InstallDir"
Write-Host ""
if ($linked) {
    Write-Host "Next steps:"
    Write-Host "  stoa start"
    Write-Host ""
    Write-Host "If PowerShell blocks 'stoa' (script execution disabled), run:"
    Write-Host "  stoa.cmd start"
} else {
    Write-Err "Could not link 'stoa' to your PATH automatically."
    Write-Host "Run it directly instead:"
    Write-Host "  node `"$InstallDir\scripts\stoa.js`" start"
    Write-Host "  - or -"
    Write-Host "  cd `"$InstallDir`"; npm start"
}
Write-Host ""
Write-Host "Then open http://localhost:3011 in your browser."
Write-Host ""
