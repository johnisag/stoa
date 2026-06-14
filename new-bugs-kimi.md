# Stoa Bug-Hunting Swarm Report

Generated: 2026-06-14T14:54:11Z

This file aggregates findings from 15 bug-hunting agents that scanned the Stoa codebase.

## Status Snapshot (2026-06-14)

The following items have been addressed in PR #251 (`618fcf8`) and are now on `main`:

- **API security hardening** — `/api/exec` was deleted; `lib/api-security.ts` was introduced with localhost gating, project-root path sandboxing, and per-connection-IP rate limiting. Many path-accepting routes now resolve inputs inside the workspace.
- **Session path validation** — session attach rejects non-worktree / out-of-workspace paths; PATCH re-validates `working_directory` against the project root.
- **Dev-server / command spawning** — `setup.js` uses `execFileSync` with argv arrays; dev-server and orchestration routes were updated.
- **Verdict inbox** — retry branches by item type.
- **Auto-merge safety** — merge endpoints now pass `matchHeadCommit` from `review_sha`; reviewer reads `headRefOid` in the same `gh pr view` call.
- **PTY host** — rename re-keys per-connection attached subscriptions.
- **Workflow builder** — `renameStep` avoids `$` interpolation; nodes and notes get a "Go to definitions" context menu; the canvas fills the pane height; worker sessions open in a new terminal tab.
- **Accessibility / UI** — `SegmentedTabs` gets roving tabindex + keyboard navigation; `useFileEditor.closeFile` uses a ref mirror to avoid stale closures; minor fixes to `badge`, `button`, `dialog`, `dropdown-menu`, and `skeleton`.
- **Database migration safety** — migration 35 guards the `review_sha` ALTER TABLE with `hasTable`.
- **Security pins** — `security/surface-pins.json` was re-pinned after legitimate script/package changes.
- **Regression tests** — added for Windows paths, remote-IP localhost `Host` header handling, whitespace in step ids, rename re-key, same-call SHA read, and pane tab views.

**Pending / backlogged:** all remaining sections in this file (Claude integration, `data/` query error handling, hooks/stores races, `lib/db`, platform-specific POSIX hardcoded paths, provider catalog freshness, scripts/config, session-backend, test gaps, and the rest of the workflows items) are not yet addressed and remain in the backlog.

## Area: app-api

# Bug Review: `app/api/` Route Handlers

Project: `C:/my-projects/stoa-clean`  
Scope: Every route file under `app/api/`  
Date: 2026-06-14

## Summary

A security-focused scan of the 99 route handlers in `app/api/` found **several critical and high-severity issues**, concentrated around arbitrary command execution, arbitrary filesystem access, missing authentication, and unvalidated user paths. Most other handlers are reasonably well-written but share a common lack of auth guards and input size/path limits.

| Severity | Count |
| -------- | ----- |
| Critical | 6     |
| High     | 9     |
| Medium   | 10    |
| Low/Info | 5     |

---

## Critical

### 1. `/api/exec` — Remote Code Execution via shell-string `exec`

**File:** `app/api/exec/route.ts`  
**Severity:** Critical

The endpoint runs the user-supplied `command` string through `child_process.exec` with an explicit shell when `STOA_ENABLE_EXEC=1`. It is the only route in the codebase that still uses a shell-string `exec` instead of `execFile`, directly contradicting `AGENTS.md` ("No shell-string `exec` with pipes/redirects"). It also hardcodes `/bin/zsh` on POSIX and reads `process.env.HOME`, which is unset on Windows. There is no authentication, so anyone who can reach the dev server can run arbitrary shell commands.

**Recommended fix:**

- Remove this endpoint entirely, or if it must exist, require strong authentication and use `execFile` with an argv array.
- Never invoke a shell; parse any needed output in JS.
- Use `homeDir()` and `defaultInteractiveShell()` from `lib/platform.ts` instead of `process.env.HOME` or `/bin/zsh`.

---

### 2. `/api/sessions/init-script` — Shell injection in generated init script

**File:** `app/api/sessions/init-script/route.ts` (and `lib/banner.ts`)  
**Severity:** Critical

`agentCommand` from the request body is interpolated directly into a generated bash script at `exec ${agentCommand}` without escaping or validation. The script is written with mode `0o755` and later executed via `bash <path>`. An attacker can inject shell metacharacters (`;`, `|`, `&&`, command substitution, etc.) into `agentCommand`.

**Recommended fix:**

- Do not interpolate user input into shell scripts.
- If a wrapper script is required, write the command as an argv array and execute it directly, or escape every shell-special character using a robust shell-escaping helper.
- Validate `agentCommand` against an allowlist of known-safe tokens.

---

### 3. `/api/files/content` — Arbitrary file read/write

**File:** `app/api/files/content/route.ts`  
**Severity:** Critical

Both GET and POST accept a `path` parameter, expand `~` with `expandHome()`, and pass the result to `readFileContent`/`writeFileContent`. There is no sandbox, no project validation, and no traversal check beyond tilde expansion. A caller can read or overwrite any file the Node process can access (e.g., `~/../etc/passwd`, SSH keys, `.env`, source files).

**Recommended fix:**

- Resolve all paths under a known project root and reject any path that escapes it (`path.resolve(root, input)` must start with `root + path.sep`).
- Require the path to belong to a registered project/repository.
- Reject requests that resolve outside the workspace.

---

### 4. `/api/files` — Arbitrary directory listing

**File:** `app/api/files/route.ts`  
**Severity:** Critical

The GET handler accepts `path`, expands `~`, resolves it with `path.resolve`, and lists the directory. No sandbox or project binding. An attacker can enumerate the entire filesystem (e.g., `/?path=/` or `?path=~/../..`).

**Recommended fix:**

- Same as `/api/files/content`: confine paths to a registered project root and reject traversals.
- Limit recursion depth and maximum entries on the server side.

---

### 5. `/api/dev-servers` (POST) — Shell injection via dev-server command

**File:** `app/api/dev-servers/route.ts` (and `lib/dev-servers.ts`)  
**Severity:** Critical

The POST handler stores user-supplied `command` and `workingDirectory` and later runs `spawn(command, [], { shell: true, ... })`. Because `shell: true` is enabled and `command` is taken verbatim from the request, an attacker can execute arbitrary shell commands. The project-level dev-server routes (`/api/projects/[id]/dev-servers` and `/api/projects/[id]/dev-servers/[dsId]`) store the same unvalidated command for later execution.

**Recommended fix:**

- Do not use `shell: true` for user-defined commands.
- Parse the command into an argv array (or restrict it to a known-safe set of templates) and pass it as `spawn(binary, args, { shell: false })`.
- Validate `workingDirectory` against the project directory and reject escapes.

---

### 6. `/api/orchestrate/spawn` — Shell injection via worker spawn

**File:** `app/api/orchestrate/spawn/route.ts`  
**Severity:** Critical

The route forwards `workingDirectory`, `branchName`, `task`, `agentType`, and `model` directly to `spawnWorker` without validation. Depending on the orchestration implementation, `workingDirectory`/`branchName`/`task` may be interpolated into shell commands or git arguments, leading to command injection and arbitrary repository operations.

**Recommended fix:**

- Validate `workingDirectory` against registered project/repository roots.
- Validate `agentType` against the provider registry and `model` against the model catalog (the route already validates agent type but not the directory).
- Ensure `spawnWorker` uses `execFile`/`spawn` with argv arrays and `shell: false`.

---

## High

### 7. No authentication/authorization on any route

**Files:** All `app/api/**/*.ts`  
**Severity:** High

Every route handler is unauthenticated. If the dev server is reachable from the local network or exposed (e.g., via `npm run dev` on `0.0.0.0`), any client can create/destroy sessions, push code, open/merge PRs, delete worktrees, read/write arbitrary files, and run shell commands (when enabled). This is a systemic issue rather than a single bug.

**Recommended fix:**

- Add a lightweight auth middleware or Same-Site cookie/session check for the API.
- At minimum, bind the dev server to `localhost` by default and document the risk of running on `0.0.0.0`.

---

### 8. `/api/sessions` (POST) — Unvalidated `workingDirectory` can target arbitrary paths

**File:** `app/api/sessions/route.ts`  
**Severity:** High

The new-session route accepts `workingDirectory` directly from the body and only expands `~`. It is not checked against the project’s registered directory, so a caller can create sessions that operate on arbitrary directories. When combined with `useWorktree`, `enableOrchestration`, or workspace mode, Stoa will create worktrees, write `.mcp.json` conductor configs, and run setup scripts on attacker-chosen paths.

**Recommended fix:**

- When `projectId` is supplied, require `workingDirectory` to resolve inside the project directory.
- Reject paths that escape the project root or do not exist.
- Apply the same check to `existingWorktreePath` and `workspaceRepos`.

---

### 9. `/api/sessions/[id]` (PATCH) — Can redirect session to arbitrary path

**File:** `app/api/sessions/[id]/route.ts`  
**Severity:** High

The PATCH handler accepts `body.workingDirectory`, `body.status`, `body.groupPath`, `body.systemPrompt`, and `body.name` without validation. Updating `workingDirectory` can point an existing session at an arbitrary directory; `status` can be set to any string; `name` can be arbitrarily long.

**Recommended fix:**

- Validate `workingDirectory` against the session’s project root.
- Restrict `status` to the allowed enum values.
- Enforce length limits on `name`/`systemPrompt` and sanitize `groupPath`.

---

### 10. `/api/code-search` — Unbounded ripgrep parameters and arbitrary search scope

**File:** `app/api/code-search/route.ts`  
**Severity:** High

`maxResults` and `contextLines` are parsed with `parseInt` but never checked for `NaN` or bounded. A malformed value (e.g., `maxResults=abc`) produces `NaN`, which is passed into ripgrep args and the result truncation logic. The `path` parameter is only tilde-expanded and can point to any directory on disk, allowing filesystem enumeration outside the project.

**Recommended fix:**

- Clamp `maxResults` and `contextLines` to sane numeric ranges and reject `NaN`.
- Require `path` to be within a registered project/repository root.

---

### 11. `/api/git/clone` — Can clone into any existing writable directory

**File:** `app/api/git/clone/route.ts`  
**Severity:** High

The URL is well validated, and the extracted repo name is checked for traversal, but `directory` is only required to exist. There is no restriction that it must be under a project workspace, so a caller can clone repositories into any writable directory (e.g., the user’s home or system locations).

**Recommended fix:**

- Restrict `directory` to a project-managed clone root or an existing project directory.
- Verify the final `clonePath` stays inside the allowed root (the route already checks traversal relative to `directory`, but `directory` itself is unbounded).

---

### 12. Git mutation routes operate on arbitrary repositories

**Files:** `app/api/git/commit/route.ts`, `app/api/git/push/route.ts`, `app/api/git/pr/route.ts`, `app/api/git/stage/route.ts`, `app/api/git/unstage/route.ts`, `app/api/git/discard/route.ts`, `app/api/git/status/route.ts`, `app/api/git/file-content/route.ts`, `app/api/git/history/**/*.ts`, `app/api/git/check/route.ts`  
**Severity:** High

These routes accept a `path`/`rawPath` from query or body, expand `~`, and run git operations. They do not verify that the path belongs to a registered Stoa project or repository. A caller can stage, commit, push, create PRs, discard changes, or read history from any git repository the server user can access.

**Recommended fix:**

- Look up the allowed working directories from registered projects/repositories and reject any `path` that does not resolve to one of them.
- Use a shared helper to resolve and validate the repo path once per request.

---

### 13. `/api/tmux/kill-all` — Unauthenticated mass destruction

**File:** `app/api/tmux/kill-all/route.ts`  
**Severity:** High

A single POST kills every Stoa-managed backend session and deletes every session row from the database. There is no authentication or confirmation token.

**Recommended fix:**

- Require authentication.
- Consider requiring a confirmation token or restricting this to a server-shutdown path.

---

### 14. `/api/tmux/rename` — Unauthenticated arbitrary session rename

**File:** `app/api/tmux/rename/route.ts`  
**Severity:** High

`oldName`/`newName` are taken from the body and passed to the backend rename function without pattern validation. An attacker can rename arbitrary tmux/pty sessions, including non-Stoa sessions if the backend permits, breaking the session registry.

**Recommended fix:**

- Validate both names against the managed session name pattern (`getManagedSessionPattern()`).
- Require authentication.

---

### 15. `/api/dispatch/dispatches/[id]` and related — Unauthenticated GitHub mutations

**Files:** `app/api/dispatch/**/*.ts`, `app/api/sessions/[id]/ceremony/route.ts`, `app/api/sessions/[id]/pr/route.ts`  
**Severity:** High

Board actions (approve, retry, cancel, merge) and PR operations are unauthenticated. Anyone who can reach the server can create GitHub issues, dispatch workers, merge PRs, and cancel/retry dispatches. In conjunction with missing auth, this exposes the user’s `gh` credentials and repositories to network attackers.

**Recommended fix:**

- Add auth middleware before any dispatch/session mutation route.
- Validate every action against the current row state (already partially done) and log mutations to the audit ledger.

---

## Medium

### 16. `/api/dev-servers/[id]/logs` — `lines` parameter unvalidated

**File:** `app/api/dev-servers/[id]/logs/route.ts`  
**Severity:** Medium

`lines = parseInt(searchParams.get("lines") || "100", 10)` is not checked for `NaN`, negativity, or an upper bound. A huge value can cause excessive memory use when slicing the log array.

**Recommended fix:**

- Clamp `lines` to `[0, 10000]` (or similar) and default invalid values to 100.

---

### 17. `/api/sessions/[id]/send-keys` — No size limit on pasted text

**File:** `app/api/sessions/[id]/send-keys/route.ts`  
**Severity:** Medium

The route accepts arbitrary `text` and sends it to a live terminal session. There is no length limit or content validation, so an extremely large payload can hang the backend or be interpreted as unintended keystrokes.

**Recommended fix:**

- Enforce a maximum text length (e.g., 10,000 characters) and reject control characters that are not part of intentional terminal input.

---

### 18. `/api/sessions/[id]/messages` — Unvalidated role/content

**File:** `app/api/sessions/[id]/messages/route.ts`  
**Severity:** Medium

`role` and `content` are not validated against allowed roles or length limits. A caller can insert arbitrary roles (e.g., `system`) and very large messages into the conversation log.

**Recommended fix:**

- Restrict `role` to `user`/`assistant`.
- Enforce a content length cap.

---

### 19. `/api/sessions/[id]/fork` — Unvalidated session name and message copy

**File:** `app/api/sessions/[id]/fork/route.ts`  
**Severity:** Medium

`name` is not length-limited or sanitized before being stored, and all parent messages are copied verbatim. Malicious or oversized content can propagate.

**Recommended fix:**

- Apply the same sanitization/length rules used elsewhere for session names.

---

### 20. `/api/sessions/[id]/summarize` and `/api/git/commit-message` — Spawn external agent with shell on Windows

**Files:** `app/api/sessions/[id]/summarize/route.ts`, `app/api/git/commit-message/route.ts`  
**Severity:** Medium

Both routes spawn the `claude` binary with `shell: isWindows`. Because `claude` is resolved from user PATH, a malicious PATH entry or binary replacement could lead to running the wrong executable. The routes are also unauthenticated, allowing external callers to consume API quota and spawn processes.

**Recommended fix:**

- Use `shell: false` everywhere unless absolutely required.
- Validate the resolved binary path.
- Add authentication and rate limiting.

---

### 21. `/api/git/history` — Unbounded `limit`

**File:** `app/api/git/history/route.ts`  
**Severity:** Medium

`limit = parseInt(limitStr, 10) || 30` is not bounded. A very large value can cause memory exhaustion while loading commit history.

**Recommended fix:**

