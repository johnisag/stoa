# Kimi Swarm — Consolidated Findings

_Generated 2026-06-15 — replaces the 35 raw `.kimi/swarm/` files (removed in the same change)._

> **Provenance.** This document consolidates the output of the Kimi autonomous-swarm run
> (35 raw per-subsystem files under `.kimi/swarm/`: 20 `bugs-*`/`review-bugs-*` reports and
> 15 `research-*` reports). Those raw files are **removed in this change**; this is the single
> surviving record. Every reported bug was **re-verified against current code on `main` after PRs
> #253–#260**, and every research file was **deduped against
> `competitor-wins-kimi.md` and `docs/ROADMAP.md`**. Only what is
> still true and still worth keeping is retained here. (`competitor-wins-kimi.md` is gitignored /
> local-only, not present in a fresh clone.)
>
> **Bottom line:** of ~154 reported bug findings, **9 remain genuinely open** (all LOW or
> MEDIUM; several latent / needs-human-check) — the 4 workflow-builder papercuts were fixed in
> **#271** (unsaved-edit guard, whitespace-name reject, get-after-insert guard, PipelineGraph
> marker id). Of ~77 research wins across 15 competitor areas, **0 are net-new** — they are
> already captured verbatim in `competitor-wins-kimi.md`.

---

## Still-open bugs

Severity sorted HIGH→LOW within each group. Tags: `confirmed-open` (reproduced in current
code), `likely-open` (code unchanged, impact is an edge case), `needs-human-check` (latent or
requires live-OS confirmation).

### core-backend

