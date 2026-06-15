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
> **Bottom line:** of ~154 reported bug findings, **2 remain open — and both are deliberate
> human-decision items, not unfixed defects** (`spawnWorker` Codex-worker MCP wiring = a product
> decision on nested conductors; the installer `curl|bash` = an accepted trust boundary already
> gated by an opt-in guard). Everything cleanly fixable is now closed: the 4 workflow-builder
> papercuts in **#271**; the MEDIUM Codex-MCP re-attach drift in **#273** (single
> `parseMcpLaunchArgs`); the multi-repo git `res.ok` item, which turned out to be a 26-site
> **bug class**, in **#275** (sweep+verify workflow found 21, review found 5 more); and the final
> 5 latent cross-platform items in **#277** (Windows pty tree-kill, per-user pty-host socket
> name, `sun_path` length, `TmuxBackend.q()` escaping, `server.ts` POSIX hygiene). Of ~77
> research wins across 15 competitor areas, **0 are net-new** — they are already captured
> verbatim in `competitor-wins-kimi.md`.

---

## Still-open bugs

Severity sorted HIGH→LOW within each group. Tags: `confirmed-open` (reproduced in current
code), `likely-open` (code unchanged, impact is an edge case), `needs-human-check` (latent or
requires live-OS confirmation).

### core-backend

- **✅ FIXED (#277). [MEDIUM] Windows `.cmd` agent spawn orphaned the child process tree on kill (pty path).**
  `PtySession.killAndWait` did only `process.kill(pid)` on the conpty/cmd.exe wrapper PID — no
  `taskkill /T` tree kill — so the shim → node → agent descendants survived. Now reaps the whole
  tree via `taskkill /T /F` through the shared `killTreeArgs` helper (moved to `lib/platform.ts`;
  `cancelSession` converged onto it too, so all three call sites share one source). Regression in
  `test/pty-session-killtree.test.ts`.

- **✅ FIXED (#277). [LOW] Default pty-host socket/pipe name was a fixed global (two users/instances collided).**
  `hostAddress()` now suffixes the default name with a short per-user token (hashed uid, else
  username) so two users on one host don't bind the same `\\.\pipe\stoa-pty-host` / `*.sock`.
  `STOA_PTY_HOST_NAME` still overrides for test isolation. Regression in
  `test/pty-protocol-address.test.ts`.

- **✅ FIXED (#277). [LOW] `TmuxBackend.q()` did not escape shell metacharacters (`\ " $ \``) inside double quotes.**
  `q()` now backslash-escapes the chars active inside the double-quoted wrapper. Names reaching
  the backend are internally generated (`sessionKey()` = `${provider}-${uuid}`) so it was a
  latent contract gap (AGENTS.md: "the backend owns escaping"), not a reachable injection — and
  the escape is a no-op for those names, so the locked tmux command strings are unchanged.

### dispatch + data + providers

- **✅ FIXED (#273). [MEDIUM] `buildSpawnForSession` dropped `mcp_launch_args` on Pane re-attach (Codex conductors lost stoa MCP wiring).**
  `lib/client/backend.ts` built the pty spawn via `buildAgentArgs` without ever reading
  `session.mcp_launch_args`, while the parallel server path (`app/page.tsx`) **did** parse it
  into `extraArgs`. Since the pty server treats spawn as create-if-missing, a Codex conductor
  respawned on re-attach (e.g. after a server restart) silently relaunched **without** its
  persisted `-c mcp_servers.stoa.*` flags. Root cause = the two spawn paths had drifted; fixed
  by a single shared `parseMcpLaunchArgs` (`lib/providers.ts`) that both paths now route through
  (so they can't drift again), with a `console.warn` on malformed input. Regression locked by
  `test/client-backend.test.ts`. Was Windows/pty-only (tmux reuses the live session).
  (Provider report #1.)

- **✅ FIXED (#275). [LOW→class] Multi-repo stage/unstage mutations ignored HTTP status — the
  tip of a 26-site bug class.**
  The two flagged sites (`useMultiRepoStageFiles`/`useMultiRepoUnstageFiles`) did
  `const data = await res.json(); if (data.error) throw`, treating a 5xx with no `error` field
  as success. A sweep+verify workflow found the same class (response body trusted without
  `res.ok`) in **21** handlers across `data/`, `components/`, `lib/`, and the client `app/`; the
  3-agent review found **5** more (`.then(r => r.json())` chains + fire-and-forget mutations).
  All fixed with the repo's `if (!res.ok || data.error)` template, adapted per handler.
  Regression locked by `test/git-queries-res-ok.test.tsx` + `test/bugfix-b006.test.ts`.
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

- **✅ FIXED (#277). [LOW] Legacy tmux WebSocket pty spawn hardcoded `/bin/zsh` + `process.env.HOME` + POSIX `PATH` fallback.**
  `server.ts handleTmuxConnection` (POSIX-only — only runs under the tmux backend) violated
  AGENTS.md. Now uses `defaultInteractiveShell()` + `homeDir()` + inherited `PATH` instead of the
  hardcoded `/bin/zsh`, `process.env.HOME`, and `/usr/local/bin:/usr/bin:/bin` fallbacks.

- **✅ FIXED (#277). [LOW] pty-host Unix domain socket could exceed the `sun_path` length limit.**
  `hostAddress()` now falls back to `/tmp` when `path.join(os.tmpdir(), name.sock)` would exceed
  a conservative `sun_path` budget (a deep `TMPDIR` overflowing `AF_UNIX` ~104-108 bytes), and
  warns in the pathological both-overflow case. POSIX-only (Windows uses a named pipe).

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