- Clamp `limit` to a reasonable maximum (e.g., 200).

---

### 22. `/api/files/upload-temp` — No size or MIME validation

**File:** `app/api/files/upload-temp/route.ts`  
**Severity:** Medium

The route decodes a base64 payload of unbounded size and writes it to `os.tmpdir()/stoa-screenshots`. The filename is sanitized, but file size is not limited and MIME type is trusted for the extension.

**Recommended fix:**

- Enforce a maximum decoded size (e.g., 5 MB).
- Validate MIME type against an allowlist and derive the extension from the allowlist, not the client.

---

### 23. `/api/dispatch/plan` — Unbounded planner spec

**File:** `app/api/dispatch/plan/route.ts`  
**Severity:** Medium

`spec` is trimmed but not length-limited. A huge value is passed to `spawnPlanner`, which can waste tokens, CPU, and disk.

**Recommended fix:**

- Cap `spec` length (e.g., 10,000 characters).

---

### 24. `/api/dispatch/issues/create` — Labels and issue content unvalidated

**File:** `app/api/dispatch/issues/create/route.ts`  
**Severity:** Medium

`title`, `body`, and `labels` are not length-limited. `labels` are filtered to strings but not validated for content, so invalid or malicious label values can be passed to `gh issue create`.

**Recommended fix:**

- Enforce length limits on title/body.
- Validate each label against GitHub’s label rules and reject shell-special characters.

---

### 25. `/api/dispatch/resolve` — Resolves any absolute path

**File:** `app/api/dispatch/resolve/route.ts`  
**Severity:** Medium

The route checks that the path is absolute but does not restrict it to registered projects. It runs git commands on any absolute path, which leaks repo existence, slug, and default branch.

**Recommended fix:**

- Only resolve paths that belong to registered projects or scan roots.

---

## Low / Informational

### 26. Several routes crash on invalid JSON instead of returning 400

**Files:** `app/api/dev-servers/route.ts`, `app/api/git/commit/route.ts`, `app/api/git/stage/route.ts`, `app/api/git/unstage/route.ts`, `app/api/git/discard/route.ts`, `app/api/git/push/route.ts`, `app/api/git/pr/route.ts`, `app/api/files/content/route.ts`, `app/api/projects/**/*.ts`, and others  
**Severity:** Low

These routes call `await request.json()` without a `try/catch`, so a malformed body throws an unhandled exception and returns a generic 500. Routes that do catch (e.g., `/api/ask`, `/api/command/*`, `/api/sessions/[id]/summarize`) handle this correctly.

**Recommended fix:**

- Wrap `request.json()` in a `try/catch` and return `400` with a clear message.

---

### 27. `/api/sessions/status` returns empty object on error

**File:** `app/api/sessions/status/route.ts`  
**Severity:** Low

The catch block returns `{ statuses: {} }` with HTTP 200, masking backend failures from the polling UI.

**Recommended fix:**

- Return a 500 or 503 status so the UI can surface or retry the failure.

---

### 28. `/api/sessions/status` parses `.claude.json` without schema validation

**File:** `app/api/sessions/status/route.ts`  
**Severity:** Low

The route reads `~/.claude/.claude.json` and accesses nested fields (`config.projects[projectPath].lastSessionId`) without schema checks. A malformed file could cause unexpected behavior.

**Recommended fix:**

- Validate the parsed JSON shape before accessing nested properties.

---

### 29. `/api/backend` leaks backend implementation detail

**File:** `app/api/backend/route.ts`  
**Severity:** Low/Info

The route exposes `"pty"` or `"tmux"` to any caller. While not directly exploitable, it aids reconnaissance.

**Recommended fix:**

- Not actionable unless auth is added; with auth it is acceptable.

---

### 30. `/api/web-fetch` lacks per-client rate limiting

**File:** `app/api/web-fetch/route.ts`  
**Severity:** Low/Info

The fetch handler has good SSRF and size protections but no rate limiting. A malicious or misbehaving client can repeatedly fetch external URLs, consuming bandwidth and the server’s CPU/memory.

**Recommended fix:**

- Add a simple in-memory rate limiter per IP or session.

---

## Notable Absence of Vulnerabilities

- **SQL injection:** Almost all database access uses prepared statements (`stmt.run(...)` with `?` placeholders). The only dynamic SQL is in `/api/sessions/[id]/route.ts` PATCH, where column names are hardcoded in a private array and only values are parameterized, so SQL injection is not present.
- **Request parameter handling:** Dynamic route `params` are typed as `Promise<...>` and awaited correctly, following Next.js App Router conventions.
- **Model/provider injection:** `/api/ask`, `/api/command/propose`, `/api/sessions/[id]/summarize`, and the session-creation path validate the provider/model against catalogs before passing them to argv builders.
- **SSRF:** `/api/web-fetch` correctly resolves hostnames and rejects private/loopback/link-local addresses, manually follows redirects, and re-checks each hop.

---

## Recommendations Summary

1. **Add authentication** to all API routes (or at least bind to localhost by default).
2. **Sandbox all filesystem paths** to registered project/repository roots; reject traversal.
3. **Eliminate `shell: true`** for any command constructed from user input; use `execFile`/`spawn` with argv arrays.
4. **Delete or heavily gate `/api/exec`**; it violates the project’s own cross-platform guidelines.
5. **Validate and bound all numeric/string inputs** (`lines`, `limit`, `maxResults`, `contextLines`, text lengths, session names).
6. **Fix `/api/sessions/init-script`** so `agentCommand` cannot inject shell code.

---

## Area: claude

# Claude Integration Bug Review

**Scope:** `lib/claude/process-manager.ts`, `lib/claude/stream-parser.ts`, `lib/claude/types.ts`  
**Reviewer:** bug-hunting agent  
**Date:** 2026-06-14

## Summary

Found **9 issues** ranging from parser fragility and duplicate event handlers to ignored options, unsafe JSON handling, and unhandled Promise rejections. None are catastrophic, but several can cause duplicate state updates, runtime crashes on malformed legacy messages, silent option failures, or unhandled rejections.

---

## Findings

### 1. Duplicate `error` event handler on spawned Claude process

- **File:** `lib/claude/process-manager.ts`
- **Lines:** 200–202 and 224–238
- **Severity:** Medium
- **Description:** `claudeProcess.on("error", ...)` is registered twice. Both listeners fire for the same spawn/runtime error. The second listener sets status to `"error"` and broadcasts an error event; the first only logs. This causes duplicate error processing and redundant DB/WebSocket traffic.
- **Recommended fix:** Remove the first `error` handler (lines 200–202) and keep the second one that updates state and broadcasts.

### 2. `sendPrompt` ignores `options.resume` and `options.claudeSessionId`

- **File:** `lib/claude/process-manager.ts`
- **Lines:** 82–131 (esp. 115–123)
- **Severity:** Medium
- **Description:** The `ClaudeSessionOptions` interface documents `resume?: boolean` and `claudeSessionId?: string` for `--resume`, but `sendPrompt` only reads `dbSession.claude_session_id`. Callers cannot force resume or supply an explicit Claude session ID.
- **Recommended fix:** Honor the options before falling back to the DB value:
  ```ts
  const resumeId = options.claudeSessionId ?? dbSession?.claude_session_id;
  if (resumeId && options.resume !== false) {
    args.push("--resume", resumeId);
  }
  ```

### 3. Legacy `message` case crashes when `content` is missing

- **File:** `lib/claude/stream-parser.ts`
- **Lines:** 102–120
- **Severity:** High
- **Description:** The legacy `case "message"` immediately calls `message.content.filter(...)` without checking that `content` exists. A malformed/legacy line missing `content` throws a TypeError that is caught by `parseLine` and emitted as a parse error, but it still breaks event extraction and can mask the real payload.
- **Recommended fix:** Add a guard: `if (!message.content) return null;` before filtering.

### 4. Parser does not handle `\r\n` line endings

- **File:** `lib/claude/stream-parser.ts`
- **Lines:** 21–33
- **Severity:** Medium
- **Description:** `write()` splits only on `\n`. If Claude outputs CRLF (common on Windows), each line retains a trailing `\r`, causing `JSON.parse(line)` to fail and emit spurious parse errors.
- **Recommended fix:** Normalize line endings before splitting, e.g. `this.buffer = this.buffer.replace(/\r\n/g, "\n").replace(/\r/g, "\n");` or strip trailing `\r` from each line.

### 5. Database writes are fire-and-forget and can become unhandled rejections

- **File:** `lib/claude/process-manager.ts`
- **Lines:** 97–105, 285–288, 292–303, 307–315, 321–324
- **Severity:** Medium
- **Description:** `queries.createMessage(db).run(...)` and other DB calls are invoked without `await` or `.catch()`. If `better-sqlite3` throws (busy/constraint error), the rejection is unhandled and can crash the Node process.
- **Recommended fix:** `await` DB calls in `sendPrompt` (already async) and wrap them in try/catch. In synchronous event handlers, wrap DB calls in try/catch and log or broadcast failures.

### 6. `cancelSession` uses `SIGTERM` unconditionally

- **File:** `lib/claude/process-manager.ts`
- **Lines:** 242–247
- **Severity:** Medium
- **Description:** `session.process.kill("SIGTERM")` is used on all platforms. On Windows, `SIGTERM` support is unreliable for `.cmd`/`.bat` shims and some child processes, which can leave orphan Claude processes.
- **Recommended fix:** Use platform-aware termination. On Windows call `kill()` without a signal first, then escalate to `SIGKILL` after a timeout if the process is still alive; on POSIX start with `SIGTERM`.

### 7. Insufficient type guard in legacy `message` case allows `undefined` text

- **File:** `lib/claude/stream-parser.ts`
- **Lines:** 103–105
- **Severity:** Low/Medium
- **Description:** The type guard `(c): c is TextContent => c.type === "text"` does not verify that `c.text` is a string. `TextContent` requires `text: string`, so `c.text` may be `undefined` at runtime, yielding `undefined` entries in `textBlocks` and producing confusing output.
- **Recommended fix:** Use the same guard as the `assistant` case: `c.type === "text" && !!c.text` (or `typeof c.text === "string"`).

### 8. `StreamMessageInit` type is unused / parser only handles `system` init

- **File:** `lib/claude/types.ts` and `lib/claude/stream-parser.ts`
- **Lines:** `types.ts` 3–7; `stream-parser.ts` 59–72
- **Severity:** Low
- **Description:** `StreamMessageInit` (`type: "init"`) is defined but the parser only recognizes `system`/`init`. If Claude emits a bare `init` NDJSON line, it is silently dropped. This may be intentional for the current CLI version, but it is a fragility if the protocol changes.
- **Recommended fix:** Either handle `case "init":` in `transformToClientEvent` or remove the unused type to reduce confusion.

### 9. Unsafe `JSON.stringify` calls on externally sourced objects

- **File:** `lib/claude/process-manager.ts`
- **Lines:** 103, 300
- **Severity:** Medium
- **Description:** `JSON.stringify` is used to serialize `event.data.content` (from parsed stream output) and the user prompt wrapper before writing to SQLite. If the parsed content contains circular references or unexpected values (e.g., `BigInt`), `JSON.stringify` throws synchronously, crashing the event handler.
- **Recommended fix:** Wrap `JSON.stringify` in a helper with a try/catch that returns a safe fallback string (e.g., `null` or `"{}"`) and logs the failure. Alternatively, validate/sanitize stream content before serialization.

---

## Minor / Advisory

- **Stderr is logged but not broadcast:** `lib/claude/process-manager.ts` lines 195–198. Clients never see stderr diagnostics. Consider emitting them as `error` or `status` events.
- **No maximum buffer size:** `stream-parser.ts` line 12. A single unterminated line could grow the buffer unbounded. Consider capping it and emitting an error if exceeded.
- **Status set by `complete` event may race with process `close`:** If a `result` message arrives after the process has already exited with a non-zero code, `handleEvent` will overwrite the DB status to `"idle"`. Consider tracking whether the process has already exited before applying `complete`/`error` events.

---

## Conclusion

The integration is generally sound, but the duplicate error handler, ignored resume options, legacy `message` crash, CRLF parsing issue, and unsafe JSON.stringify calls should be fixed before they cause user-visible regressions, especially on Windows.

---

## Area: components-ui

# `components/ui/` Bug Review

Scanned: `badge.tsx`, `button.tsx`, `context-menu.tsx`, `dialog.tsx`, `dropdown-menu.tsx`, `input.tsx`, `scroll-area.tsx`, `segmented-tabs.tsx`, `select.tsx`, `skeleton.tsx`, `switch.tsx`, `textarea.tsx`, `tooltip.tsx`.

## Findings

### 1. `components/ui/dropdown-menu.tsx` — invalid destructive‑variant SVG selector

- **Severity:** High
- **Line:** 77
- **Description:** The class `data-[variant=destructive]:*:[svg]:!text-destructive` uses `[svg]`, which selects elements with an `svg` attribute, not `<svg>` elements. Icons inside destructive items will not turn destructive‑colored.
- **Fix:** Replace with `data-[variant=destructive]:[&_svg]:!text-destructive` (or `data-[variant=destructive]:[&_svg:not([class*='text-'])]:!text-destructive` to mirror the default icon rule).

### 2. `components/ui/dialog.tsx` — invalid Tailwind class `rounded-xs`

- **Severity:** Medium
- **Line:** 83
- **Description:** `rounded-xs` is not defined in the project's Tailwind v4 theme (theme only defines `--radius-sm/md/lg/xl`). The close button therefore gets no border radius.
- **Fix:** Use `rounded-sm` or add `--radius-xs` to the `@theme inline` block in `app/globals.css`.

### 3. `components/ui/segmented-tabs.tsx` — `role="tablist"` without keyboard support

- **Severity:** High
- **Lines:** 67–107
- **Description:** The component advertises tab semantics (`role="tablist"`, `role="tab"`, `aria-selected`) but does not implement the Tabs pattern keyboard behavior: arrow keys do not move focus, `Home`/`End` do not jump, and every tab stays `tabIndex={0}`. There is also no `aria-controls` linking to tab panels and no `id`/`aria-labelledby` wiring.
- **Fix:** Either implement full roving tab index + arrow/Home/End key handlers and `aria-controls`, or downgrade the role to `role="group"` (or `toolbar`) if this is purely a segmented button group.

### 4. `components/ui/skeleton.tsx` — skeletons lack accessibility markup

- **Severity:** Medium
- **Lines:** 12–111
- **Description:** `ShimmeringLoader` and the composite skeleton components render visible placeholder `div`s with no `aria-hidden` and no `aria-busy` on their container. Screen readers may traverse empty/undescriptive placeholder elements while content loads.
- **Fix:** Add `aria-hidden="true"` to `ShimmeringLoader`, and ensure callers wrap skeleton states in a container with `aria-busy="true"` (document the expectation) or add a prop to inject it.

### 5. `components/ui/badge.tsx` — `ref` not accepted; focus ring classes on non‑focusable element

- **Severity:** Low
- **Lines:** 30–38
- **Description:** `BadgeProps` extends `React.HTMLAttributes<HTMLDivElement>`, which does not include `ref`; passing `<Badge ref={...} />` causes a TypeScript error. The styles also include `focus:ring-2 focus:ring-offset-2` on a non‑focusable `<div>` that never receives focus.
- **Fix:** Change props type to `React.ComponentProps<"div">` (React 19 supports ref as a prop) and either remove the focus ring classes or render as `span`/`button` when interactive.

### 6. `components/ui/dialog.tsx` — dead state classes on dialog close button

- **Severity:** Low
- **Line:** 83
- **Description:** The close button uses `data-[state=open]:bg-accent data-[state=open]:text-muted-foreground`. `DialogPrimitive.Close` does not expose a `data-state` attribute, so these rules never match.
- **Fix:** Remove the dead classes or, if a hover/focus state is intended, replace with `hover:`/`focus-visible:` utilities.

