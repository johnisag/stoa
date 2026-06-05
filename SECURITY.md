# Security

## Reporting

Found a vulnerability? **Do not open a public issue.** Email the maintainer or use
GitHub's private vulnerability reporting (Security → Report a vulnerability).

## Threat model — supply-chain / persistence

Stoa runs AI coding agents in real terminals, so the highest-value target is
**arbitrary code execution on the host or in CI** via a self-propagating payload.
Such an attack persists by hooking every surface that auto-runs when you touch the
project. We defend each one:

The surface guard (`scripts/guard-surfaces.mjs`) **pins the EOL-normalized
byte-content (SHA-256)** of every file under a surface dir in
`security/surface-pins.json`, and fails on any deviation — so it catches a
_changed_ surface, not just a new one (e.g. trojaning `scripts/postinstall.js`
while leaving its `package.json` command string intact, or editing `.husky/pre-commit`).

| Surface                                                                                                                                                                             | Auto-runs on                                                                                                                                                                                       | Defense                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **all** `package.json` scripts (lifecycle **and** `test`/`build`/…)                                                                                                                 | `npm install` / CI / you                                                                                                                                                                           | pinned exact-string; add/change/remove fails. A **lifecycle** script that invokes an **unpinned** file (e.g. `tools/run.js`) is itself a violation                                                                                                                                                                                                                                                                                                                                                                                                                 |
| every file under `scripts/`, `.husky/`, `.github/`, `.claude/`, **`.cursor/`, `.gemini/`, `.codex/`, `.agents/`**, `security/` + root rule files (`.cursorrules`, `.windsurfrules`) | the above + git/CI events                                                                                                                                                                          | **content-hash pinned**, any extension; any byte change or new file fails. Covers Cursor `hooks.json`/`mcp.json`/`environment.json`/`rules/*.mdc`, Gemini `settings.json`/`commands/*.toml`, and the cross-tool `*/skills/*` roots — all schema-agnostically                                                                                                                                                                                                                                                                                                       |
| `.github/workflows/*`, composite `actions/*`                                                                                                                                        | every CI run                                                                                                                                                                                       | content-pinned; CI `permissions: contents: read`; actions SHA-pinned; **the CI guard runs the guard CODE from the BASE branch** (a PR can't weaken the logic); the _pins/config_ trust root is the CODEOWNERS review gate (see below)                                                                                                                                                                                                                                                                                                                              |
| the guard's own config + pins (`security/`)                                                                                                                                         | —                                                                                                                                                                                                  | byte-pinned **and** code-owned; `guard.config.json` is **fail-closed** — must be **tracked** (an untracked/gitignored config is ignored **and** flagged), can only WIDEN coverage / TIGHTEN limits, and `oversizeAllowlist` is **not** user-widenable, so it can never disarm the guard                                                                                                                                                                                                                                                                            |
| `.claude/*`, `.cursor/*`, `.gemini/*`, `.claude.json`, `.mcp.json` `hooks` + **MCP servers**                                                                                        | every Claude/Cursor/Gemini/Codex/Hermes start (Cursor hooks fire on `workspaceOpen` with **no approval**; Gemini folder-trust is **OFF by default**, so a committed `.gemini/` auto-execs ungated) | structured **JSON** scan: fails on any `hooks` key or any non-allowlisted MCP server — shells/metachars/decoys, interpreter `-e`/`-r`/`--require`/`--import` preloads, code-injecting `env` (`NODE_OPTIONS`/`LD_PRELOAD`/…) and dir-name spoofing all rejected (allowlist matches the executable **basename** only); an _unparseable_ config is itself a violation. Matching is **case-insensitive**. Codex/Hermes **TOML** configs are byte-pinned (not JSON-scanned) in-repo, so a re-pin is the (code-owned) review point. All **on top of** the byte-pin above |
| `.vscode/tasks.json`                                                                                                                                                                | folder open                                                                                                                                                                                        | fails if present (we don't use it)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| oversized / obfuscated blob anywhere (incl. `lib/`, `app/`)                                                                                                                         | bundled/run by CI                                                                                                                                                                                  | repo-wide sweep: fails on >1 MB or minified/obfuscated source                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| committed credentials                                                                                                                                                               | exfiltration                                                                                                                                                                                       | `gitleaks` in CI; `.env*` gitignored (`.env.example` kept); enable GitHub push protection                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

The guard runs in **both** the husky pre-commit hook and a CI job. It hard-fails on
**committed** surfaces (in the git index, or inside a committed submodule); an
_untracked, local_ artifact (your own `.vscode/tasks.json`, a local
`.claude/settings.local.json` hook) is an **advisory warning** only, so it never
blocks unrelated commits.

### Hardening details & known limits

Two adversarial reviews drove these (each is regression-tested):

- **MCP/hook configs that aren't under a surface dir** (`.mcp.json`, `.claude.json`)
  are byte-pinned as **root surface files**, so the structured allow-check is
  defense-in-depth, not the sole gate — a committed config can't add a server
  without a code-owned re-pin. The allow-check matches the command basename or a
  **file-like** arg only, so `npx <pkg>` (registry confusion), `python -m <mod>`,
  `node -r/--require/--import` preloads, dir-name spoofs, and code-injecting `env`
  (`NODE_OPTIONS`/`LD_PRELOAD`/`NODE_PATH`/…) are all rejected.
- **Git submodules** can't be byte-pinned (their contents live in another repo) and
  auto-load on `clone --recurse-submodules`, so a submodule mounted at/under a
  surface path is a hard violation, and a surface file _inside_ a submodule routes
  as committed → violation (not advisory). **Symlinked** surface dirs are rejected
  for the same reason (the link target isn't scanned).
- **Lifecycle script targets** are pinned even when **extensionless** (`postinstall:
"node ./bin/setup"`), and the gitignored-drop walk covers files `git ls-files`
  omits. `skipDirs` and `oversizeAllowlist` are **not** user-widenable (widening
  either would disarm the payload sweep).
- **Known limits (documented, low residual):** the structured TOML drift parser
  (`--global`) degrades to a whole-file hash alert on exotic inline tables (still
  not silent); Windows trailing-dot/space path folds are blocked by git's
  `core.protectNTFS` for committed paths rather than by the guard itself; and a
  **non-git** invocation (no CI/hook context) trusts a local `guard.config.json` —
  but `skipDirs`/`oversizeAllowlist` are non-widenable regardless, so it can't
  disarm the payload sweep. The real enforcement contexts (CI, pre-commit) are
  always git.

**When you legitimately change a surface**, re-pin in the SAME PR:

```
node scripts/guard-surfaces.mjs --update    # regenerates security/surface-pins.json
```

**The pins are the trust root, and CODEOWNERS review is what protects them.** The
CI job runs the guard _code_ from the base branch (so a PR can't weaken the guard
logic), but it reads `security/surface-pins.json` from the PR head — so a PR that
trojans a surface **and** re-pins it would pass the byte-pin check on content alone.
What stops that is the human gate: because `security/` is code-owned, a re-pin
cannot merge without a code-owner's review. This only holds when branch protection
has **"Require review from Code Owners"** enabled (see below) — without it, the
re-pin is unreviewed and the guard's byte-pin layer can be silently re-baselined.

### Reuse in another repo (drop-in)

`scripts/guard-surfaces.mjs` is **self-contained and zero-dependency** (node
builtins only). To protect any other repo:

```
cp scripts/guard-surfaces.mjs <repo>/scripts/
cd <repo> && node scripts/guard-surfaces.mjs --init
```

`--init` pins the current surfaces, wires a pre-commit hook (husky if present,
else a native `.git/hooks/pre-commit`), and writes `.github/workflows/surface-guard.yml`.
Commit `security/surface-pins.json`, then add the **`surface-guard`** check to that
repo's required status checks **and code-own `security/` + `scripts/`** (the guard
only blocks when the CI check is required and the trust root is reviewed). Tune for
non-npm layouts (Python/Go/monorepo) with an optional `security/guard.config.json`
overriding a subset of the defaults (`surfaceDirs`, `surfaceFiles`, `scriptExts`,
`mcpAllowlist`, `globalTargets`, …) — e.g. add `GEMINI.md`/`AGENTS.md`/`CLAUDE.md`
to `surfaceFiles` to pin those agent-instruction files too (left unpinned by
default since they double as hand-edited docs); absent ⇒ baked defaults. Overrides are **fail-closed** — the
config must be a **tracked** file (an untracked/gitignored one is ignored and
flagged), coverage lists are unioned with the defaults (never shrunk),
`maxFileBytes` can only drop, and `oversizeAllowlist` is **not** user-widenable, so
a committed config can't disarm the guard.

## Running agents safely

- **Treat an untrusted repo as hostile code.** Opening one with Claude Code,
  Cursor, Gemini CLI, or any agent can be RCE: a malicious `.claude/settings.local.json`
  hook, a `.mcp.json` / `.cursor/mcp.json` / `.gemini/settings.json` MCP server,
  or a `.cursor/hooks.json` (runs on `workspaceOpen` with no approval) / Gemini
  `hooks` block (folder-trust is off by default) auto-executes the moment you open
  the project. Review those files before trusting a repo, and run the surface
  guard against it.
- **Dispatch (the GitHub-issue fleet) only against repos you trust.** Dispatched
  workers run with auto-approve (`--dangerously-skip-permissions`) inside a
  worktree of the tracked repo, so that repo's content and config run with full
  power. The feature ships dormant (`mode=review`, disabled); keep tracked repos
  to ones you own.

## Out-of-repo persistence (global agent configs)

Once _any_ code runs (a script, a hook, a rogue MCP server, or a hijacked
auto-approve agent obeying a poisoned instruction), it can write your **global**
agent configs to re-run itself in **every future session, in any repo** — e.g.
`hermes mcp add evil`, an `mcpServers` entry in `~/.codex/config.toml` /
`~/.claude.json`, a global hook, or a shell-rc / cron entry. **The repo guard is a
commit-time tripwire for the repo — it cannot see or prevent this**, which is a
runtime concern.

Two layers address it:

- **Detect drift** (machine-local; run periodically or after a session you're
  unsure about):

  ```
  node scripts/guard-surfaces.mjs --global --update   # baseline ~/.codex, ~/.hermes, ~/.claude, ~/.cursor, ~/.gemini
  node scripts/guard-surfaces.mjs --global            # alert on any new/changed MCP server or hook
  ```

  Detection, not prevention — it fires _after_ a payload ran, and only watches the
  home-dir agent configs (`~/.codex/config.toml`, `~/.hermes/config.toml`,
  `~/.claude.json` + `~/.claude/settings.json`, `~/.cursor/mcp.json` +
  `~/.cursor/hooks.json`, `~/.gemini/settings.json`) — not shell-rc/cron, not the
  system-wide settings (`/etc/gemini-cli/*`, `C:\ProgramData\Cursor\hooks.json`),
  and not per-extension manifests (`~/.gemini/extensions/*/`). Stoa itself adds a
  global `stoa` Hermes server (`hermes mcp add stoa`), so that one entry is
  expected in the baseline.

- **Prevent the write** — the real fix is a **sandbox** that confines an agent to
  its worktree (no `~/` writes). Tracked on the roadmap as `SandboxedTransport`
  (Windows Job Object / macOS `sandbox-exec` / Linux namespaces); until then, the
  strongest mitigation is **not running auto-approve agents on untrusted repos**.

## Recommended repo settings (one-time, in GitHub UI)

- Branch protection on `main` → **required status checks**: add **`surface-guard`**
  and **`secret-scan`** alongside `ubuntu-latest` / `windows-latest` / `macos-latest`.
  **This is load-bearing** — the CI guard only _blocks_ a malicious PR once it's a
  required check (the pre-commit hook is bypassable with `git commit --no-verify`).
- Branch protection: also require PR + **review from Code Owners** + include
  administrators (already: PR + 3-OS CI + enforce_admins).
- Enable **secret scanning** + **push protection**.
- Enable **Dependabot** alerts/updates; keep the lockfile committed.
- Rotate any credential that was exposed to a compromised machine — assume burned.