- **[MEDIUM / needs-human-check] Windows `.cmd`/`.bat` agent spawn can orphan the child process tree on kill (pty path).**
  `lib/session-backend/pty/registry.ts:67-69` (`resolveSpawn` wraps `.cmd`/`.bat` as
  `cmd.exe /c resolved …`, so node-pty holds **cmd.exe's** PID) + `lib/session-backend/pty/pty-session.ts:336-349`
  (`killAndWait` on Windows does only `process.kill(pid)` on that single wrapper PID — no
  `taskkill /T` tree kill). The sibling path `ClaudeProcessManager.cancelSession`
  (`lib/claude/process-manager.ts:241-260`) **was** fixed to `taskkill /pid <pid> /T /F`, but
  that fix was not ported to the pty-registry kill path the `SessionBackend` actually uses.
  conpty teardown may mitigate in common cases — needs a Windows runtime check; the asymmetry
  vs. the `cancelSession` fix is the concrete evidence the gap was not closed here.

- **[LOW / likely-open] Default pty-host socket/pipe name is global (two users or two Stoa instances collide).**
  `lib/session-backend/pty/protocol.ts:36` — `hostAddress()` defaults to a fixed basename
  `"stoa-pty-host"` (Windows `\\.\pipe\stoa-pty-host`, POSIX `os.tmpdir()/stoa-pty-host.sock`)
  when `STOA_PTY_HOST_NAME` is unset; no per-user qualifier (UID/username/profile hash) was
  added. Two users on one multi-user host, or two instances, bind/connect the same global
  address. Tests isolate via `STOA_PTY_HOST_NAME`, which masks it in CI but does not fix the
  runtime default. (Reported as bugs-session-backend #12.)

- **[LOW / needs-human-check] `TmuxBackend.q()` does not escape shell metacharacters (`$`, backtick, `\`, `!`) inside double quotes.**
  `lib/session-backend/tmux-backend.ts:28-30` (`q`) and its callers
  `create()/kill()/rename()/sendKeysInterpreted()`. AGENTS.md says the backend owns escaping,
  so the contract is unmet — but every name reaching the backend is an internally-generated
  `sessionKey()` (`${provider}-${uuid}`, `lib/providers/registry.ts:292-295`) or a stored
  `tmux_name`, never user-controlled. A latent contract/hardening gap, not a reachable injection
  today; report only after confirming no caller ever passes attacker-influenced names.

### dispatch + data + providers

- **[MEDIUM / confirmed-open] `buildSpawnForSession` drops `mcp_launch_args` on Pane re-attach (Codex conductors lose stoa MCP wiring).**
  `lib/client/backend.ts:44-63` builds the pty spawn via `buildAgentArgs` with only
  sessionId/parentSessionId/autoApprove/model/initialPrompt — it never reads
  `session.mcp_launch_args`. The parallel server path (`app/page.tsx:374-398`) **does** parse
  it into `extraArgs`. `components/Pane/index.tsx:330` (re-attach) and `:360` (attach-to-worker)
  both call `buildSpawnForSession`, and the pty server treats spawn as create-if-missing, so a
  Codex conductor session respawned after a server restart re-launches **without** its persisted
  `-c mcp_servers.stoa.*` flags. Fix is to mirror `page.tsx`'s parse. Windows/pty-only (tmux
  reuses the live session). (Provider report #1.)

- **[LOW / confirmed-open] Multi-repo stage/unstage mutations ignore HTTP status.**
  `data/git/queries.ts:393-394` (`useMultiRepoStageFiles`) and `416-417`
  (`useMultiRepoUnstageFiles`) only do `const data = await res.json(); if (data.error) throw`.
  The single-repo hooks were fixed to `!res.ok || data.error` (lines 188, 209); the two
  multi-repo variants were missed. A 5xx with no `error` field is treated as success.
  (data-queries #6.)

- **[LOW / needs-human-check] `spawnWorker` does not wire orchestration MCP args / `mcp_launch_args` for Codex workers.**
  `lib/orchestration.ts:26-34, 196-199` — `spawnWorker` passes only `{model, autoApprove:true}`
  to `buildAgentArgs/buildFlags`; `SpawnWorkerOptions` has no `enableOrchestration`/`extraArgs`
  field and never writes `mcp_launch_args` or generates Codex `-c mcp_servers.stoa.*` wiring. A
  worker spawned via the orchestrate route / pipeline executor therefore can't itself act as a
  conductor, and a Codex worker has no stoa MCP server. Whether nested conductors are a supported
  feature is a product decision — flagging for review rather than asserting a defect. (Provider
  report #2.)

### workflows + scripts + tests

- **✅ FIXED (#271). [LOW] saved-workflow API accepts a whitespace-only name (no trim/reject).**
  `app/api/saved-workflows/route.ts:31` (POST) and `app/api/saved-workflows/[id]/route.ts:48`
  (PATCH) only check `!name || typeof name !== "string"`; `lib/saved-workflows.ts:72-83`
  (`createSavedWorkflow`) persists `input.name` verbatim with no `.trim()`. A name like `"   "`
  is a truthy string, so it passes and is stored. The UI `saveGuard` trims before calling, but a
  direct API call (or the persisted display name) keeps whitespace names. (workflows #8.)

- **✅ FIXED (#271). [LOW] `createSavedWorkflow` casts the get-after-insert row without a guard.**
  `lib/saved-workflows.ts:80-82` —
  `return toSavedWorkflow(queries.getSavedWorkflow(db).get(id) as SavedWorkflowRow);`. The
  re-fetched row is cast straight through with no `if (!row) throw`; `toSavedWorkflow`
  dereferences `row.id/row.name/row.builder_doc`, so a missing row throws a confusing TypeError.
  In practice the row was just inserted in the same synchronous better-sqlite3 call, so it is
  effectively always present (hence LOW). (workflows #9.)

- **✅ FIXED (#271). [LOW] "New workflow" and "Load example" discard unsaved edits with no confirmation.**
  `components/views/WorkflowsView/WorkflowBuilder.tsx:851`
  (`onSelect={() => loadDoc(EMPTY_DOC, null)}`) and `:854` (`loadDoc(EXAMPLE_DOC, null)`) call
  `loadDoc` directly with no dirty-check; `loadDoc` immediately `reset()`s the doc, losing
  in-progress edits. The sibling transitions were hardened (`loadSnapshot` gates at :245-258,
  `handleImportFile` at :660-668, `handlePasteImport` at :467-475); these two menu items still
  wipe a dirty draft silently. (Residual of workflows #2.)

- **✅ FIXED (#271). [LOW] `PipelineGraph` hardcoded SVG marker id can collide across simultaneous instances.**
  `components/views/WorkflowsView/PipelineGraph.tsx:52` (`id="stoa-graph-arrow"`) and `:83`
  (`markerEnd="url(#stoa-graph-arrow)"`). Not a `useId()`-generated value, so two `PipelineGraph`s
  mounted at once (e.g. Custom preview + a RunDetail dependency graph) both define the same id and
  every `markerEnd` resolves to the first in document order. Cosmetic only (both markers render an
  identical arrow), hence borderline. (workflows #6.)

- **[LOW / needs-human-check] Installer prerequisite / AI-CLI scripts still `curl | bash` remote code without checksum pinning.**
  `scripts/lib/prerequisites.sh:162,219,254,258` and `scripts/lib/ai-clis.sh:26` (sourced by
  `scripts/stoa install`, exec'd by `scripts/install.sh`). Homebrew, fnm, Claude, and NodeSource
  setup scripts are fetched and piped to bash with no SHA pin (e.g.
  `/bin/bash -c "$(curl -fsSL …Homebrew/install/HEAD/install.sh)"`,
  `curl -fsSL https://claude.ai/install.sh | bash`). Mitigations since the report: a
  `remote_install_guard` opt-in prompt now gates each install path and install.sh/install.ps1
  carry a SECURITY NOTE. This is the documented curl-pipe-bash install method (a deliberate trust
  boundary) — fixable bug vs. accepted design is a judgement call. (scripts-config #4 / critic #3.)

### api + platform

- **[LOW / confirmed-open] Legacy tmux WebSocket pty spawn hardcodes `/bin/zsh` + `process.env.HOME` + POSIX `PATH` fallback.**
  `server.ts:744-761` (`handleTmuxConnection`) — verbatim:
  `const shell = process.env.SHELL || "/bin/zsh";`,
  `PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin"`, `HOME: process.env.HOME || "/"`,
  and `cwd: process.env.HOME || "/"`. Violates AGENTS.md (no hardcoded `/bin`, no
  `process.env.HOME`). **The original "will fail on Windows" framing is stale** —
  `handleTmuxConnection` only runs when `getBackendType() !== 'pty'` (`server.ts:219-220`), i.e.
  the macOS/Linux tmux backend (Windows always uses pty). So it's a real **POSIX-path** style/AGENTS
  defect, not a Windows breakage. The identical sites elsewhere (`defaultInteractiveShell`,
  pty-backend, pty/registry, process-manager) were all fixed to use
  `defaultInteractiveShell()`/inherited PATH; this legacy path was missed.

- **[LOW / likely-open] pty-host Unix domain socket placed in `os.tmpdir()` can exceed `sun_path` length limit.**
  `lib/session-backend/pty/protocol.ts:40` (`hostAddress`) —
  `return path.join(os.tmpdir(), `${name}.sock`);`. On macOS/Linux a deep `TMPDIR` pushes the
  socket path past the ~104-108 char `AF_UNIX` `sun_path` limit, so `bind()` fails. POSIX-only
  (Windows uses a named pipe at line 38). `STOA_PTY_HOST_NAME` can shorten the basename but the
  tmpdir prefix is uncontrolled. Low-probability edge case. (bugs-platform.)

### ui + hooks

**None still open.** All 18 distinct reported items (8 components-ui + 10 hooks/stores, plus 2
critic must-fixes that duplicate originals) were verified fixed or stale in current code.

---

## Net-new feature / research ideas

**None.** All 15 competitor-research areas produced by the swarm are reproduced **verbatim**
inside `competitor-wins-kimi.md` as dedicated `## Area:` sections —
each source file maps 1:1 to a section (byte-for-byte, including every "Why it matters", effort
estimate, Stoa-area mapping, honorable-mentions tables, and source lists). There is nothing in
the raw research files that the aggregate omits, so there is nothing net-new to surface here.

For reference, the 15 covered areas and their location in `competitor-wins-kimi.md`:

| Group                       | Areas (anchor lines in competitor-wins-kimi.md)                                                  |
| --------------------------- | ------------------------------------------------------------------------------------------------ |
| Canvas / workflow-builder   | `canvas-nav` (L39), `reactflow` (L1806), `n8n` (L1400), `windmill` (L2121), `make-zapier` (L967) |
| Agent / editor UX           | `claude-code` (L152), `cursor` (L530), `copilot-workspace` (L381), `command-palette` (L292)      |
| Terminal / mobile           | `modern-terminal` (L1231), `vscode-terminal` (L1945), `mobile-touch` (L1057)                     |
| Deploy / error / onboarding | `deployment-ux` (L688), `error-ux` (L814), `onboarding` (L1632)                                  |

Status note: a few of these areas are partially **shipped** already (the `⌘K` command lane in
Wave 1 #215; the Ask/Command Stoa chatbox with per-provider model picker #223/#225/#226 overlapping
Copilot/Cursor mode+model wins; #260's run-board worktree surfacing overlapping make-zapier
run-status chips). The remainder are listed in the doc's own Status Snapshot (L37) as
**"Pending / backlogged"** — captured-but-unbuilt, which still counts as "already captured" per
the task definition. None of the canvas micro-interaction wins (spacebar-drag pan, fit-to-view,
minimap, keyboard pan/zoom/focus, auto-scroll selected node, inline output token picker, per-step
"test this step", etc.) have shipped, but all are already documented.

---

## What was already handled

- **~141 reported bugs are already fixed or stale** across PRs #253–#260 (the dragon-hunt
  campaign), leaving only the 13 LOW/MEDIUM items above. Per-group disposition of reported
  findings: **api+platform** 41 fixed/stale → 2 open; **core-backend** 17 fixed/stale → 3 open;
  **dispatch+data+providers** 36 fixed/stale → 3 open; **ui+hooks** 18 fixed/stale → 0 open;
  **workflows+scripts+tests** 29 fixed/stale → 1 open (4 more fixed in #271: the
  unsaved-edit guard, whitespace-name reject, get-after-insert guard, PipelineGraph marker id). Notable confirmed fixes: `/api/exec`
  deleted; the central `lib/api-security.ts` hardening module (loopback-pinned `looksLocal` via
  server-injected `x-stoa-remote-addr`, Windows-safe `tokenizeCommand`, connection-IP rate limit,
  SHA-pinned auto-merge / manual-merge refusal of unpinned gated merges, projectId path
  re-validation); path sandboxing across files/git/orchestrate/dispatch/sessions; `shell:false` +
  `tokenizeCommand` + `cmd.exe /c` routing on dev-servers; input bounds everywhere;
  `defaultInteractiveShell()` de-hardcoding; the dispatch-fleet SHA-pin race; orphaned-session-row
  cleanup; `taskkill /T /F` in `cancelSession`; ~26 of 27 data-query `res.ok` checks; the workflow
  rename/`{{steps.*.output}}` placeholder rewrite and duplicate-step dedupe; and the kilo/kimi
  provider test + catalog gaps.

- **Two adjacent NEW concerns** were surfaced during verification (not part of the original reports,
  flagged needs-human-check if pursued): (1) `app/api/git/commit-message/route.ts:28-35` and the
  summarize route spawn `claude` with `resolveBinary` + `shell:false` but do **not** route a `.cmd`
  shim through `cmd.exe` (per the documented Windows `.cmd`-spawn EINVAL gotcha) — adjacent to the
  dev-servers fix; (2) the pty-registry kill-path tree-kill gap listed under core-backend above.

- **The competitor research is already captured** in
  `competitor-wins-kimi.md`: the swarm authored the 15 `research-*`
  files and then folded them, unchanged, into that aggregator. `docs/ROADMAP.md` remains the single
  backlog source for what's shipped vs. parked. No research content is lost by deleting the raw
  files.