### 7. `components/ui/dialog.tsx` — close button `type` not explicit

- **Severity:** Low
- **Line:** 81
- **Description:** `DialogPrimitive.Close` renders a `<button>` but is not explicitly marked `type="button"`. If a dialog is ever placed inside a `<form>`, the close button could submit the form if Radix's default differs.
- **Fix:** Add `type="button"` to the `DialogPrimitive.Close` element.

### 8. `components/ui/button.tsx` — redundant `cursor-pointer`

- **Severity:** Low / Info
- **Line:** 8
- **Description:** The `cursor-pointer` utility is applied, but `app/globals.css` already restores `cursor: pointer` on all enabled buttons via a base layer rule.
- **Fix:** Remove `cursor-pointer` from the CVA base string; the global rule covers it.

## Notable non‑issues

- **Missing `forwardRef`:** Not a bug in this repo. The project uses React 19, where function components accept `ref` as a normal prop. All wrapped primitives use `React.ComponentProps<...>`, so refs pass through correctly.
- **Controlled/uncontrolled state:** `Input`, `Textarea`, `Switch`, `Select`, and menu primitives correctly spread props without overriding `value`/`checked`.
- **Event handlers:** No leaks or missing cleanup were found in these presentational primitives.
- **TypeScript:** `npx tsc --noEmit` passes with no errors.

---

## Area: data-queries

# Bug Review: `data/` TanStack Query Hooks

Review of the TanStack Query hooks under `data/` in `c:/my-projects/stoa-clean`. Focus areas: incorrect cache keys, missing error handling, race conditions, stale data, and misuse of mutations.

---

## Missing Error Handling

### 1. `data/git/queries.ts` — `fetchGitCheck` ignores HTTP status

- **Severity:** Medium
- **Description:** Returns `res.json()` without checking `res.ok`. A 4xx/5xx response that still returns JSON is treated as success, so `useGitCheck` never enters an error state.
- **Fix:** Check `res.ok` and throw before returning the body.

### 2. `data/git/queries.ts` — `fetchGitStatus` ignores HTTP status

- **Severity:** Medium
- **Description:** Only checks `data.error`, not `res.ok`. A 5xx response with no `error` field is returned as valid `GitStatus`.
- **Fix:** Throw on `!res.ok`.

### 3. `data/git/queries.ts` — `fetchPRData` swallows errors as `null`

- **Severity:** Medium
- **Description:** Returns `null` whenever `data.error` is present. `usePRStatus` therefore treats failures as successful "no PR" data and never surfaces an error UI.
- **Fix:** Throw on `!res.ok` or `data.error` instead of returning `null`.

### 4. `data/git/queries.ts` — `fetchMultiRepoGitStatus` ignores HTTP status

- **Severity:** Medium
- **Description:** Only checks `data.error`, not `res.ok`.
- **Fix:** Throw on `!res.ok`.

### 5. `data/git/queries.ts` — `useCreatePR` ignores HTTP status on both requests

- **Severity:** Medium
- **Description:** Checks `info.error` / `result.error` but never `infoRes.ok` / `createRes.ok`. A 5xx response with no `error` field is treated as success.
- **Fix:** Add `if (!res.ok) throw ...` for both fetches.

### 6. `data/git/queries.ts` — Stage/unstage mutations ignore HTTP status

- **Severity:** Medium
- **Description:** `useStageFiles`, `useUnstageFiles`, `useMultiRepoStageFiles`, and `useMultiRepoUnstageFiles` only inspect `data.error`, not `res.ok`.
- **Fix:** Throw on `!res.ok`.

### 7. `data/files/queries.ts` — `fetchDirectory` ignores HTTP status

- **Severity:** Medium
- **Description:** Only checks `data.error`, not `res.ok`.
- **Fix:** Throw on `!res.ok`.

### 8. `data/sessions/queries.ts` — `useForkSession` ignores HTTP status

- **Severity:** Medium
- **Description:** Does not check `res.ok`; on failure it silently returns `null`, so the mutation succeeds and no error UI/toast is shown.
- **Fix:** Check `res.ok` and throw.

### 9. `data/sessions/queries.ts` — `useCreateSession` ignores HTTP status

- **Severity:** Medium
- **Description:** Checks `data.error` but not `res.ok`. A 5xx response with no `error` field is treated as a successful session creation.
- **Fix:** Check `res.ok`.

### 10. `data/sessions/queries.ts` — `useSummarizeSession` ignores HTTP status

- **Severity:** Medium
- **Description:** Checks `data.error` but not `res.ok`.
- **Fix:** Check `res.ok`.

### 11. `data/sessions/queries.ts` — `useRespondToSession` treats unknown errors as benign

- **Severity:** Medium
- **Description:** Any non-OK status without a mapped message returns `{ stale: true }`, masking real server failures.
- **Fix:** Return `{ stale: true }` only for 404/410-like "session already gone" cases; throw for other statuses.

### 12. `data/dispatch/queries.ts` — `useCancelPlan` ignores HTTP status and leaves stale cache

- **Severity:** Medium
- **Description:** Does not check `res.ok` and does not invalidate `dispatchKeys.plan(planId)`, so a failed cancel appears successful and the plan detail cache remains.
- **Fix:** Check `res.ok` and invalidate the plan detail key on success/settled.

### 13. `data/code-search/queries.ts` — `fetchRipgrepAvailability` ignores HTTP status

- **Severity:** Low
- **Description:** Returns `data.available` without checking `res.ok`.
- **Fix:** Check `res.ok`.

---

## Incorrect Cache Keys

### 14. `data/git/keys.ts` — `multiStatus` path key can collide

- **Severity:** Low
- **Description:** The `paths` array is joined with `"|"`. Arrays such as `["a|b", "c"]` and `["a", "b|c"]` produce the same key string, causing cache collisions.
- **Fix:** Use `JSON.stringify(paths)` or include the array directly in the key.

### 15. Disabled queries use shared placeholder keys

- **Severity:** Low
- **Description:** Several hooks use `"none"` or `""` placeholders in their query key when disabled:
  - `data/dispatch/queries.ts`: `usePlanPoll(planId ?? "none")`, `useLessons(repoId ?? "none")`
  - `data/verdict-inbox/queries.ts`: `useFindings("none", "none")`
  - `data/repositories/queries.ts`: `useProjectRepositories(projectId || "")`
  - `data/pipelines/queries.ts`: `usePollRun(id ?? "")`
  - `data/git/queries.ts`: `useCommitDetail(hash || "")`, `useCommitFileDiff(... "")`
  - `data/dispatch/queries.ts`: `useOpenIssuesQuery(repoId ?? "")`
    This is mostly harmless because the queries are disabled, but it creates shared cache entries and risks accidental hits if an id literally matches the placeholder.
- **Fix:** Use TanStack Query's `skipToken` pattern (pass `queryFn: skipToken` and `enabled: false`) so no placeholder key is registered.

### 16. `data/sessions/queries.ts` — `useSessionDigest` uses a hardcoded key

- **Severity:** Low
- **Description:** Uses `queryKey: ["session-digest", sessionId]` outside the `sessionKeys` namespace, making it easy for the key to drift from project conventions.
- **Fix:** Add `sessionKeys.digest(sessionId)` to `data/sessions/keys.ts`.

---

## Stale Data

### 17. `data/sessions/queries.ts` — `useDeleteSession` leaves ceremony cache behind

- **Severity:** Low
- **Description:** On success it invalidates `sessionKeys.list()` but not `sessionKeys.ceremony(sessionId)`. The per-session ceremony entry remains in cache indefinitely.
- **Fix:** Invalidate `sessionKeys.ceremony(sessionId)` in `onSuccess` / `onSettled`.

### 18. `data/dispatch/queries.ts` — `usePrepareRepo` does not refresh the repo list

- **Severity:** Low
- **Description:** Successfully preparing a GitHub repo (clone-if-needed) does not invalidate `dispatchKeys.repos()`, so the newly created repo may not appear until another surface triggers a refetch.
- **Fix:** Add `onSuccess` invalidation of `dispatchKeys.repos()`.

### 19. `data/dispatch/queries.ts` — `useApprovePlan` does not invalidate plan detail

- **Severity:** Low
- **Description:** After plan approval the plan detail cache under `dispatchKeys.plan(planId)` is not invalidated. If the user revisits the plan, stale data may be shown.
- **Fix:** Invalidate the plan detail key in `onSuccess`.

### 20. `data/git/queries.ts` — `useCreatePR` does not invalidate git status

- **Severity:** Low
- **Description:** Creating a PR pushes the local branch; the status query is not invalidated, so the UI may briefly show an out-of-date status.
- **Fix:** Add `queryClient.invalidateQueries({ queryKey: gitKeys.status(workingDir) })` in `onSuccess`.

### 21. `data/sessions/queries.ts` — `useMergeCeremony` does not refresh session list

- **Severity:** Low
- **Description:** After merging, only the ceremony query is invalidated. The session list may still show the pre-merge state until its next poll.
- **Fix:** Also invalidate `sessionKeys.list()`.

---

## Race Conditions

### 22. Optimistic updates can be overwritten by in-flight fetches

- **Severity:** Low
- **Description:** Mutations such as `useUpdateRepo` (data/dispatch/queries.ts), `useToggleGroup` (data/groups/mutations.ts), `useToggleProject` (data/projects/queries.ts), `useRenameSession`/`useMoveSessionToGroup`/`useMoveSessionToProject`/`useDeleteSession` (data/sessions/queries.ts) call `queryClient.cancelQueries()` before optimistic updates, but `fetch()` does not honor the cancellation signal. An in-flight GET can land after the optimistic patch and overwrite it before `onSettled` triggers invalidation, causing a visible flicker/reversion.
- **Fix:** Pass the query signal into the fetch (e.g. `queryFn: ({ signal }) => fetch(url, { signal })`) so `cancelQueries()` aborts the request. Alternatively, accept the limitation and rely on `onSettled` invalidation.

### 23. `data/dispatch/queries.ts` — `useMergeDispatch` setQueryData + invalidateQueries ordering

- **Severity:** Low
- **Description:** The hook optimistically updates the board and immediately invalidates it. Although react-query schedules these synchronously, the pattern is fragile if invalidation triggers a refetch that lands before the optimistic write is committed.
- **Fix:** Move the invalidation to `onSettled` to ensure the optimistic update is committed first.

---

## Misuse of Mutations

### 24. `data/dispatch/queries.ts` — `useInboxActions.retry` does not route by item type

- **Severity:** Medium
- **Description:** `merge` and `dismiss` branch on `item.type`, but `retry` unconditionally POSTs to `/api/dispatch/dispatches/${item.id}` even for session-type items, which should not have a dispatch retry endpoint.
- **Fix:** Route retry like the other actions:
  ```ts
  const retry = useMutation({
    mutationFn: (item: InboxItem) => {
      if (item.type !== "dispatch")
        throw new Error("Retry not supported for this item");
      return act(`/api/dispatch/dispatches/${item.id}`, "POST", {
        action: "retry",
      });
    },
    onSuccess: (_d, item) => settle(item),
  });
  ```

### 25. `data/dispatch/queries.ts` — `useStartPlan` has no cache side effects

- **Severity:** Low
- **Description:** The returned `planId` is not seeded into the cache (`dispatchKeys.plan(planId)`), so a remount before the caller stores the id loses the plan context. There is also no invalidation of any list.
- **Fix:** Seed the plan detail cache in `onSuccess` (e.g. `{ status: "running" }`) or explicitly document that the caller owns the id.

### 26. `data/fleet-board/useFleetBoard.ts` — `isLoading` omits repos loading state

- **Severity:** Low
- **Description:** `isLoading` combines inbox, board, and pending but not `repos`. If repos is still loading, consumers may render with missing repo metadata.
- **Fix:** Include `repos.isLoading` in the derived `isLoading` flag.

### 27. `data/fleet-board/useFleetBoard.ts` — `refetch` is not memoized

- **Severity:** Low
- **Description:** `refetch` is defined as a new arrow function on every render, breaking memoization in parent components.
- **Fix:** Wrap `refetch` in `useCallback`.

---

## Summary

Most issues are **Medium** severity missing HTTP-status checks across `data/git/queries.ts` and `data/sessions/queries.ts`, plus a few **Medium** logic issues (`useCancelPlan`, `useInboxActions.retry`, `useRespondToSession`). Lower-severity findings include placeholder cache keys, stale-cache invalidation gaps, and optimistic-update race conditions.

---

## Area: dispatch-fleet

# Bug Hunt Report — Dispatch / Fleet-Board / Audit

## 1. Dispatch auto-merge can land code pushed **after** critic approval (no SHA pin)

- **Severity:** High
- **File:** `lib/dispatch/auto-merge.ts`, `lib/dispatch/reviewer.ts`
- **Description:** The session ceremony pins both review markers and the merge to the head SHA at panel-spawn time (`sessionReviewMarker`, `mergePR(..., matchHeadCommit: c.review_sha)`). The dispatch review gate does **not**: `reviewVerdictMarker(lensKey, round)` is keyed only on `fix_rounds`, and `autoMergePass` calls `mergePR({ cwd, prNumber, repoSlug })` without `matchHeadCommit`. If a fixer, CI fixer, or manual push lands commits after the panel approved round N but before `autoMergePass` runs, the newer unreviewed head can be merged.
- **Recommended fix:** Store the approved head SHA on the dispatch row when a complete `APPROVED` verdict is cached (or embed the SHA in the review marker like the session ceremony), and pass that SHA as `matchHeadCommit` in `autoMergePass`.

## 2. Manual merge route has the same SHA-pin gap

- **Severity:** Low (user-initiated)
- **File:** `app/api/dispatch/dispatches/[id]/merge/route.ts`
- **Description:** The one-tap Merge endpoint also calls `mergePR` without `matchHeadCommit`. On a review-gated repo, a push that races the user tap can merge unreviewed commits.
- **Recommended fix:** Use the same approved-SHA guard as auto-merge; reject or re-review if the head moved.

## 3. Spawn failures leave orphaned `sessions` rows

- **Severity:** Medium
- **Files:** `lib/dispatch/dispatcher.ts`, `lib/dispatch/reviewer.ts`, `lib/dispatch/planner.ts`, `lib/dispatch/maintainer.ts`
- **Description:** `createSession` + `updateSessionWorktree` are written to SQLite **before** `getSessionBackend().create(...)`. If the backend create throws, the catch blocks clean up the worktree and mark the dispatch/plan/survey failed, but they never `DELETE` the session row. The rows accumulate in `sessions` and are never reclaimed by `sweepOrphanedSurveys` (which only targets survey sessions).
- **Recommended fix:** On any spawn failure, call `queries.deleteSession(db).run(sessionId)` after worktree cleanup.

## 4. Audit ledger fails to record the actual agent command for binary spawns

- **Severity:** Medium
- **File:** `lib/audit/ledger.ts`
- **Description:** The `session_create` event sets `command: opts.binary ? undefined : opts.command`. In practice `dispatcher.ts` and `reviewer.ts` always pass both `binary` and `command`, so the ledger stores only `binary` and `argCount` — never the verbatim argv or banner-wrapped command the comment claims is captured. This contradicts the file header (“the spawn `command` string … is recorded verbatim”).
- **Recommended fix:** Record `command` whenever it is present (or record `args` themselves when `binary` is set), e.g. `command: opts.command ?? undefined`.

## 5. Inconsistent `windowsHide` discipline in `gh` spawns

