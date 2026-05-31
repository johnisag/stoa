# AgentOS — Next Session Plan

Continuation after the native-Windows migration (branch `feat/windows-native-migration`).
Today ended with the `PtyTransport` refactor (unifying the two pty backends + WS
handlers). This plan is ordered by priority.

---

## 0. Headline: Hermes support ⭐ — DONE (core) + follow-ups

Hermes is a Claude-Code-style TUI agent (`hermes`) that runs natively on
Win/mac/Linux and self-authenticates → it dropped into the provider system and
renders through the pty backend with no special casing.

**Done:** provider registry + object, agent picker entry, `--yolo` auto-approve,
and the full CLI surface mapped from `hermes --help`
(`-z PROMPT`, `-m MODEL`, `--resume SESSION`, `--continue`, `--yolo`,
`--pass-session-id`).

**Follow-ups (each is real work, not a one-liner):**

- **-z initial prompt** — confirm `hermes -z "..."` stays interactive (TUI) vs
  one-shot. If interactive, set `initialPromptFlag: "-z"`.
- **Resume** — capture Hermes's session id (`--pass-session-id` and/or read
  `~/.hermes/checkpoints/` / `hermes sessions`), store it, then flip
  `supportsResume: true` so `--resume <id>` works per AgentOS session.
- **Model selection** — Hermes models are dynamic (`hermes model` live-fetches
  each provider's `/v1/models`). To offer `-m` correctly, add a free-text model
  field (or a Hermes model fetch) instead of the static Claude dropdown.
- **Status detection** — tune busy/waiting patterns once we observe Hermes's
  actual working/confirmation output (currently reuses Claude-style markers).

---

## (original Hermes notes, for reference)

Add **Hermes** as a first-class agent in AgentOS.

> **Scope to confirm:** what is Hermes, exactly, in AgentOS terms?
>
> - **(a) A CLI agent** (like claude/codex/aider) → add a provider registry entry
>   and it mostly "just works" through the existing provider abstraction.
> - **(b) An OpenAI-compatible / Open WebUI model gateway** → support pointing an
>   agent at a Hermes endpoint (base URL + model + key), likely via env/config.
> - **(c) Its own harness** (cf. the `hermes-agent-prs` / `hermes-setup` repos) →
>   may need bespoke launch + status-detection patterns.
>   The work below assumes (a)/(c) — a provider — and notes where (b) differs.

Tasks:

1. **Registry entry** in `lib/providers/registry.ts`: `id: "hermes"`, `cli`, `configDir`,
   `autoApproveFlag`, `resumeFlag`/`supportsResume`/`supportsFork`, `modelFlag`,
   `initialPromptFlag`, `defaultArgs`. The generic `buildAgentArgs` then covers the
   pty path automatically; add a `buildFlags` case only if the tmux path needs it.
2. **Provider object** in `lib/providers.ts` (metadata + status-detection
   `waitingPatterns`/`runningPatterns`/`idlePatterns` tuned to Hermes' TUI/output).
3. **Windows binary resolution**: confirm the Hermes binary/shim resolves via
   `resolveBinary` (.cmd/.exe/PATHEXT) and spawns through the pty registry.
4. **Status detection**: verify `status-detector` busy/waiting heuristics fire on
   Hermes' rendered output (it currently keys off Claude-style "esc to interrupt" /
   spinner / `[Y/n]`). Add Hermes-specific markers if needed.
5. **Session id / resume**: if Hermes has a resume concept, wire it; otherwise
   `supportsResume: false`. The `claude-session`/JSONL path is Claude-specific.
6. **(If gateway, option b)**: a per-session "endpoint/model/key" config surfaced in
   the New Session dialog, passed via env to the agent.
7. **README + supported-agents table** row for Hermes; a smoke test.

Open question for the morning: confirm which of (a)/(b)/(c) Hermes is, and whether
it runs on Windows natively (so it fits the new pty backend) or needs WSL.

---

## 1. Real-runtime verification on Windows (the remaining gate)

Everything builds + 28 tests pass, but these need a human at a real browser/agent:

- [ ] Interactive flow: create a session, watch a real agent spawn → stream → resize → reconnect.
- [ ] `.cmd` spawn of each agent CLI through ConPTY (claude confirmed; verify others).
- [ ] **Tier-2 restart-survival**: start a session, restart the AgentOS server, reattach — session intact.
- [ ] Orchestration (conductor/workers) on native Windows (uses the argv path; banner is POSIX-only).
- [ ] Shell drawer, file picker (drive roots), Git panel against a real repo, PR flow.
- [ ] Confirm the `.github/workflows/test.yml` matrix goes green on ubuntu/macos/windows.

## 2. Performance follow-ups (from the perf review)

- [ ] `PtySession` raw ring buffer: `rawBuffer += data` + `.slice()` per chunk is O(256KB)
      per chunk once full. Since `serialize()` is now the repaint path, consider
      shrinking or removing the raw buffer (it's only a fallback) → big CPU+mem win.
- [ ] Status polling: capture once per session (not `getStatus` capture + `getLastLine`
      capture) and **cache `claudeSessionId`** instead of re-scanning the project dir
      every poll (`getClaudeSessionIdFromFiles` does fs reads per poll per session).
- [ ] Reduce `HEADLESS_SCROLLBACK` (5000) — status/preview only read the visible screen;
      summarize reads ≤500 lines. ~1000 is plenty and cuts per-session memory.
- [ ] Tier-2 IPC: frame output as length-prefixed raw bytes instead of JSON-string-escaping
      every chunk (and encode once per chunk, not per viewer).

## 3. Architecture follow-ups (from the architecture review)

- [ ] Finish/verify the `PtyTransport` unification done today (one WS handler + one
      backend parameterized by transport; `HostBackend` = `PtyBackend(remoteTransport)`).
- [ ] Collapse the `create()` dual representation: discriminated spec
      `{kind:"argv",...} | {kind:"shell",...}`, ideally letting the tmux backend build
      its banner from argv → unifies `buildFlags`(string) and `buildAgentArgs`(argv).
- [ ] Centralize session-key construction (`sessionKey({kind:'agent'|'shell',...})`)
      so the namespace is enforced in one place (today it's string-built at 5 sites).
- [ ] Finish converting `lib/pr.ts` remaining `execSync` reads to `execFile` argv arrays.

## 4. Security / product decisions (from the security review — pre-existing posture)

These predate the migration but are worth a deliberate call:

- [ ] WS/HTTP binds `0.0.0.0` with no auth (intentional for Tailscale mobile access).
      Decide: default to loopback + opt-in `0.0.0.0`, and/or add a WS auth token / origin check.
- [ ] `/api/exec` and the file APIs are unauthenticated + unconfined to project roots.
- [ ] Agent ptys inherit the full server env (matches "agent runs as you"; offer an
      allowlist option if running in a shared/hosted context).

## 5. Product polish (from ideas.md, aligned with the new engine)

Pick a couple that now fit cleanly on the native backend:

- [ ] Notifications when a session needs attention (waiting/error/done) — status detector already classifies.
- [ ] Session search / fuzzy switch across conversations.
- [ ] Export conversation to Markdown/JSON.
- [ ] Keyboard shortcuts for navigation.

## 6. Ship

- [ ] Update `migration-plan.md` status (Phase 6 done, Tier-2 default).
- [ ] README: native Windows section is in; add Hermes + verify install paths.
- [ ] Decide PR-to-upstream vs standalone fork (see discussion) and act on it.
- [ ] **Fork identity (if going standalone):** decide on a project name, then update
      `LICENSE` (currently MIT, "Saad Naveed"), `package.json` (`name`
      `@saadnvd1/agent-os`, `author`, `repository`, `bugs`, `homepage`), README
      title/badges, and the install/update URLs. Keep the upstream copyright line
      in LICENSE per MIT terms; add your own. — "we'll see" / TBD.
- [ ] Tag a release once Windows runtime verification passes.