- **Severity:** Low
- **Files:** `lib/dispatch/issues.ts`, `lib/dispatch/github.ts`
- **Description:** Most `execFile` call sites pass `windowsHide: true`. `listOpenIssues`, `getPRForBranchAnyState`, `listGitHubRepos`, and `prepareGitHubRepo` pass `windowsHide: process.platform === "win32"`. On macOS/Linux these evaluate to `false`, deviating from the project-wide console-flash guard and the explicit rationale in `create.ts`. The static coverage test still passes because the text `windowsHide` is present, but the runtime value is not fail-safe.
- **Recommended fix:** Change all four call sites to `windowsHide: true`.

## 6. Race between background worktree setup and the spawned agent

- **Severity:** Low
- **File:** `lib/dispatch/dispatcher.ts`
- **Description:** `setupWorktree` (copy `.env`, install deps) is launched with `runInBackground` and the agent is spawned immediately. If the agent runs a build/test before setup finishes, it may fail on missing dependencies.
- **Recommended fix:** Either await setup before spawning, or inject a “wait until setup marker file exists” instruction in the initial prompt.

## Summary

- **High:** 1
- **Medium:** 3 (2, 3, 4)
- **Low:** 2 (5, 6)

No other logic bugs, race conditions, missing guards, incorrect status transitions, or security issues were identified in the reviewed files.

---

## Area: hooks-stores

# Bug Hunt Report: hooks/, contexts/, stores/

Scope: `C:/my-projects/stoa-clean/hooks/`, `contexts/`, `stores/`
Focus: React hook bugs (stale closures, missing deps, memory leaks), context performance issues, race conditions, incorrect state updates.

## Summary

| Severity | Count | Files                                                                                         |
| -------- | ----- | --------------------------------------------------------------------------------------------- |
| High     | 3     | `useFileEditor.ts`, `useNotifications.ts`/`useSessionStatuses.ts`, `useSpeechRecognition.ts`  |
| Medium   | 4     | `useDirectoryBrowser.ts`, `useDrawerAnimation.ts`, `useKeyRepeat.ts`, `useCopyToClipboard.ts` |
| Low      | 3     | `useFileEditor.ts`, `PaneContext.tsx`, `stores/sessionSelection.ts`                           |

---

## High Severity

### 1. `hooks/useFileEditor.ts` — Race condition in `openFile`

**Description:**
`openFile` fires a `fetch` and, when the promise resolves, unconditionally calls `setActiveFilePath(data.path)`. If a user clicks file A and then file B before A finishes loading, whichever fetch resolves last wins. This can result in the wrong file becoming active or `activeFilePath` pointing to a file whose content was never added to `openFiles`.

**Recommended fix:**
Guard in-flight requests with an `AbortController` or a generation counter. If the request is superseded, ignore its result rather than mutating state.

```ts
const generationRef = useRef(0);

const openFile = useCallback(
  async (path: string) => {
    const existing = openFiles.find((f) => f.path === path);
    if (existing) {
      setActiveFilePath(path);
      return;
    }

    const gen = ++generationRef.current;
    setLoading(true);
    try {
      const res = await fetch(
        `/api/files/content?path=${encodeURIComponent(path)}`
      );
      const data = await res.json();
      if (gen !== generationRef.current) return; // stale
      // ...existing success logic
    } finally {
      if (gen === generationRef.current) setLoading(false);
    }
  },
  [openFiles]
);
```

---

### 2. `hooks/useNotifications.ts` + `hooks/useSessionStatuses.ts` — Unstable `checkStateChanges` callback triggers consumer effect re-runs

**Description:**
`useNotifications.checkStateChanges` is memoized with dependencies that include `settings`, `notify`, `onSeeChanges`, and `offerSeeChanges`. `notify` itself depends on `settings`, `permissionGranted`, and `onSessionClick`. Consequently, every settings toggle, permission change, or re-render where `onSessionClick`/`onSeeChanges` are inline functions mints a new `checkStateChanges` reference.

`hooks/useSessionStatuses.ts` passes that callback straight into `useSessionStatusesQuery` (in `data/statuses/queries.ts`), whose internal `useEffect` lists `checkStateChanges` in its dependency array. A new reference causes the effect to re-run, re-invoking `checkStateChanges` on every render if the parent passes an inline handler. The 8-second cooldown in `checkStateChanges` mostly suppresses duplicate toasts, but it forces constant re-computation and can surprise-notify when notifications are first enabled.

**Recommended fix:**
Make the callback stable by reading mutable values from refs rather than closing over them:

```ts
const settingsRef = useRef(settings);
settingsRef.current = settings;
const onSessionClickRef = useRef(onSessionClick);
onSessionClickRef.current = onSessionClick;
const onSeeChangesRef = useRef(onSeeChanges);
onSeeChangesRef.current = onSeeChanges;

const checkStateChanges = useCallback((sessions, activeSessionId) => {
  const settings = settingsRef.current;
  const onSessionClick = onSessionClickRef.current;
  const onSeeChanges = onSeeChangesRef.current;
  // ...use local values
}, []);
```

Also consider whether `useSessionStatuses` needs to exist as a pass-through; if it remains, document that `checkStateChanges` must be stable.

---

### 3. `hooks/useSpeechRecognition.ts` — Recognition instance reset on `onTranscript` change desyncs UI

**Description:**
The `useEffect` that constructs the `SpeechRecognition` instance depends on `[onTranscript]`. Each time the parent passes a new `onTranscript` function, the effect cleans up (aborting the old instance), creates a fresh instance, but does **not** restart it. `isListening` state remains `true`, so the UI continues to show "listening" while no recognition is actually running.

This is both a stale-closure problem and a state-machine desync.

**Recommended fix:**
Hold `onTranscript` in a ref so the recognition instance does not need to be recreated when only the callback changes:

```ts
const onTranscriptRef = useRef(onTranscript);
onTranscriptRef.current = onTranscript;

useEffect(() => {
  // build recognition once
  recognition.onresult = (event) => {
    // ...
    onTranscriptRef.current(finalTranscript, true);
  };
  return () => recognition.abort();
}, []); // or stable deps only
```

If `onTranscript` identity genuinely matters, track whether recognition was active and restart it inside the effect when the instance is recreated.

---

## Medium Severity

### 4. `hooks/useDirectoryBrowser.ts` — `filter` prop change does not recompute `files`

**Description:**
The `filter` option is stored in a ref (`filterRef`) and read inside the `files` `useMemo`, but `filter` is intentionally omitted from the dependency array. If the caller changes the filter while the directory data is unchanged, the displayed list stays stale until the next `data?.files`, `roots`, or `showRoots` change.

**Recommended fix:**
Either include `filter` in the `useMemo` dependency array (and require callers to memoize stable filters) or, if dynamic filters must be supported, keep the ref and trigger a recompute with a separate `filterVersion` state that increments when `filter` identity changes.

---

### 5. `hooks/useDrawerAnimation.ts` — `requestAnimationFrame` callback can fire after unmount or after `open` flips false

**Description:**
The double `requestAnimationFrame` chain closes over `setIsAnimatingIn` but does not check the current value of `open` or whether the component is still mounted. If `open` toggles `true → false` quickly, the inner rAF may still run and set `isAnimatingIn(true)` even though the drawer is closed. On unmount it would also attempt to set state on an unmounted component.

**Recommended fix:**
Use refs to track the latest `open` value and mounted state; check them inside the rAF callbacks before calling `setIsAnimatingIn`.

```ts
const openRef = useRef(open);
openRef.current = open;
const mountedRef = useRef(true);

useEffect(() => {
  // ...
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      if (mountedRef.current && openRef.current) {
        setIsAnimatingIn(true);
      }
    });
  });
  return () => {
    mountedRef.current = false;
  };
}, [open]);
```

---

### 6. `hooks/useKeyRepeat.ts` — Stale `onKeyPress` inside active interval

**Description:**
`startRepeat` closes over `onKeyPress` and schedules `setInterval`/`setTimeout` callbacks that capture the original callback. If `onKeyPress` changes identity while a repeat is active (e.g., parent re-renders with a fresh closure), the interval continues invoking the old `onKeyPress`.

**Recommended fix:**
Store `onKeyPress` in a ref and read the current value inside each repeat tick:

```ts
const onKeyPressRef = useRef(onKeyPress);
onKeyPressRef.current = onKeyPress;

const startRepeat = useCallback(() => {
  onKeyPressRef.current();
  // ...
  intervalRef.current = setInterval(() => {
    onKeyPressRef.current();
  }, 150);
}, []);
```

---

### 7. `hooks/useCopyToClipboard.ts` — Uncleared timeout can set state after unmount

**Description:**
`copy` starts a `setTimeout` to clear the `copied` feedback, but the timeout handle is never stored or cleared. If the component unmounts before the timeout fires, `setCopied(false)` runs on an unmounted component, which React warns about. Rapid successive copy calls also spawn multiple overlapping timeouts, making the feedback duration unpredictable.

**Recommended fix:**
Track the timeout in a ref and clear it both on unmount and before scheduling a new one:

```ts
const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

useEffect(
  () => () => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
  },
  []
);

const copy = useCallback(
  async (text: string) => {
    // ...
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    setCopied(true);
    timeoutRef.current = setTimeout(() => setCopied(false), feedbackDuration);
    // ...
  },
  [feedbackDuration]
);
```

---

## Low Severity

### 8. `hooks/useFileEditor.ts` — Nested `setState` inside `setOpenFiles` updater

**Description:**
`closeFile` calls `setActiveFilePath((currentActive) => ...)` inside the functional updater of `setOpenFiles`. While React generally tolerates this, it is an unusual pattern that couples two independent state updates and can make future refactoring/error handling harder. It also means `activeFilePath` is derived from the previous `openFiles` snapshot rather than the final committed state.

**Recommended fix:**
Compute the next active path inside the `setOpenFiles` updater and invoke `setActiveFilePath(nextActive)` once after `setOpenFiles` resolves, or merge the two pieces of state if they are tightly coupled.

---

### 9. `contexts/PaneContext.tsx` — `defaultPaneData` is a mutable module-level fallback

**Description:**
`getPaneData` returns `defaultPaneData` when a pane ID is missing. `defaultPaneData` is created once at module load. If any consumer mutates the returned object (e.g., mutating `tabs`), the fallback data is permanently corrupted for all future missing-pane lookups.

**Recommended fix:**
Return a shallow copy or freeze the default:

```ts
const getPaneData = useCallback(
  (paneId: string): PaneData => {
    return state.panes[paneId] ? { ...defaultPaneData } : defaultPaneData;
  },
  [state.panes]
);
```

Or, better, guarantee the fallback is never mutated by consumers.

---

### 10. `stores/sessionSelection.ts` — Plain accessor methods bypass Valtio reactivity

**Description:**
`selectionActions.isSelected`, `getCount`, and `getSelectedIds` are plain functions that read directly from the mutable `selectionStore` proxy. If a React component calls these during render without wrapping them in `useSnapshot` (or similar subscription), the component will not re-render when the selection changes. This is an API-footgun rather than an active bug, but it has caused similar issues in other Valtio-based codebases.

**Recommended fix:**
Document that these selectors must be used inside `useSnapshot` or convert the store to expose snapshot-ready derived values (e.g., via Valtio `derive` or by having components subscribe to `selectedIds` directly).

---

## Notes

- No issues were found in `useBackendType.ts`, `useDevServersManager.ts`, `useViewport.ts`, `useViewportHeight.ts`, `useSharedTicker.ts`, `useGlobalKeybindings.ts`, `useHomePath.ts`, `useProjects.ts`, `useSessionCosts.ts`, `useSessionDiff.ts`, `useSessionQueue.ts`, `useSessionSnapshots.ts`, `useWebPush.ts`, `stores/fileOpen.ts`, `stores/initialPrompt.ts`, `stores/paneCommands.ts`, or `stores/index.ts`.
- The dependency-instability finding (#2) spans two in-scope hooks and a consumer in `data/statuses/queries.ts`; the fix can be applied entirely within the hooks layer by stabilizing `checkStateChanges`.

---

## Area: lib-db

# Database Layer Review - `lib/db/`

Scope: `lib/db/index.ts`, `lib/db/migrations.ts`, `lib/db/queries.ts`, `lib/db/schema.ts`, `lib/db/types.ts`.

Verified by instantiating a fresh in-memory database with `createSchema` + `runMigrations` and inspecting `sqlite_master`.

---

## 1. Missing index `idx_dev_servers_project` on fresh databases

- **File:** `lib/db/migrations.ts`
- **Severity:** Medium
- **Description:**  
  Migration 10 (`add_project_id_to_dev_servers`) guards the entire body with an early return when `project_id` already exists:
  ```ts
  if (cols.some((c) => c.name === "project_id")) return;
  ```
  Because `schema.ts` already declares `dev_servers.project_id`, fresh databases hit this guard and never execute:
  ```sql
  CREATE INDEX IF NOT EXISTS idx_dev_servers_project ON dev_servers(project_id)
  ```
  The upgrade path (pre-migration-10 DB) creates the index, but the fresh-install path skips it. Verified: after `createSchema` + `runMigrations` on `:memory:`, `idx_dev_servers_project` is absent.
- **Impact:** `getDevServersByProject`, `deleteDevServersByProject`, and any project-scoped dev-server operations perform table scans.
- **Recommended fix:** Move the `CREATE INDEX` statement outside the column-existence guard, or add the index directly to `schema.ts`.

---

## 2. Schema drift: several indexes live only in migrations, not in `schema.ts`

- **Files:** `lib/db/schema.ts`, `lib/db/migrations.ts`
- **Severity:** Low-Medium
- **Description:**  
  The following indexes are created only by migrations and are not declared in `schema.ts`:
  - `idx_sessions_group` (migration 5)
  - `idx_sessions_conductor` (migration 6)
  - `idx_sessions_project` (migration 9)
  - `idx_dev_servers_project` (migration 10 - missing entirely on fresh DB, see #1)

  Fresh databases currently obtain the first three only because `runMigrations` runs after `createSchema`. This makes `schema.ts` an incomplete picture of the intended schema and is fragile if the migration runner is ever bypassed or refactored.

- **Recommended fix:** Add all migration-created indexes to `schema.ts` so the canonical schema is self-contained.

---

## 3. Migration runner masks real errors by string-matching error messages

- **File:** `lib/db/migrations.ts`
- **Severity:** Medium
- **Description:**  
  `runMigrations` catches any error containing `"duplicate column"` or `"already exists"` and records the migration as applied:
  ```ts
  if (
    errorMsg.includes("duplicate column") ||
    errorMsg.includes("already exists")
  ) {
    insertMigration.run(migration.id, migration.name);
    ...
  }
  ```
  This is the root cause of #1 and can hide partial failures. For example, a multi-statement migration that succeeds on its first `ALTER` but fails on a later statement with an error message containing one of those substrings would be marked applied even though the later statements never ran.
- **Recommended fix:** Make every migration idempotent with explicit guards (`PRAGMA table_info` / `IF NOT EXISTS`) as done in migrations 24-31, and remove the broad catch-and-mark-applied logic.

---

## 4. `initDb` file-based lock is fragile and can leak

- **File:** `lib/db/index.ts`
- **Severity:** Low-Medium
- **Description:**  
  `withInitLock` uses a PID file plus a CPU-busy spin-wait loop. Issues:
  - A slow initializer that exceeds the 10-second timeout can have its lock stolen by another process.
  - If `createSchema` or `runMigrations` throws, the `Database` connection is not closed and the lock file may not be removed.
  - Spin-waiting consumes CPU during initialization races.
  - `process.cwd()`-relative `DB_PATH` can change depending on where the process is launched.
- **Recommended fix:** Rely on SQLite's own locking (WAL + `busy_timeout` are already enabled). Wrap schema/migration setup in a single transaction or use an initialization sentinel row in `_migrations`. Close the DB and clean up the lock file in a catch block.

---

## 5. Missing composite indexes for common query patterns

- **Files:** `lib/db/schema.ts`, `lib/db/migrations.ts`
- **Severity:** Low
- **Description:**  
  Several hot queries filter and order by multiple columns but only have single-column indexes:
  - `messages` - `session_id = ? ORDER BY timestamp ASC`: `idx_messages_session` does not cover `timestamp`.
  - `tool_calls` - `session_id = ? ORDER BY timestamp ASC` and `message_id = ? ORDER BY timestamp ASC`: separate single-column indexes.
  - `issue_dispatches` - many queries filter `repo_id` + `status` (e.g., `listPendingForRepo`, `countLiveInFlight`, `listPendingDispatchableForRepo`). Only separate indexes on `repo_id` and `status` exist.
  - `session_events` - `session_key = ? AND event_type = ? ORDER BY id ASC`: only separate indexes on `session_key` and `event_type`.
  - `issue_dispatches(dispatched_at DESC)` - used by `listDispatchesForBoard`; no index.
- **Recommended fix:** Add covering/composite indexes such as `(session_id, timestamp)`, `(message_id, timestamp)`, `(repo_id, status)`, `(session_key, event_type, id)`, and `(dispatched_at DESC)` where table size warrants it.

---

## 6. No CHECK constraints on enum-like columns

- **File:** `lib/db/schema.ts`
- **Severity:** Low
- **Description:**  
  Enum-like columns are plain `TEXT` with no `CHECK` constraints:
  - `sessions.status`
  - `dev_servers.type`, `dev_servers.status`
  - `issue_dispatches.status`, `issue_dispatches.source`, `issue_dispatches.verify_status`
  - `session_ceremonies.step`
  - `repo_lessons.source`
    This permits invalid values to be inserted silently, relying entirely on application-layer enforcement.
- **Recommended fix:** Add `CHECK` constraints (e.g., `CHECK(status IN ('idle','running','waiting','error'))`) or document that enforcement is intentionally at the application layer.

---

## 7. Global unbounded prepared-statement cache

- **File:** `lib/db/queries.ts`
- **Severity:** Low
- **Description:**  
  `stmtCache` is a module-level `Map<string, Statement>`. All current queries use static SQL, so this is safe today, but:
  - It is not bounded; dynamic SQL would leak memory.
  - It is keyed by SQL string, not by `Database` instance, so statements are not released if a different database instance is opened.
  - Statements are never explicitly finalized when the database is closed.
- **Recommended fix:** Use a `WeakMap<Database.Database, Map<string, Statement>>`, or at least cap the cache size and finalize statements on DB close.

---

## 8. `updateDispatchRepo` omits several editable-looking fields

- **File:** `lib/db/queries.ts`
- **Severity:** Low
- **Description:**  
  `updateDispatchRepo` only updates `agent_type`, `daily_quota`, `max_concurrency`, `label_filter`, `base_branch`, `mode`, `enabled`, and the various gate flags. It does not update `repo_path`, `repo_slug`, or `project_id`. If those fields are meant to be immutable, this is correct but undocumented; if they are editable, no query exists to change them.
- **Recommended fix:** Document the immutable fields or add an update query that includes them.

---

## 9. `countDispatchesToday` and `listDispatchesForBoard` lack an index on `dispatched_at`

- **File:** `lib/db/queries.ts`
- **Severity:** Low
- **Description:**  
  `countDispatchesToday` applies `date(dispatched_at)` and `listDispatchesForBoard` orders by `dispatched_at DESC`, but there is no index on `dispatched_at`. For small tables this is fine; as the dispatch ledger grows, these become full table scans.
- **Recommended fix:** Add an index on `issue_dispatches(repo_id, dispatched_at)` or `issue_dispatches(dispatched_at)`.

---

## 10. Inconsistent timestamp representation

- **File:** `lib/db/schema.ts`
- **Severity:** Info
- **Description:**  
  All tables except `session_events` store timestamps as ISO-8601 `TEXT` via `datetime('now')`. `session_events.created_at` is an `INTEGER` epoch millis. The inline comment explains the rationale (cheap ordering + duration math), but the inconsistency complicates cross-table time-range queries.
- **Recommended fix:** Document the intentional exception in a schema-level comment or `AGENTS.md` note; no code change required unless unification is desired.

---

## Summary

| #   | Finding                                              | Severity   |
| --- | ---------------------------------------------------- | ---------- |
| 1   | Missing `idx_dev_servers_project` on fresh DBs       | Medium     |
| 2   | Indexes declared only in migrations, not `schema.ts` | Low-Medium |
| 3   | Migration runner masks errors by string matching     | Medium     |
| 4   | File-based init lock is fragile / can leak           | Low-Medium |
| 5   | Missing composite indexes for common queries         | Low        |
| 6   | No CHECK constraints on enum-like columns            | Low        |
| 7   | Global unbounded statement cache                     | Low        |
| 8   | `updateDispatchRepo` omits editable-looking fields   | Low        |
| 9   | No index on `dispatched_at`                          | Low        |
| 10  | Mixed timestamp representations                      | Info       |

No critical SQL-injection or data-loss issues were found. All user-controlled values in `queries.ts` are bound with `?` placeholders.

---

## Area: other-views

# Bug Hunt Report: components/views/ (excluding WorkflowsView)

## Summary

Reviewed 20 files under `components/views/` (excluding `WorkflowsView/`). No critical security vulnerabilities were found. There is one high‑severity React render‑phase state bug, several medium accessibility/correctness issues, and a handful of lower‑severity polish items.

## Findings

| #   | File                                                                        | Severity   | Description                                                                                                                                                                                                                                               | Recommended Fix                                                                                                                                       |
| --- | --------------------------------------------------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `components/views/DispatchView/PlanConsole.tsx`                             | **High**   | `setDrafts(...)` is called directly inside the render body when `poll.data` becomes ready (lines 75‑83). This breaks React’s render‑phase purity and can trigger “Cannot update during render” warnings or unexpected re‑renders.                         | Move draft seeding into a `useEffect` keyed on the ready data: `useEffect(() => { if (ready && drafts === null) setDrafts(...); }, [ready, drafts]);` |
| 2   | `components/views/DispatchView/shared.ts`                                   | **Medium** | `AGENT_BADGE` only defines colors for `claude`, `codex`, `hermes`, and `shell`. The newer `kilo` and `kimi` providers have no badge, so their dots in the AllocationConsole legend are invisible and their agent pills render without a background color. | Add `kilo` and `kimi` entries to `AGENT_BADGE` with distinct colors.                                                                                  |
| 3   | `components/views/ChatView/index.tsx`                                       | **Medium** | The composer `<textarea>` (line 551) relies solely on `placeholder` for its accessible name; placeholders are not reliable labels for screen readers.                                                                                                     | Add `aria-label="Ask Stoa a question"` or a visually hidden `<label htmlFor="chat-input">`.                                                           |
| 4   | `components/views/ChatView/index.tsx`                                       | **Medium** | The message list container (line 405) has no live region, so screen readers are not notified when assistant answers arrive or when the “Thinking…” indicator appears.                                                                                     | Add `role="log" aria-live="polite" aria-label="Conversation"` to the scrollable message container.                                                    |
| 5   | `components/views/VerdictInboxView/InboxCard.tsx`                           | **Medium** | The row expand/collapse button (lines 171‑188) toggles the findings panel but has no `aria-expanded` state and no `aria-controls` linking to the panel.                                                                                                   | Add `aria-expanded={open}` and `aria-controls="findings-<id>"` to the button, and give the findings panel a matching `id`.                            |
| 6   | `components/views/DesktopView.tsx`                                          | **Low**    | The “copy session ID” success state sets a 2s timeout but never clears it; if the component unmounts before it fires, it will call `setCopiedSessionId` on an unmounted component. Rapid re‑clicks also stack multiple timeouts.                          | Store the timeout id and clear it in a `useEffect` cleanup.                                                                                           |
| 7   | `components/views/DispatchView/AllocationConsole.tsx` & `LessonsDialog.tsx` | **Low**    | Delete‑repo and bulk‑forget‑lessons use the native browser `confirm()` instead of the app’s accessible `useConfirm` hook.                                                                                                                                 | Replace `confirm(...)` with the `useConfirm()` async dialog.                                                                                          |
| 8   | `components/views/DispatchView/PlanConsole.tsx`                             | **Low**    | Draft task cards use `key={i}` (line 245). Deleting a task shifts indexes and can move the uncontrolled `<details>` open state to the wrong draft.                                                                                                        | Use a stable key such as a draft‑local id or a hash of `draft.title`+index.                                                                           |
| 9   | `components/views/VerdictInboxView/index.tsx`                               | **Low**    | Tab counts recompute `items.filter(...)` four times per render (in `tabs` construction) plus once for the visible list.                                                                                                                                   | Memoize the filtered lists/counts with `useMemo`.                                                                                                     |
| 10  | `components/views/DispatchView/InFlightBoard.tsx`                           | **Low**    | `Card` is an unmemoized inner component; every board poll re‑renders every card.                                                                                                                                                                          | Wrap `Card` in `React.memo` and/or pass stable callbacks to reduce re‑render noise.                                                                   |
| 11  | `components/views/ChatView/index.tsx`                                       | **Low**    | Empty‑state example prompt buttons are focusable while a request is in flight; the click handler no‑ops, but the buttons still appear interactive.                                                                                                        | Add `disabled={propose.isPending}` to the example `<button>` elements.                                                                                |
| 12  | `components/views/ChatView/index.tsx`                                       | **Low**    | `ReactMarkdown` renders links without `target="_blank"` or `rel`; clicking an external link in an assistant answer navigates away from Stoa.                                                                                                              | Provide a custom `components.a` to add `target="_blank" rel="noopener noreferrer"` for http(s) URLs.                                                  |

## Security notes

- No XSS vector was found in the chat/markdown rendering: `react-markdown` is used without `rehypeRaw`, so raw HTML is escaped, and the default URL transform blocks `javascript:` schemes.
- `DesktopView.tsx` uses a fallback `document.execCommand("copy")` for non‑HTTPS contexts. This is deprecated but acceptable as a fallback.

## Accessibility notes

- `SegmentedTabs` correctly exposes `role="tablist"`, `role="tab"`, and `aria-selected`, so the tab strips themselves are accessible.
- The `role="tabpanel"` containers in `AnalyticsView`, `DispatchView`, and `VerdictInboxView` do not currently have `aria-labelledby` ids linking back to the active tab — a minor WCAG refinement, not included in the findings table above.

---

## Area: pipeline

# Pipeline Engine Bug Review Report

**Scope:** `lib/pipeline/engine.ts`, `executor.ts`, `graph-layout.ts`, `templates.ts`, `examples.ts`, `builder-model.ts`, `registry.ts`, `default-deps.ts`, `types.ts`, plus related tests.

**Summary:** No critical or high-severity issues. No unsafe `eval`, `Function`, or dynamic code execution paths were found. The engine is well-structured and exhaustively tested. Findings are mostly low-severity edge cases in validation, error handling, and builder UX.

---

## Findings

### 1. Step ids with leading/trailing whitespace pass validation but break DAG consistency

- **File:** `lib/pipeline/engine.ts`
- **Severity:** Low–Medium (correctness / validation)
- **Description:** `validateSpec` trims step ids (`step?.id?.trim()`) when checking validity and building the id set, but it never rejects a raw id that contains leading/trailing whitespace. Such ids pass validation yet cannot be referenced by `dependsOn` (the unknown-step check compares raw `dep` against trimmed `id`) and cannot be referenced by `{{steps.<id>.output}}` placeholders (the `OUTPUT_REF` regex does not allow whitespace). The result is a spec that validates but whose steps are effectively isolated, which is confusing and inconsistent.
- **Recommended fix:** Add an explicit guard in `validateSpec`:
  ```ts
  if (step?.id?.trim() !== step?.id) {
    err(
      step?.id?.trim() ?? null,
      `step id must not have leading or trailing whitespace`
    );
  }
  ```

---

### 2. `maxPollCycles` timeout is off-by-one

- **File:** `lib/pipeline/executor.ts`
- **Severity:** Low (correctness)
- **Description:** The cycle cap is implemented as `if (++cycles > maxPollCycles)`. Because `cycles` is pre-incremented, the run only terminates after `maxPollCycles + 1` unproductive poll cycles. A caller setting `maxPollCycles: 1` actually gets 2 cycles.
- **Recommended fix:** Change to `if (++cycles >= maxPollCycles)` (or increment and compare separately).

---

### 3. `checkOutcome` exceptions are silently swallowed

- **File:** `lib/pipeline/executor.ts`
- **Severity:** Low–Medium (error handling)
- **Description:** When polling in-flight steps, a throwing `checkOutcome` is caught and converted to `{ outcome: "running", error: ... }`. The error message is never logged, and the step stays in the `running` state, so a persistently failing poller only terminates via the cycle cap. The real `default-deps.ts` wraps `statusDetector` and returns `"failed"` on error, so the default path is safe, but custom `ExecutorDeps` are unprotected.
- **Recommended fix:** Either log the error (e.g., `console.warn`) or count consecutive poll failures and treat a threshold as a step failure.

---

### 4. `onUpdate` failure in the crash path masks the original error

- **File:** `lib/pipeline/executor.ts`
- **Severity:** Low (error handling)
- **Description:** In the `catch` block, after force-terminating the run, `emit()` is called unconditionally. If `onUpdate` throws there, the original executor error is lost because `throw err` is never reached.
- **Recommended fix:** Wrap the catch-block emit in its own try/catch so the original error is always rethrown:
  ```ts
  try {
    emit();
  } catch {
    /* onUpdate is best-effort */
  }
  await reapWorkers(run, deps);
  throw err;
  ```

---

### 5. `renameStep` does not update `{{steps.<id>.output}}` placeholders

- **File:** `lib/pipeline/builder-model.ts`
- **Severity:** Low (correctness / UX)
- **Description:** `renameStep` cascades the id change into `dependsOn` arrays but leaves task strings untouched. A task that previously referenced `{{steps.oldId.output}}` now points to a non-existent step. `validateSpec` will catch this later, but the builder leaves the document in a broken state after a rename.
- **Recommended fix:** After renaming, scan every step’s `task` and `exitCriteria` and replace occurrences of `{{steps.<oldId>.output}}` with `{{steps.<newId>.output}}`.

---

### 6. Shell-metacharacter guard is deliberately narrow

- **File:** `lib/pipeline/engine.ts`
- **Severity:** Low (security, defense-in-depth)
- **Description:** `hasShellMetachars` blocks separators, quotes, redirects, backticks, and command substitution, but it does not block `#` (comment), glob characters (`*?[]`), or `=`. The actual spawn path uses `argv` arrays, so this is a secondary guard for the tmux bash init-script path. No unsafe `eval` or `Function` usage exists anywhere in the pipeline code.
- **Recommended fix:** Consider expanding the set or using a proper shell-quoting/escaping helper for the tmux path, while keeping the current allow-list for Windows paths.

---

## Security Conclusion

No instances of `eval`, `new Function`, `setTimeout`/`setInterval` with string arguments, or dynamic `require` were found in `lib/pipeline/`. User-provided strings flow through either validated placeholders or direct `argv` spawning; the `model` and `workingDirectory` fields have explicit shell-metachar guards, and `outputFile` has path-traversal protection.

---

**Files reviewed:** `lib/pipeline/engine.ts`, `lib/pipeline/executor.ts`, `lib/pipeline/graph-layout.ts`, `lib/pipeline/templates.ts`, `lib/pipeline/examples.ts`, `lib/pipeline/builder-model.ts`, `lib/pipeline/registry.ts`, `lib/pipeline/default-deps.ts`, `lib/pipeline/start.ts`, `lib/pipeline/types.ts`, plus tests `test/pipeline-*.test.ts`.

**Verification run:** `npx vitest run test/pipeline-*.test.ts` — 181/181 passed. `npx tsc --noEmit` reported no pipeline-related errors.

---

## Area: platform

# Cross-platform path/file helper bug review

Scope: `lib/platform.ts`, `lib/path-display.ts`, and related path/file helpers across `lib/` and `app/`.

## Summary

Found **13 distinct issues**: 1 Critical, 4 Medium, 8 Low. The most severe is the arbitrary shell-string exec endpoint in `app/api/exec/route.ts`, which also hardcodes `/bin/zsh`, macOS Homebrew `PATH`, and reads `process.env.HOME`.

---

## Findings

### 1. `app/api/exec/route.ts` — shell-string `exec` + POSIX-only env

- **Severity:** Critical
- **Lines:** 39–52
- **Description:** Uses `child_process.exec` (`execAsync(command)`) with a raw user-supplied command string. On POSIX it forces `shell: "/bin/zsh"`, prepends a hardcoded `/usr/local/bin:/opt/homebrew/bin` PATH, and reads `process.env.HOME`. This violates the project rules against shell-string exec, hardcoded `/bin`, and `process.env.HOME`.
- **Fix:** Convert to `execFile` with an argv array; use `defaultInteractiveShell()` and `homeDir()` from `lib/platform.ts`; inherit the user's PATH instead of hardcoding Homebrew paths. Better yet, remove or heavily restrict this opt-in arbitrary-execution endpoint.

### 2. `server.ts` — legacy tmux pty spawn uses POSIX-only fallbacks

- **Severity:** Medium
- **Lines:** 712–729
- **Description:** Spawns a legacy tmux shell with `process.env.SHELL || "/bin/zsh"`, a PATH fallback containing `/usr/local/bin:/usr/bin:/bin`, and both `HOME` and `cwd` read from `process.env.HOME || "/"`. If this code path is ever reached on Windows, it will fail because `HOME` is not defined and `/bin/zsh` does not exist.
- **Fix:** Use `defaultInteractiveShell()` and `homeDir()` from `lib/platform.ts`; avoid hardcoding POSIX directories in the PATH fallback.

### 3. `lib/platform.ts` — `defaultInteractiveShell()` hardcodes `/bin/bash`

- **Severity:** Medium
- **Line:** 72
- **Description:** POSIX fallback is `process.env.SHELL || "/bin/bash"`. `/bin/bash` is a POSIX-only assumption and is explicitly called out in `AGENTS.md` as a hardcoded `/bin` value to avoid.
- **Fix:** Use a truly portable fallback such as `resolveBinary("sh")`, `os.userInfo().shell`, or `"/bin/sh"` at minimum.

### 4. `lib/session-backend/pty-backend.ts` — POSIX shell fallback hardcoded

- **Severity:** Medium
- **Line:** 56
- **Description:** In the non-Windows branch it spawns `process.env.SHELL || "/bin/bash"` with `args: ["-c", command]`. This duplicates platform logic that should go through `defaultInteractiveShell()`.
- **Fix:** Use `defaultInteractiveShell()` from `lib/platform.ts` instead of an inline `/bin/bash` fallback.

### 5. `lib/session-backend/pty/registry.ts` — interactive shell fallback hardcoded

- **Severity:** Medium
- **Line:** 147
- **Description:** `spawnShellSession` uses `process.env.SHELL || "/bin/bash"` for the POSIX branch.
- **Fix:** Use `defaultInteractiveShell()` from `lib/platform.ts`.

### 6. `lib/banner.ts` — bash shebang and hardcoded `bash` runner

- **Severity:** Low–Medium
- **Lines:** 18, 79
- **Description:** Generates a POSIX-only `#!/bin/bash` init script and returns `bash ${scriptPath}`. On Windows the generated command cannot run natively.
- **Fix:** Resolve bash via `resolveBinary("bash")` for the runner, or generate a PowerShell-equivalent script on Windows.

### 7. `lib/claude/process-manager.ts` — hardcoded macOS Homebrew PATH

- **Severity:** Low
- **Line:** 170
- **Description:** On POSIX it prepends `/usr/local/bin:/opt/homebrew/bin` to `PATH`. This is a macOS-only assumption that can mask missing binaries on Linux or Windows.
- **Fix:** Inherit `process.env.PATH` and resolve required binaries with `resolveBinary()`; only prepend directories if they actually exist.

### 8. Multiple files use `os.homedir()` directly instead of `homeDir()`

- **Severity:** Low
- **Files / lines:**
  - `app/api/sessions/[id]/summarize/route.ts:105` (also imports unused `homeDir`)
  - `app/api/sessions/[id]/last-reply/route.ts:68` (imports `homeDir` but uses `homedir()`)
  - `app/api/sessions/status/route.ts:52`
  - `lib/auth.ts:24`
  - `lib/push.ts:20`
  - `lib/mcp-config.ts:227`
  - `lib/session-cost.ts:124`
- **Description:** `os.homedir()` is cross-platform, but the project centralizes this in `homeDir()` and repeatedly warns against reading `process.env.HOME`. Using the wrapper keeps the codebase consistent and future-proof.
- **Fix:** Replace `os.homedir()` / `homedir()` with `homeDir()` from `lib/platform.ts`.

### 9. Multiple files use `os.tmpdir()` directly instead of `tmpDir()`

- **Severity:** Low
- **Files / lines:**
  - `app/api/files/upload-temp/route.ts:15`
  - `app/api/sessions/[id]/send-keys/route.ts:10`
  - `lib/banner.ts:77`
  - `lib/session-backend/pty/protocol.ts:40`
- **Description:** `os.tmpdir()` works, but `lib/platform.ts` provides `tmpDir()` as the single source of truth and explicitly discourages hardcoding `/tmp`.
- **Fix:** Use `tmpDir()` from `lib/platform.ts`.

### 10. Path-name parsing with `split("/")` in helpers/UI

- **Severity:** Low
- **Files / lines:**
  - `components/NewSessionDialog/WorkspaceSection.tsx:90`
  - `lib/pr-generation.ts:264, 321`
- **Description:** These parse filesystem-style paths by replacing backslashes and splitting on `/`. The project already has `baseName()` / `dirName()` in `lib/path-display.ts` for this purpose.
- **Fix:** Use `baseName()` from `lib/path-display.ts` (and `dirName()` where appropriate).

### 11. `lib/path-display.ts` — `dirName()` always joins with `/`

- **Severity:** Low (display-only)
- **Line:** 12
- **Description:** `dirName()` returns forward-slash separated segments even when the input is a Windows path, so Windows users may see `C:/Users/foo` instead of `C:\Users\foo`.
- **Fix:** If native-Windows display is desired, detect the separator from the input (as `joinPath()` already does) or document that display paths are intentionally slash-normalized.

### 12. `lib/session-backend/pty/protocol.ts` — Unix socket in temp dir

- **Severity:** Low
- **Line:** 40
- **Description:** On POSIX the host socket is placed in `os.tmpdir()`. A deep `TMPDIR` can exceed the Unix domain socket path length limit (~104–108 chars) and cause `bind` failures on macOS/Linux.
- **Fix:** Use a shorter, predictable runtime directory (e.g., under `homeDir()/.stoa/run`) or allow `STOA_PTY_HOST_NAME` to keep the basename short, with a documented limit.

### 13. Logical path splits that are **not** bugs

- `app/api/groups/[...path]/route.ts:91, 109`
- `components/SessionList/GroupSection.tsx:85`
- `lib/dispatch/github.ts:96`
- `lib/dispatch/claims.ts:38`
- `app/api/files/upload-temp/route.ts:21` (MIME type)
- `scripts/guard-surfaces.mjs:624`
- **Rationale:** These split on `/` for group IDs, GitHub slugs, claim paths, MIME types, or repository-relative paths where the separator is part of the data model, not the OS filesystem.

---

## Notable clean paths

- `lib/platform.ts` correctly wraps `os.homedir()`, `os.tmpdir()`, and path separators.
- `lib/path-display.ts` is browser-safe (no Node builtins) and separator-agnostic.
- `app/api/files/roots/route.ts` handles Windows drive letters and POSIX `/` without assumptions.
- `app/api/web-fetch/route.ts` uses `tmpDir()` from `lib/platform.ts`.
- No client components import the server-only `lib/platform.ts`.

---

## Area: providers

# Provider / Model-Catalog Bug Hunt Report

Scope: `lib/providers/`, `lib/providers.ts`, `lib/model-catalog.ts`, and related spawn/attach/orchestration code.

## Summary

Found **2 code issues of medium-or-higher severity** and **2 lower-severity staleness/consistency issues**. The most important gap is that Codex conductor sessions lose their orchestration MCP wiring on the Pane re-attach path because `buildSpawnForSession` ignores the persisted `mcp_launch_args` column.

---

## Findings

### 1. MAJOR — `buildSpawnForSession` ignores `mcp_launch_args` for Codex conductors

- **File:** `lib/client/backend.ts` (lines 44–62)
- **Description:** `buildSpawnForSession()` builds the pty spawn payload used by `components/Pane/index.tsx` when re-attaching a session. It passes `sessionId`, `parentSessionId`, `autoApprove`, `model`, and `initialPrompt`, but **never reads `session.mcp_launch_args`**. For a Codex conductor session, those persisted `-c mcp_servers.stoa.*` flags are therefore dropped on re-attach via the Pane, so the agent respawns without the stoa MCP server. The main `app/page.tsx` `buildSessionCommand` path does handle `mcp_launch_args` correctly, so this is a path-specific inconsistency.
- **Recommended fix:** In `buildSpawnForSession`, parse `session.mcp_launch_args` (defensively, with try/catch) and pass the resulting array as `extraArgs` to `buildAgentArgs`, mirroring the logic in `app/page.tsx` lines 376–384.

### 2. MEDIUM — `spawnWorker` does not wire orchestration MCP args for Codex workers

- **File:** `lib/orchestration.ts` (lines 192–199)
- **Description:** `spawnWorker()` builds both the tmux command string and the pty argv for a worker, but it passes only `{ model, autoApprove: true }` to `buildFlags` / `buildAgentArgs`. It never supplies `extraArgs` (Codex `-c mcp_servers.stoa.*` flags) and never writes the Hermes conductor marker or persists `mcp_launch_args` on the created worker session. Consequently, a worker session spawned by a conductor cannot itself act as a conductor, and Codex workers lose their MCP wiring entirely.
- **Recommended fix:** Accept an optional `enableOrchestration` parameter in `SpawnWorkerOptions`; when true, generate the provider-appropriate MCP wiring (Codex `buildCodexOrchestrationArgs`, Hermes marker + global registration, Claude `.mcp.json`) and pass `extraArgs` through `buildAgentArgs` / `buildTmuxFlags`.

### 3. MEDIUM — Codex static model catalog is stale

- **File:** `lib/model-catalog.ts` (lines 17–22)
- **Description:** `CODEX_MODEL_OPTIONS` lists `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.4-nano`, and `gpt-5.2-codex`. As of mid-2026, the Codex CLI surface has moved on: `gpt-5.5` is the new recommended flagship, `gpt-5.3-codex` / `gpt-5.3-codex-spark` are current coding specialists, and `gpt-5.2-codex` is listed for shutdown. The catalog default remains `gpt-5.4`, which is still valid as a fallback but is no longer the current default.
- **Recommended fix:** Verify the exact list with `codex --help` / `codex models list` on the target deployment, then update `CODEX_MODEL_OPTIONS` and `DEFAULT_MODEL_BY_AGENT` to include current models (e.g. `gpt-5.5`) and remove or deprecate `gpt-5.2-codex`.

### 4. LOW — Claude family aliases may resolve to older models

- **File:** `lib/model-catalog.ts` (lines 11–15)
- **Description:** `CLAUDE_MODEL_OPTIONS` exposes unversioned aliases `sonnet`, `opus`, `haiku`. The code comment states these are accepted by `claude --help` as family aliases. As of mid-2026, Claude Code’s active models are versioned 4.x families (e.g. `claude-sonnet-4-6`, `claude-opus-4-7`, `claude-haiku-4-5`). The unversioned aliases may still work but could silently point to older or unexpected model versions.
- **Recommended fix:** Confirm with `claude --help` whether the unversioned aliases still map to the intended current models. If not, switch to versioned aliases (`claude-sonnet-4-6`, etc.) or add them alongside the legacy aliases.

### 5. LOW — `supportsOrchestration` assertion omits `kilo`/`kimi`

- **File:** `test/providers.test.ts` (lines 303–310)
- **Description:** The test "every agent provider advertises supportsOrchestration; shell does not" explicitly asserts only `claude`, `codex`, `hermes`, and `shell`. It does not iterate `PROVIDER_IDS`, so it would not catch an accidental `supportsOrchestration: true` on `shell` or a missing flag on `kilo`/`kimi`.
- **Recommended fix:** Rewrite the test to loop over `PROVIDER_IDS` and assert the boolean value per provider, e.g.:
  ```ts
  for (const id of PROVIDER_IDS) {
    const expected = id !== "shell";
    expect(Boolean(getProviderDefinition(id).supportsOrchestration)).toBe(
      expected
    );
  }
  ```

### 6. INFO — Stale comment in Kimi test about on-disk session capture

- **File:** `test/providers.test.ts` (line 215)
- **Description:** The test comment says Kimi resumes "via --session <id> on both paths (id captured from the on-disk index)", but the actual implementation (`lib/status-detector.ts` `KIMI_SESSION_ID_RE` and `app/api/sessions/status/route.ts`) captures the id from the startup banner, not from an on-disk index. This is only a comment drift; the code behavior is correct.
- **Recommended fix:** Update the test comment to match the banner-capture implementation.

---

## Cross-platform / command-construction notes (no issue)

- `lib/providers.ts` `buildAgentArgs()` emits clean argv; `buildFlags()` shell-quotes value tokens via `shellQuoteArg`. Both paths are covered by tests for free-text agents (`hermes`, `kilo`, `kimi`).
- Binary resolution is delegated to the pty registry / `lib/claude/process-manager.ts`, both of which use `resolveBinary()` from `lib/platform.ts`.
- The tmux backend uses bare CLI names (`claude`, `kimi`, etc.) and relies on PATH; the init script adds `$HOME/.local/bin`.
- Kimi (`--session`), Hermes (`--resume`), and Kilo (`--session`) resume flags are consistent with the registry definitions and test expectations.

## Conclusion

The highest-impact fix is **#1** (replaying `mcp_launch_args` in `buildSpawnForSession`) because it causes Codex conductors to silently lose orchestration on Pane re-attach. **#2** should be addressed if nested conductor workers are intended to be supported. **#3** and **#4** should be verified against the live CLI help output of the target versions and updated before they cause model-not-found errors.

---

## Area: scripts-config

# Bug Hunt Report: `scripts/`, `security/`, root config files

Scope: `scripts/`, `security/`, `next.config.ts`, `package.json`, and root config files in `c:/my-projects/stoa-clean`.

---

## 1. `.env` file with secrets present in working directory

- **File:** `.env`
- **Severity:** Critical
- **Description:** A `.env` file exists in the repo root. The file-read tool blocked it because it matches sensitive-file patterns (likely contains credentials, tokens, or other secrets). It is currently untracked (`git ls-files` does not know it), but leaving it in the working directory creates an ongoing risk of accidental `git add .`, IDE uploads, backup exposure, or being picked up by packaging tools.
- **Recommended fix:** Remove the file from the repo directory immediately. Store secrets outside the project tree (e.g., a password manager or machine-local env). Verify `.gitignore` already ignores `.env*` (it does). If the file is needed for local dev, generate it from `.env.example` per project docs and never commit it.

---

## 2. `package.json` `files` array references non-existent / wrong config files

- **File:** `package.json`
- **Severity:** High
- **Description:** The `files` array (used by `npm publish`) lists:
  - `"next.config.js"` — the actual file in the repo is `next.config.ts`.
  - `"tailwind.config.ts"` — no such file exists (Tailwind v4 configuration is CSS-based here).
    This means a published package will ship without the real Next.js config and with a stale reference, likely breaking a published install.
- **Recommended fix:** Change `"next.config.js"` to `"next.config.ts"` and remove `"tailwind.config.ts"` from the `files` array. Re-run `npm run build` after publishing changes to confirm the package contents.

---

## 3. `scripts/install.ps1` invokes executables with unquoted paths

- **File:** `scripts/install.ps1`
- **Severity:** Medium
- **Description:** Several calls use variables that may contain spaces without quoting:
  - `& git clone $RepoUrl $InstallDir` (`$InstallDir` unquoted).
  - `& $npmCmd.Source install ...` and `& $npmCmd.Source run build` and `& $npmCmd.Source link` (`$npmCmd.Source` unquoted).
    If `USERPROFILE` or the npm path contains spaces (e.g., `C:\Users\John Doe`), PowerShell will split the path into multiple arguments and the install will fail.
- **Recommended fix:** Quote the command/path and directory arguments:
  - `& git clone "$RepoUrl" "$InstallDir"`
  - `& "$($npmCmd.Source)" install ...`

---

## 4. Installers download and execute remote scripts without verification

- **Files:** `scripts/install.sh`, `scripts/install.ps1`, `scripts/lib/prerequisites.sh`, `scripts/lib/ai-clis.sh`
- **Severity:** Medium
- **Description:** Multiple installer paths fetch scripts from the internet and execute them directly:
  - `curl -fsSL https://raw.githubusercontent.com/.../install.sh | bash` (`install.sh`, `install.ps1` equivalent with `irm ... | iex`)
  - `/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"`
  - `curl -fsSL https://fnm.vercel.app/install | bash -s -- --skip-shell`
  - `curl -fsSL https://claude.ai/install.sh | bash`
  - `curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -`
  - `curl -fsSL https://rpm.nodesource.com/setup_24.x | sudo bash -`
    These are supply-chain attack surfaces: a compromised CDN, repo, or MITM (without additional checksum verification) can execute arbitrary code on the user's machine.
- **Recommended fix:** Pin remote scripts to immutable references (release tag SHA, commit hash, or a vendored copy in the repo) and verify checksums before execution. Document the remote fetches clearly in the README/SECURITY.md so users understand the trust boundary.

---

## 5. `scripts/stoa.js` Windows log tail constructs a PowerShell command string

- **File:** `scripts/stoa.js` (`cmdLogs`)
- **Severity:** Low
- **Description:** On Windows the log-tail command is built as a single string passed to `powershell -Command`:
  ```js
  `Get-Content -Path '${LOG_FILE.replace(/'/g, "''")}' -Tail 50 -Wait`;
  ```
  Only single quotes are escaped. A log path containing PowerShell wildcard/meta characters (notably `[` and `]`) can be misinterpreted by `Get-Content -Path`; backticks or `$` could also affect parsing.
- **Recommended fix:** Use `Get-Content -LiteralPath ...` instead of `-Path`, or implement the tail directly in Node.js so no shell/parser interpretation is involved.

---

## 6. `"setup"` npm script is not portable to native Windows

- **File:** `package.json`
- **Severity:** Low
- **Description:** `"setup": "bash scripts/setup.sh"` requires a POSIX `bash` interpreter, which is not present by default on native Windows. This contradicts the project's stated cross-platform support.
- **Recommended fix:** Either remove the `setup` script and document platform-specific setup commands, or add a Windows-equivalent script and route via a cross-platform runner (e.g., `scripts/stoa.js install`).

---

## 7. `scripts/setup.sh` still hardcodes `tmux` and `claude` as required

- **File:** `scripts/setup.sh`
- **Severity:** Low / Informational
- **Description:** The setup script requires `tmux` and the `claude` CLI, but the Stoa architecture now uses `pty` on Windows and supports multiple agent providers (Claude, Codex, Kilo Code, Kimi Code, etc.). A new POSIX user running `npm run setup` is forced to install `tmux` even if they intend to use the pty backend, and `claude` even if they use another provider.
- **Recommended fix:** Update `setup.sh` to align with the current backend/provider model: make `tmux` optional when `STOA_BACKEND=pty`, and make AI CLI installation provider-aware or skip the hard `claude` requirement.

---

## 8. `scripts/stoa.js` does not hide windows for some spawned processes

- **File:** `scripts/stoa.js`
- **Severity:** Low / Informational
- **Description:** Several `spawnSync` / `spawn` calls on Windows do not pass `windowsHide: true`:
  - `runSync` helper (used for npm/git installs, builds, etc.).
  - `gitCapture` helper.
  - `cmdStop` taskkill call.
    This can cause transient console windows to flash when the CLI runs on Windows.
- **Recommended fix:** Add `windowsHide: true` to cross-platform spawn/spawnSync options where a visible window is not desired.

---

_Report generated by bug-hunting review of `scripts/`, `security/`, `next.config.ts`, `package.json`, and root config files._

---

## Area: session-backend

# Session Backend Bug-Hunt Report

Review scope: `lib/session-backend/` (tmux backend, pty backend, PtySession, registry, transports, pty-host daemon/protocol, attach-session, factory).

**No “No issues found” verdict** — the following race conditions, resource-leak paths, cross-platform hazards, and error-handling gaps were identified. Severity is impact × exploitability within normal Stoa usage.

---

## 1. Tier-2 attach protocol ignores the client’s initial terminal size

- **File:** `lib/session-backend/pty/host.ts` (attach handler) and `lib/session-backend/pty/transport.ts` (`HostTransport.attachStream`)
- **Severity:** Medium
- **Description:** The host-side `attach` message carries only `key` and `observer`; it has no `cols`/`rows`. The daemon therefore registers a new sizing client with `session.addClient(session.cols, session.rows)` instead of the client’s actual viewport. This diverges from `LocalTransport`, which uses `req.cols`/`req.rows` immediately. A browser tab that attaches to an existing session that was previously sized smaller will see clipped output until it sends an explicit resize.
- **Recommended fix:** Add `cols`/`rows` to the `attach` client message; have `HostTransport.attachStream` pass `req.cols`/`req.rows`; and use those values in `host.ts` when calling `session.addClient(...)`.

---

## 2. Concurrent `ensureConnected()` callers race through ping + resubscribe

- **File:** `lib/session-backend/pty/host-client.ts` (`ensureConnected`)
- **Severity:** Medium
- **Description:** Only the TCP connect loop is single-flighted via `this.connecting`. Once the socket is wired, every caller that was awaiting the same `connecting` promise proceeds to run `pingRaw()` and `resubscribeAll()` concurrently. This causes redundant pings, redundant attach requests on the daemon, and duplicate snapshot replays to WebSocket clients. If one caller’s ping destroys the socket while another is mid-ping, transient errors propagate to unrelated operations.
- **Recommended fix:** Extend the single-flight promise to cover the entire connect → ping → resubscribe sequence (e.g., `this.connecting = this.runConnectionSequence().finally(...)`).

---

## 3. Cross-connection race between `kill` and `attach` on the shared registry

- **File:** `lib/session-backend/pty/host.ts` (`handleMessage`, kill case) and `lib/session-backend/pty/registry.ts` (`killSessionAndWait`)
- **Severity:** Medium
- **Description:** `handleMessage` serializes messages per connection (`messageChain`), but the registry is shared across connections. `killSessionAndWait` awaits process exit before deleting the key from `sessions`. While awaiting, another connection can `attach` to the same key, subscribe to output, and then the first connection deletes the session from the registry. The subscriber is left streaming from a session that no longer appears in `exists()` / `list()`.
- **Recommended fix:** Either mark the session as “dying” and reject new attaches immediately, or serialize registry-mutating operations globally (e.g., a single promise chain for kill/rename/spawn per key).

---

## 4. `HostClient.rename()` leaves the sizing count on the wrong key

- **File:** `lib/session-backend/pty/host-client.ts` (`rename` and `attach.detach` closure)
- **Severity:** Medium
- **Description:** The `detach` closure created in `attach()` captures the original `key`. After `rename()` moves `outputListeners`, `exitListeners`, and `sizingCounts` from `oldKey` to `newKey`, a later detach still calls `decSizing(oldKey)`. Since `oldKey` no longer exists in `sizingCounts`, `decSizing` computes `-1` and deletes nothing, leaving the count for `newKey` permanently inflated.
- **Recommended fix:** Look up the sizing count by the current key at detach time, or refresh the captured key inside the detach closure when `rename()` is called.

---

## 5. `PtySession.onData` does not isolate `term.write` / raw-buffer mutations

- **File:** `lib/session-backend/pty/pty-session.ts` (constructor `pty.onData` callback)
- **Severity:** Medium
- **Description:** The callback carefully wraps `fanOut` in its own try/catch, but the preceding `this.term.write(data)` and `this.rawBuffer += data` are unguarded. If a malformed ANSI sequence or a serializer-addon bug causes `term.write` to throw, the exception escapes the `node-pty` `onData` callback. In Tier 1 this can crash the web server; in Tier 2 the daemon’s keep-alive guard catches it, but that chunk of output is lost and the session stream is corrupted.
- **Recommended fix:** Wrap the entire `onData` body (`term.write`, raw-buffer append/trim, and `fanOut`) in a try/catch that logs and continues.

---

## 6. Weak shell quoting in `TmuxBackend`

- **File:** `lib/session-backend/tmux-backend.ts` (`q()`, `create()`, `sendKeysInterpreted()`)
- **Severity:** Low–Medium
- **Description:** `q(name)` only wraps a value in double quotes, without escaping `$`, backticks, backslashes, or `!`. A session name or `command` string containing those characters can break out of the quoted argument. Session names are internally generated today, so direct exploitability is low, but the backend is documented as owning escaping and does not meet that contract.
- **Recommended fix:** Either escape all shell metacharacters inside double quotes, or migrate the tmux backend to `execFile` with argv arrays (the approach AGENTS.md prefers). Note that the existing unit tests lock the exact command strings, so either change requires test updates.

---

## 7. Windows `.cmd`/`.bat` wrapping can orphan agent child processes

- **File:** `lib/session-backend/pty/registry.ts` (`resolveSpawn`)
- **Severity:** Low–Medium
- **Description:** On Windows, if `resolveBinary` finds a `.cmd` or `.bat` shim (common for npm-installed CLIs), `resolveSpawn` routes the spawn through `cmd.exe /c resolved …`. The PID held by `node-pty` is therefore `cmd.exe`’s PID. When Stoa kills the session, `cmd.exe` may terminate without taking its child agent process with it, leaving an orphan.
- **Recommended fix:** Prefer spawning the resolved `.exe` directly when available; document the `.cmd` limitation; or ensure process-tree cleanup on Windows (e.g., via job objects if supported by the node-pty build).

---

## 8. `TmuxBackend` uses shell-string `exec` despite project-wide ban

- **File:** `lib/session-backend/tmux-backend.ts`
- **Severity:** Low
- **Description:** The file intentionally uses `child_process.exec` with shell strings containing `;`, `||`, and `2>/dev/null`. AGENTS.md explicitly forbids shell-string `exec` with pipes/redirects and requires `execFile`/`execFileSync` with argv arrays. The backend is POSIX-only and the command strings are regression-locked by tests, but it remains a cross-platform/code-style hazard.
- **Recommended fix:** Refactor to `execFile` with explicit argv arrays and redirect handling in JS. Update `test/tmux-backend.test.ts` accordingly.

---

## 9. `sendKeysInterpreted` semantic mismatch in the pty backend

- **File:** `lib/session-backend/pty-backend.ts` (`sendKeysInterpreted`)
- **Severity:** Low
- **Description:** The `SessionBackend` interface describes `sendKeysInterpreted` as “Send text with tmux key interpretation, optionally submitting.” The pty implementation simply writes the raw text bytes plus an optional `\r`. It does not interpret key names the way tmux does. This is usually correct for a native pty, but the interface name/docs imply behavior that the pty backend does not provide.
- **Recommended fix:** Clarify the interface documentation so it describes the pty behavior accurately, or map a small set of common key names to control bytes in the pty backend.

---

## 10. Resize without an active subscription changes the absolute session size

- **File:** `lib/session-backend/pty/host.ts` (`handleMessage`, resize case)
- **Severity:** Low
- **Description:** `case "resize"` falls back to `session.resize(msg.cols, msg.rows)` when there is no subscription entry for that key on the connection. This bypasses the multi-client minimum-size policy and can resize the shared pty based on a client that is not actually attached.
- **Recommended fix:** Ignore resize messages that arrive without a matching subscription (`if (!sub) break;`).

---

## 11. `getBackendType()` caches forever; `resetSessionBackend()` does not clear it

- **File:** `lib/session-backend/index.ts`
- **Severity:** Low
- **Description:** `cachedType` is set on first call and never invalidated. `resetSessionBackend()` clears `backend` but leaves `cachedType` intact, so a runtime change to `STOA_BACKEND` is ignored. This mainly affects tests and unusual reconfiguration scenarios.
- **Recommended fix:** Clear `cachedType` inside `resetSessionBackend()` (or avoid caching env-derived decisions).

---

## 12. Default pty-host socket/pipe name is global

- **File:** `lib/session-backend/pty/protocol.ts` (`hostAddress`)
- **Severity:** Low
- **Description:** When `STOA_PTY_HOST_NAME` is not set, the address defaults to `\\.\pipe\stoa-pty-host` on Windows and `/tmp/stoa-pty-host.sock` on POSIX. Two users or two Stoa instances on the same machine collide on the same global name.
- **Recommended fix:** Include a per-user qualifier in the default name (e.g., UID/username or a hash of the user profile path).

---

## Summary

The most important fixes are:

1. Extend `HostClient.ensureConnected()` single-flight to cover ping + resubscribe.
2. Close the Tier-2 attach protocol gap for initial `cols`/`rows`.
3. Serialize or guard registry mutations that await process exit (`killSessionAndWait`).
4. Fix `HostClient.rename()` sizing-count bookkeeping.
5. Harden `PtySession.onData` against throws from the VT emulator.

None of the findings indicate that the current code is unsafe to run in normal single-user Stoa usage, but items 1–5 are genuine concurrency/correctness bugs that can surface under reconnection, rename, or multi-viewer scenarios.

---

## Area: tests-root

# Bug-hunting report — test/ files and root-level files

Working directory: c:/my-projects/stoa-clean
Branch: main
Test run: 163 files, 1598 tests passed (npm test green).
Typecheck: green (npx tsc --noEmit).

No failing tests were found, but the review surfaced test gaps, missing coverage for recent features, stale packaging metadata, and documentation drift.

## 1. Missing integration test for Kimi Code banner session-id capture

- File(s): test/kimi-banner.test.ts, lib/status-detector.ts, app/api/sessions/status/route.ts
- Severity: Medium
- Description: PR #249 made Kimi Code resumable by capturing its startup banner session id from the rendered screen (KIMI_SESSION_ID_RE) and exposing it via statusDetector.getKimiSessionId(). The only test today validates the regex in isolation. There is no pty-level integration test that spawns a Kimi-style banner and asserts the detector captures and memoizes the id, unlike test/hermes-session-id.test.ts.
- Recommended fix: Add test/kimi-session-id.test.ts modeled on test/hermes-session-id.test.ts: force STOA*BACKEND=pty + STOA_PTY_HOST=0, spawn a node process that prints Session: session*<uuid>, drive statusDetector.getStatus()/capturePane(), and assert statusDetector.getKimiSessionId(name) returns the id and memoizes it.

## 2. Model-catalog tests do not cover Kilo Code / Kimi Code free-text behavior

- File(s): test/model-catalog.test.ts, lib/model-catalog.ts
- Severity: Medium
- Description: model-catalog.ts treats hermes, kilo, and kimi as FREE_TEXT_MODEL_AGENTS. The test file only asserts the free-text contract for Hermes. There are no tests verifying that kilo/kimi return empty options, drop foreign static models, pass genuine provider-qualified models through, and reset on agent switch.
- Recommended fix: Extend model-catalog.test.ts with a model catalog — free-text agents (kilo + kimi) block covering isFreeTextModelAgent, getModelOptions, getDefaultModelForAgent, resolveModelForAgent, and nextModelOnAgentChange for both providers.

## 3. buildAgentArgs tests lack Kilo / Kimi cases

- File(s): test/build-agent-args.test.ts, lib/providers.ts
- Severity: Low
- Description: The argv-construction regression suite covers claude, codex, hermes, and shell, but not the two newest providers. This leaves the pty-path argv for kilo/kimi unlocked.
- Recommended fix: Add tests for kilo fresh launch (--model <free-text>), kimi fresh launch (--yolo -m <free-text>), and kimi resume (--session <id>), asserting discrete argv tokens and correct flag ordering.

## 4. Command Stoa allowlist excludes the new Kilo / Kimi providers

- File(s): lib/command/actions.ts, test/command-actions.test.ts
- Severity: Medium
- Description: SESSION_AGENT_IDS is hard-coded to [claude, codex, hermes]. The New Session dialog supports kilo/kimi, but Command Stoa cannot create sessions for them. The test locks this exclusion.
- Recommended fix: Either add kilo and kimi to SESSION_AGENT_IDS (and the matching test) if Command Stoa should support all AI agents, or document the intentional limitation in README/docs/ROADMAP and update the test comment to explain why they are excluded.

## 5. summarize-fork tests omit Kilo / Kimi

- File(s): test/summarize-fork-provider.test.ts, app/api/sessions/[id]/summarize/route.ts
- Severity: Low
- Description: The fork-spawn regression suite covers hermes free-text clamping but not kilo/kimi. A change to clampForkModel or buildForkSpawn could silently mis-handle these providers.
- Recommended fix: Add fork spawn tests for kilo and kimi ensuring binary/command are correct and that a free-text/injected model is dropped to the provider default instead of reaching the spawn token.

## 6. README / AGENTS session-persistence claim overstates resume after server restart

- File(s): README.md, AGENTS.md
- Severity: Low
- Description: Both docs state that sessions survive a Stoa server restart via tmux (macOS/Linux) or the Tier-2 pty-host daemon (Windows). For Claude this is true because the resume id is read from on-disk project files. For Hermes and Kimi, the resume id is captured from the startup banner and is lost once the banner scrolls off; there is no on-disk fallback after PR #249 removed the risky cwd-keyed index. After a server restart, re-attached Hermes/Kimi sessions may therefore resume as fresh conversations.
- Recommended fix: Qualify the claim: terminal processes survive restart, but agent-level resume for Hermes and Kimi depends on the banner having been captured before the restart. Clarify that Claude resume is the one guaranteed to persist via on-disk files.

## 7. package.json files array references nonexistent config files

- File(s): package.json
- Severity: Medium
- Description: The files array lists next.config.js and tailwind.config.ts, but the repo contains next.config.ts and no tailwind.config.ts. This will produce npm publish warnings and can omit the actual Next.js config from a packaged build.
- Recommended fix: Update the files array to reference next.config.ts, remove tailwind.config.ts (or add the file if it is required), and include the .next build output if npm distribution is intended.

## 8. AGENTS.md provider-wiring checklist omits Command Stoa allowlist

- File(s): AGENTS.md
- Severity: Low
- Description: The Adding an agent provider section lists registry.ts, providers.ts, NewSessionDialog.types.ts, and model-catalog.ts. It does not mention lib/command/actions.ts SESSION_AGENT_IDS, which also gates create_session for Command Stoa. New providers can be added to the UI while silently failing in the chatbox.
- Recommended fix: Add lib/command/actions.ts (SESSION_AGENT_IDS) to the checklist, and note other agent-specific allowlists such as ASK_PROVIDERS and summarize fork clamping.

## 9. Kilo / Kimi orchestration readiness patterns are not locked

- File(s): test/providers.test.ts, lib/providers.ts
- Severity: Low
- Description: providers.test.ts checks that every provider has readyPatterns and trustPromptPatterns arrays, but does not assert the expected empty-array behavior for kilo and kimi. A future change could add a non-functional pattern or accidentally leave a trust prompt unhandled.
- Recommended fix: Add assertions that getProvider(kilo).readyPatterns and getProvider(kimi).readyPatterns equal [] and trustPromptPatterns equal [], matching the documented TODO/fallback behavior.

## 10. Status route getProviderSessionId kimi branch has no focused test

- File(s): app/api/sessions/status/route.ts
- Severity: Low
- Description: The route added a kimi branch that delegates to statusDetector.getKimiSessionId. There is no unit or integration test verifying this branch or the resolvedSessionIds caching behavior for kimi.
- Recommended fix: Add a route-level test (mocking getSessionBackend and statusDetector) that verifies getProviderSessionId returns the kimi banner id and that the result is cached in resolvedSessionIds on subsequent calls.

---

## Notes on test flakiness

- Tests that spawn real node processes and poll with waitFor (test/hermes-session-id.test.ts, test/status-render.test.ts, test/pty-host.test.ts) are currently green but use wall-clock timeouts. On heavily loaded CI runners these could become flaky. Consider increasing timeouts slightly or using vitest fake timers where the code under test is pure.

---

## Area: workflows

# Workflow builder bug-hunt report

**Scope reviewed:** `components/views/WorkflowsView/*`, `lib/pipeline/builder-model.ts`, `lib/saved-workflows.ts`, and their unit tests (`test/pipeline-builder-model.test.ts`, `test/saved-workflows.test.ts`).

**Note on requested components:** The files `Minimap` and `SnippetsPanel` referenced in the request do not exist in the repository; the visual builder currently consists of `WorkflowBuilder`, `PipelineCanvas`, `PipelineGraph`, `CustomSpecForm`, `ParamForm`, `TemplatePicker`, `ExamplesTab`, `RunsList`, `RunDetail`, and `WorkflowsHelp`.

---

## Findings

### 1. Unsaved-changes indicator ignores empty workflows

- **File:** `components/views/WorkflowsView/WorkflowBuilder.tsx` (lines 159–162)
- **Severity:** Low
- **Description:** `dirty` is computed as `doc.nodes.length > 0 && serializeBuilderDoc(doc) !== savedSnapshot`. As a result, editing the workflow name or working directory on an empty canvas shows no amber dot, and deleting every step hides the dot even though the previously saved workflow had content.
- **Recommended fix:** Drop the node-count guard so any deviation from the snapshot is flagged: `const dirty = serializeBuilderDoc(doc) !== savedSnapshot`.

### 2. Loading/importing a workflow discards unsaved edits without confirmation

- **File:** `components/views/WorkflowsView/WorkflowBuilder.tsx` (`loadDoc`, `handleImportFile`, and the New / Load example / Saved menu items)
- **Severity:** Medium
- **Description:** Choosing **New workflow**, **Load example**, picking a saved workflow, or importing a JSON file replaces the current `doc` immediately. When `dirty` is true, the user loses in-progress edits with no warning.
- **Recommended fix:** Gate those transitions with the existing `confirm()` helper whenever `dirty` is true.

### 3. Renaming a step does not rewrite output references in task text

- **File:** `lib/pipeline/builder-model.ts` (`renameStep`, lines 294–311)
- **Severity:** Medium
- **Description:** `renameStep` cascades the id into every other step’s `dependsOn`, but it leaves `{{steps.<oldId>.output}}` placeholders in task strings untouched. After a rename, `validateSpec` reports the old reference as unknown or not in the dependency closure, which is surprising because the rename appeared successful.
- **Recommended fix:** Rewrite `{{steps.<oldId>.output}}` placeholders in every task (and optionally `exitCriteria`) to use the new id, or surface an explicit warning that tasks reference the old id.

### 4. Canvas interactions are not keyboard accessible

- **File:** `components/views/WorkflowsView/PipelineCanvas.tsx`
- **Severity:** Medium
- **Description:** Selecting, dragging, connecting, and disconnecting all rely on pointer events. Nodes, ports, and edges have no `tabIndex`, ARIA roles, focus styles, or keyboard handlers, so keyboard-only users and many screen-reader users cannot operate the visual builder.
- **Recommended fix:** Add `tabIndex={0}`, `role="button"/"link"`, `aria-selected`/`aria-grabbed`, and keyboard controls (arrow keys to move, Enter to select, a dedicated connect mode or Shift+arrow for edges).

### 5. Edit panel scrolls into view on drag, not just on tap

- **File:** `components/views/WorkflowsView/WorkflowBuilder.tsx` (lines 129–131)
- **Severity:** Medium
- **Description:** A `useEffect` scrolls the edit panel into view whenever `selectedId` changes. `onNodePointerDown` changes selection immediately, so on a phone, dragging a node to rearrange it also scrolls the page down to the edit panel mid-drag.
- **Recommended fix:** Trigger the scroll from a tap/click handler rather than pointer down, or only scroll when the pointer is released without significant movement.

### 6. SVG arrowhead marker ID collision in `PipelineGraph`

- **File:** `components/views/WorkflowsView/PipelineGraph.tsx` (lines 51–61)
- **Severity:** Low
- **Description:** The marker id `"stoa-graph-arrow"` is hardcoded. If more than one `PipelineGraph` mounts at the same time (e.g., the Custom preview and a Run detail), the second graph’s `markerEnd="url(#stoa-graph-arrow)"` may resolve to the first graph’s definition.
- **Recommended fix:** Generate a unique id per instance with `useId()` and use it in both `<marker id={...}>` and `markerEnd={`url(#${id})`}`.

### 7. Imported/stored docs are not checked for duplicate step IDs

- **File:** `lib/pipeline/builder-model.ts` (`parseBuilderDoc`, lines 61–119)
- **Severity:** Low
- **Description:** `parseBuilderDoc` drops malformed nodes but does not detect duplicate step ids. A stored or imported workflow with duplicate ids renders multiple nodes with the same React key until `validateSpec` fails at run time.
- **Recommended fix:** Track seen ids while parsing and either drop duplicates or reject the doc as malformed.

### 8. Stored workflow name may be whitespace-only

- **File:** `app/api/saved-workflows/route.ts` and `app/api/saved-workflows/[id]/route.ts`
- **Severity:** Low
- **Description:** The API accepts any non-empty string as `name`, including whitespace-only strings. The UI’s `saveGuard` trims before checking, but the persisted name retains leading/trailing spaces.
- **Recommended fix:** Trim the name in the route/service and reject `name.trim().length === 0` with a 400 error.

### 9. `createSavedWorkflow` trusts the get-after-insert row

- **File:** `lib/saved-workflows.ts` (lines 38–45)
- **Severity:** Low
- **Description:** After inserting, the function re-fetches the row and casts it with `as SavedWorkflowRow`. If the row is unexpectedly absent, `toSavedWorkflow` dereferences `undefined` and throws.
- **Recommended fix:** Guard the row: `const row = queries.getSavedWorkflow(db).get(id); if (!row) throw new Error(...);`.

### 10. Status palette lookup is unsafe against corrupted run data

- **File:** `components/views/WorkflowsView/PipelineGraph.tsx` (line 107) and `components/views/WorkflowsView/RunDetail.tsx` (line 116)
- **Severity:** Low
- **Description:** `STEP_STATUS_META[status].swatch` and `STEP_STATUS_META[st?.status ?? "pending"]` assume the status is always a valid key. A malformed status value can cause `Cannot read properties of undefined`.
- **Recommended fix:** Use safe lookup with a fallback: `STEP_STATUS_META[status]?.swatch ?? ""` and `STEP_STATUS_META[status]?.badge ?? STEP_STATUS_META.pending.badge`.

### 11. No file size limit on import

- **File:** `components/views/WorkflowsView/WorkflowBuilder.tsx` (`handleImportFile`)
- **Severity:** Low
- **Description:** `FileReader` loads the chosen file regardless of size. A maliciously huge JSON file can hang the main thread or cause an out-of-memory error.
- **Recommended fix:** Reject files over a sensible limit (e.g., 5 MB) before calling `reader.readAsText`.

### 12. Object URL is revoked immediately after export click

- **File:** `components/views/WorkflowsView/WorkflowBuilder.tsx` (lines 247–252)
- **Severity:** Low
- **Description:** `URL.revokeObjectURL(url)` is called right after `a.click()`. On some browsers this can cancel the download before it starts.
- **Recommended fix:** Revoke the URL after a short delay, e.g., `setTimeout(() => URL.revokeObjectURL(url), 1000)`.

### 13. Conductor session selection can become stale

- **File:** `components/views/WorkflowsView/WorkflowBuilder.tsx`, `CustomSpecForm.tsx`, `ParamForm.tsx`
- **Severity:** Low
- **Description:** `conductorId` is initialized from props but never revalidated against the current `sessions` array. If the selected session is removed, the Start button can become enabled while the API call will fail.
- **Recommended fix:** Add an effect or memoized validation that resets `conductorId` to a still-existing session (or the default) when `sessions` changes.

### 14. Drag updates are unthrottled

- **File:** `components/views/WorkflowsView/PipelineCanvas.tsx` (`onNodePointerMove`)
- **Severity:** Low
- **Description:** Every pointer-move calls `onMoveNode` → `setDoc` → full `WorkflowBuilder` + `PipelineCanvas` re-render. With many nodes this can drop frames on lower-end devices.
- **Recommended fix:** Throttle move commits (e.g., `requestAnimationFrame` or a 16 ms throttle) and keep a local ref for the visual drag position, committing the final coordinate on pointer up.

### 15. Save snapshot can capture edits made during the async save

- **File:** `components/views/WorkflowsView/WorkflowBuilder.tsx` (`handleSave`)
- **Severity:** Low
- **Description:** `setSavedSnapshot(serializeBuilderDoc(doc))` runs after `await updateWf.mutateAsync(...)`. While the save button is disabled, other edits (e.g., typing in the task field) can still mutate `doc`, so the snapshot may mark post-save edits as already saved.
- **Recommended fix:** Serialize the doc at the start of `handleSave` and use that serialized value to update `savedSnapshot` on success.

### 16. Test gaps around edge cases

- **File:** `test/pipeline-builder-model.test.ts`, `test/saved-workflows.test.ts`
- **Severity:** Low
- **Description:** The model tests cover happy paths and malformed `dependsOn`, but they do not assert behavior for duplicate ids in `parseBuilderDoc`, rename with output references, or the `dirty`/empty-doc behavior in `WorkflowBuilder`.
- **Recommended fix:** Add regression tests for duplicate-id parsing, rename cascading into `{{steps.<id>.output}}`, and `dirty` calculation when a workflow has no nodes.

---

## Security / XSS summary

- No `dangerouslySetInnerHTML`, `eval`, `new Function`, or shell-string `exec` were found in the reviewed builder code.
- Imported JSON is parsed with `JSON.parse` and sanitized by `parseBuilderDoc`; no code execution path was identified.
- The saved-workflow API boundaries sanitize the doc shape at the server.
- The only security note is that the saved-workflow endpoints have no per-user authorization, which is consistent with Stoa’s current single-user desktop model but should be revisited if multi-user support is added.

## Components not found

- `Minimap` and `SnippetsPanel` do not exist in `components/views/WorkflowsView/` or elsewhere in the repository, so no issues were found for them.

---
