/**
 * Dispatch — reviewer gate (opt-in).
 *
 * When a repo has `review_gate` on, each worker's PR gets a PANEL of three
 * INDEPENDENT critic agents (one per lens) spawned in the worker's worktree.
 * Each posts a lens-tagged PR comment ending in a verdict marker; Stoa aggregates
 * the markers (any "request changes" ⇒ CHANGES_REQUESTED, else APPROVED) and
 * caches the decision on the row, driving the fix loop and the cockpit badge.
 * A panel (rather than one agent across three lenses) keeps the perspectives
 * genuinely independent. Pure helpers (buildLensReviewPrompt / parsePanelComments)
 * are unit-tested; the spawn + gh reads are I/O. Only Stoa's own comments count
 * toward a verdict (anti-forgery — see parsePanelComments).
 */

import { randomUUID } from "crypto";
import { execFile } from "child_process";
import { promisify } from "util";
import { getDb, queries } from "../db";
import { resolveModelForAgent } from "../model-catalog";
import { getProvider, buildAgentArgs, shellQuoteArg } from "../providers";
import type { AgentType } from "../providers";
import { sessionKey } from "../providers/registry";
import { wrapWithBanner } from "../banner";
import { getSessionBackend } from "../session-backend";
import { resolveBinary, expandHome } from "../platform";
import type { DispatchRepo, IssueDispatch } from "./types";
import { isLocalTask, taskLabel, taskRef } from "./task-label";

const execFileAsync = promisify(execFile);
const gh = resolveBinary("gh") || "gh";

/**
 * The three independent critic lenses. Each is reviewed by its OWN agent (a
 * panel), not one agent juggling all three — independence catches what a single
 * reviewer rationalizes past. `key` is the machine tag in the verdict marker.
 */
export const REVIEW_LENSES = [
  {
    key: "correctness",
    title: "correctness & security",
    focus:
      "logic bugs, edge cases, error handling, and security holes — and whether the change actually resolves the issue without regressions",
  },
  {
    key: "conventions",
    title: "conventions & cross-platform",
    focus:
      "house style and naming, and cross-platform safety: no POSIX-only assumptions, no shell-string exec, no hardcoded paths/separators",
  },
  {
    key: "simplicity",
    title: "simplicity & scope",
    focus:
      "unnecessary complexity, scope creep beyond the issue, duplication, and dead code — name the simpler form",
  },
] as const;

/** The lens keys, derived once (the aggregator's required-lens set). */
const LENS_KEYS: readonly string[] = REVIEW_LENSES.map((l) => l.key);

/**
 * The canonical verdict marker a panelist's PR comment must END with, parsed by
 * parsePanelComments. Exported + shared so the dispatch and session review prompts
 * can't drift on this load-bearing line (a mismatch silently breaks aggregation).
 * The reviewer swaps APPROVE → REQUEST_CHANGES when a lens finds a blocker.
 */
export function reviewVerdictMarker(lensKey: string, round: number): string {
  return `STOA_REVIEW lens=${lensKey} round=${round} verdict=APPROVE`;
}

/**
 * One panelist's brief: read-only review through a SINGLE lens, ending in a PR
 * comment whose final line is a machine-parseable verdict marker that embeds the
 * lens + the current fix round (so a re-review's stale comments are ignored).
 * Pure (unit-tested for the key instructions).
 */
export function buildLensReviewPrompt(
  repo: DispatchRepo,
  d: IssueDispatch,
  lens: (typeof REVIEW_LENSES)[number]
): string {
  const round = d.fix_rounds;
  // Local tasks have no GitHub issue to read — give the critic the task brief
  // inline and drop the (failing) `gh issue view 0` line.
  const readStep = isLocalTask(d)
    ? `1. Read the change:\n   gh pr diff ${d.pr_number}\n` +
      (d.task_body?.trim()
        ? `\nThe task it implements:\n${d.task_body.trim()}\n\n`
        : "")
    : `1. Read the change and the issue:\n` +
      `   gh pr diff ${d.pr_number}\n` +
      `   gh issue view ${d.issue_number} --repo ${repo.repo_slug}\n`;
  return (
    `[Stoa] You are ONE of three INDEPENDENT reviewers for pull request ` +
    `#${d.pr_number} in ${repo.repo_slug} (it resolves ${taskRef(d)}).\n\n` +
    `YOUR LENS: ${lens.title}. Judge ONLY through this lens — ${lens.focus}.\n\n` +
    `Review ONLY — do NOT modify code, commit, or push anything.\n\n` +
    readStep +
    `2. Assess it through your lens. Be concrete and terse.\n` +
    `3. Post ONE PR comment on #${d.pr_number} (gh pr comment ${d.pr_number}) — a ` +
    `few lines of findings, then the LAST line EXACTLY this marker, verbatim, ` +
    `nothing after it:\n` +
    `   ${reviewVerdictMarker(lens.key, round)}\n` +
    `Use verdict=REQUEST_CHANGES instead of APPROVE if your lens finds a blocking ` +
    `problem. If a multi-line --body is awkward in your shell, write the body to ` +
    `a file and use \`gh pr comment ${d.pr_number} --body-file <file>\`. Do NOT ` +
    `post a GitHub review or open a new PR — only the one comment.`
  );
}

export interface PanelVerdict {
  /** Per-lens verdict parsed from the panel's PR comments (current round only). */
  byLens: Record<string, "APPROVE" | "REQUEST_CHANGES">;
  /** True once every lens has posted a verdict for this round. */
  complete: boolean;
  /** Aggregate once complete: any REQUEST_CHANGES ⇒ CHANGES_REQUESTED, else APPROVED. */
  decision: "APPROVED" | "CHANGES_REQUESTED" | null;
}

interface PanelComment {
  body?: unknown;
  /** GitHub login of the comment author — only Stoa's own count (anti-forgery). */
  author?: { login?: unknown } | null;
}

/**
 * Aggregate the panel's verdict markers out of a PR's comments. Pure + tested.
 * SECURITY: only comments authored by `actor` (Stoa's gh account) count — without
 * this, any repo collaborator could post a forged marker to force APPROVED (and,
 * with auto-merge armed, a merge). Only markers for `round` count (a fixer bumps
 * the round, so the prior round's comments are ignored); the latest comment wins
 * per lens. The decision is set only once ALL lenses have weighed in. Callers
 * must pass `comments` already sorted oldest→newest so "latest wins" holds.
 */
export function parsePanelComments(
  comments: PanelComment[],
  lensKeys: readonly string[],
  round: number,
  actor: string
): PanelVerdict {
  const byLens: Record<string, "APPROVE" | "REQUEST_CHANGES"> = {};
  for (const c of comments) {
    const login =
      c?.author && typeof c.author.login === "string" ? c.author.login : "";
    if (!actor || login !== actor) continue; // not Stoa's comment → ignore
    const body = typeof c.body === "string" ? c.body : "";
    // Fresh regex per body so the /g lastIndex can never leak across comments.
    const marker =
      /STOA_REVIEW\s+lens=(\w+)\s+round=(\d+)\s+verdict=(APPROVE|REQUEST_CHANGES)/g;
    for (const m of body.matchAll(marker)) {
      const [, lens, r, verdict] = m;
      if (Number(r) !== round || !lensKeys.includes(lens)) continue;
      byLens[lens] = verdict as "APPROVE" | "REQUEST_CHANGES";
    }
  }
  const complete = lensKeys.every((k) => k in byLens);
  const decision = !complete
    ? null
    : lensKeys.some((k) => byLens[k] === "REQUEST_CHANGES")
      ? "CHANGES_REQUESTED"
      : "APPROVED";
  return { byLens, complete, decision };
}

// Stoa's own gh login, resolved once and cached for the process (constant for a
// given auth). The panel's anti-forgery check compares comment authors to this.
// undefined = not fetched yet; null = couldn't determine (→ never approve).
let cachedActor: string | null | undefined;

/** The authenticated gh account's login (cached). null on failure. */
export async function getGhActor(cwd: string): Promise<string | null> {
  if (cachedActor !== undefined) return cachedActor;
  try {
    const { stdout } = await execFileAsync(
      gh,
      ["api", "user", "--jq", ".login"],
      { cwd, encoding: "utf-8", timeout: 15000, windowsHide: true }
    );
    cachedActor = stdout.trim() || null;
  } catch {
    cachedActor = null;
  }
  return cachedActor;
}

interface RawComment {
  body?: unknown;
  author?: { login?: unknown } | null;
  createdAt?: unknown;
}

/** Read the panel's aggregated verdict for a PR from its comments (this round).
 * Returns an incomplete verdict on any gh failure — or if Stoa's own login can't
 * be resolved (so a forged comment can never stand in for the panel) — so the
 * caller keeps polling rather than acting on an unverifiable verdict. */
export async function aggregatePanelVerdict(
  cwd: string,
  prNumber: number,
  round: number
): Promise<PanelVerdict> {
  const incomplete: PanelVerdict = {
    byLens: {},
    complete: false,
    decision: null,
  };
  try {
    const actor = await getGhActor(cwd);
    if (!actor) return incomplete;
    const { stdout } = await execFileAsync(
      gh,
      ["pr", "view", String(prNumber), "--json", "comments"],
      { cwd, encoding: "utf-8", timeout: 15000, windowsHide: true }
    );
    const parsed = JSON.parse(stdout) as { comments?: RawComment[] };
    const comments = Array.isArray(parsed.comments) ? parsed.comments : [];
    // Sort oldest→newest so parsePanelComments' "latest wins per lens" is correct
    // regardless of the order gh happens to return them in.
    comments.sort((a, b) =>
      String(a?.createdAt ?? "").localeCompare(String(b?.createdAt ?? ""))
    );
    return parsePanelComments(comments, LENS_KEYS, round, actor);
  } catch {
    return incomplete;
  }
}

/**
 * The session ceremony's verdict marker — binds the verdict to the EXACT commit
 * the panelist reviewed (the panelist reads `gh pr view --json headRefOid` and
 * stamps it). Unlike the dispatch round marker, the SHA is the identity: the
 * aggregator counts only markers whose sha equals the pinned review_sha, so a
 * stale panel (a re-enrol / cancel-mid-review race, or a push between review and
 * merge) can never approve commits it didn't see — immune to round/time games.
 */
export function sessionReviewMarker(
  reviewSha: string,
  lensKey: string
): string {
  return `STOA_SESSION_REVIEW sha=${reviewSha} lens=${lensKey} verdict=APPROVE`;
}

/**
 * Pure: aggregate STOA_SESSION_REVIEW markers for an EXACT reviewSha. Only `actor`
 * comments count (anti-forgery); latest wins per lens; complete once every lens
 * weighed in for that sha. Unit-tested. (Mirrors parsePanelComments but keyed on
 * sha, not round.)
 */
export function parseSessionComments(
  comments: PanelComment[],
  lensKeys: readonly string[],
  reviewSha: string,
  actor: string
): PanelVerdict {
  const byLens: Record<string, "APPROVE" | "REQUEST_CHANGES"> = {};
  if (!reviewSha) return { byLens, complete: false, decision: null };
  for (const c of comments) {
    const login =
      c?.author && typeof c.author.login === "string" ? c.author.login : "";
    if (!actor || login !== actor) continue; // not Stoa's comment → ignore
    const body = typeof c.body === "string" ? c.body : "";
    const marker =
      /STOA_SESSION_REVIEW\s+sha=([0-9a-fA-F]+)\s+lens=(\w+)\s+verdict=(APPROVE|REQUEST_CHANGES)/g;
    for (const m of body.matchAll(marker)) {
      const [, sha, lens, verdict] = m;
      if (sha !== reviewSha || !lensKeys.includes(lens)) continue;
      byLens[lens] = verdict as "APPROVE" | "REQUEST_CHANGES";
    }
  }
  const complete = lensKeys.every((k) => k in byLens);
  const decision = !complete
    ? null
    : lensKeys.some((k) => byLens[k] === "REQUEST_CHANGES")
      ? "CHANGES_REQUESTED"
      : "APPROVED";
  return { byLens, complete, decision };
}

/** Read the session panel's verdict for an EXACT reviewSha from the PR comments.
 * Incomplete on any gh failure / unresolvable actor (the caller keeps polling). */
export async function aggregateSessionVerdict(
  cwd: string,
  prNumber: number,
  reviewSha: string
): Promise<PanelVerdict> {
  const incomplete: PanelVerdict = {
    byLens: {},
    complete: false,
    decision: null,
  };
  try {
    const actor = await getGhActor(cwd);
    if (!actor) return incomplete;
    const { stdout } = await execFileAsync(
      gh,
      ["pr", "view", String(prNumber), "--json", "comments"],
      { cwd, encoding: "utf-8", timeout: 15000, windowsHide: true }
    );
    const parsed = JSON.parse(stdout) as { comments?: RawComment[] };
    const comments = Array.isArray(parsed.comments) ? parsed.comments : [];
    comments.sort((a, b) =>
      String(a?.createdAt ?? "").localeCompare(String(b?.createdAt ?? ""))
    );
    return parseSessionComments(comments, LENS_KEYS, reviewSha, actor);
  } catch {
    return incomplete;
  }
}

/** One lens's finding for the Verdict Inbox: the verdict + the critic's prose
 * (the comment body minus the marker line). */
export interface ReviewerFinding {
  lens: string;
  verdict: "APPROVE" | "REQUEST_CHANGES";
  text: string;
}

// Matches either marker family (dispatch round-marker OR session sha-marker) in
// one global pass, so we can take the LAST marker in a body (latest wins) and
// strip them ALL from the prose. Alternation groups: 1/2 = dispatch lens/verdict,
// 3/4 = session lens/verdict.
const FINDING_MARKER =
  /STOA_REVIEW\s+lens=(\w+)\s+round=\d+\s+verdict=(APPROVE|REQUEST_CHANGES)|STOA_SESSION_REVIEW\s+sha=[0-9a-fA-F]+\s+lens=(\w+)\s+verdict=(APPROVE|REQUEST_CHANGES)/g;

/**
 * Pure: extract the panel's per-lens findings (verdict + prose) from a PR's
 * comments. Only `actor`-authored comments count (anti-forgery, same as the
 * verdict). Latest comment per lens wins (caller pre-sorts oldest→newest); within
 * a body the LAST marker wins (a comment that quotes a prior round before its
 * fresh verdict must not report the stale one). The prose is the body with every
 * marker stripped. Unit-tested.
 */
export function parseReviewerFindings(
  comments: PanelComment[],
  actor: string
): ReviewerFinding[] {
  const byLens: Record<string, ReviewerFinding> = {};
  if (!actor) return [];
  for (const c of comments) {
    const login =
      c?.author && typeof c.author.login === "string" ? c.author.login : "";
    if (login !== actor) continue;
    const body = typeof c.body === "string" ? c.body : "";
    const matches = [...body.matchAll(FINDING_MARKER)];
    if (matches.length === 0) continue;
    const m = matches[matches.length - 1]; // latest marker in this body wins
    const lens = m[1] ?? m[3];
    const verdict = (m[2] ?? m[4]) as "APPROVE" | "REQUEST_CHANGES";
    const text = body.replace(FINDING_MARKER, "").trim();
    byLens[lens] = { lens, verdict, text };
  }
  return Object.values(byLens);
}

/** Read a PR's per-lens reviewer findings (verdict + prose) via gh. Empty on any
 * failure or unresolvable actor — the Verdict Inbox just shows the cached verdict. */
export async function readReviewerFindings(
  cwd: string,
  prNumber: number
): Promise<ReviewerFinding[]> {
  try {
    const actor = await getGhActor(cwd);
    if (!actor) return [];
    const { stdout } = await execFileAsync(
      gh,
      ["pr", "view", String(prNumber), "--json", "comments"],
      { cwd, encoding: "utf-8", timeout: 15000, windowsHide: true }
    );
    const parsed = JSON.parse(stdout) as { comments?: RawComment[] };
    const comments = Array.isArray(parsed.comments) ? parsed.comments : [];
    comments.sort((a, b) =>
      String(a?.createdAt ?? "").localeCompare(String(b?.createdAt ?? ""))
    );
    return parseReviewerFindings(comments, actor);
  } catch {
    return [];
  }
}

/** Max worker fix rounds before a PR is left for a human (env-overridable;
 * `STOA_MAX_FIX_ROUNDS=0` validly disables the fixer, leaving critic-only). */
export const MAX_FIX_ROUNDS = (() => {
  const raw = process.env.STOA_MAX_FIX_ROUNDS;
  if (raw == null) return 2;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 2;
})();

export type ReviewAction =
  | "spawn_critic"
  | "spawn_fixer"
  | "rereview"
  | "wait"
  | "approved"
  | "stuck"
  | "idle";

/**
 * Pure state machine for the review/fix loop on one open PR. Unit-tested.
 *   no critic yet            → spawn_critic
 *   critic: APPROVED         → approved (ready to merge)
 *   critic: CHANGES_REQUESTED → spawn_fixer (under cap) else stuck (needs human)
 *   fixer running            → wait
 *   fixer finished           → rereview (clear + re-spawn a fresh critic)
 */
export function nextReviewAction(input: {
  reviewGate: boolean;
  status: string;
  prNumber: number | null;
  reviewerSessionId: string | null;
  reviewDecision: string | null;
  fixerSessionId: string | null;
  fixerAlive: boolean;
  fixRounds: number;
  maxFixRounds: number;
}): ReviewAction {
  if (
    !input.reviewGate ||
    input.status !== "pr_open" ||
    input.prNumber == null
  ) {
    return "idle";
  }
  if (input.fixerSessionId && input.fixerAlive) return "wait";
  if (input.fixerSessionId && !input.fixerAlive) return "rereview";
  if (!input.reviewerSessionId) return "spawn_critic";
  if (input.reviewDecision === "APPROVED") return "approved";
  if (input.reviewDecision === "CHANGES_REQUESTED") {
    return input.fixRounds < input.maxFixRounds ? "spawn_fixer" : "stuck";
  }
  return "idle"; // pending / unknown — keep polling the decision
}

/** The fixer's brief: address the review feedback and push to the SAME branch
 * (updates the existing PR — no new PR). Pure (unit-tested). */
export function buildFixPrompt(repo: DispatchRepo, d: IssueDispatch): string {
  return (
    `[Stoa] A reviewer requested changes on pull request #${d.pr_number} in ` +
    `${repo.repo_slug} (${taskRef(d)}).\n\n` +
    `You are in the PR's worktree.\n\n` +
    `1. Read the feedback and the diff:\n` +
    `   gh pr view ${d.pr_number} --comments\n` +
    `   gh pr diff ${d.pr_number}\n` +
    `2. Implement the requested changes, commit them, and PUSH to the SAME ` +
    `branch (git push). Do NOT open a new PR — pushing updates PR #${d.pr_number}.\n` +
    `3. Keep the changes scoped to the feedback.`
  );
}

/**
 * The minimal target for a worktree spawn — the fields the recipe actually needs,
 * decoupled from `DispatchRepo`/`IssueDispatch` so a SESSION ceremony reuses the
 * exact same spawn (its worktree/branch live on the session row, not a dispatch).
 */
export interface WorktreeSpawnTarget {
  agentType: AgentType;
  projectId: string | null;
  baseBranch: string | null;
  worktreePath: string | null;
  branchName: string | null;
  /** Identifier for error logs (e.g. "owner/repo#12" or "session abc123"). */
  label: string;
}

/**
 * Spawn an agent in an existing worktree (no new worktree). Records the session
 * id via `onSpawn` BEFORE the backend create, so the spawn-once guard holds even
 * if create throws. Returns the session id or null on failure. autoApprove so the
 * agent runs gh/git unattended (prompt-bounded; the inherent opt-in risk). The
 * core recipe — both dispatch (`spawnInWorktree`) and the session ceremony spawn
 * through this, so there's one worktree-session spawn in the codebase.
 */
export async function spawnWorktreeWorker(
  target: WorktreeSpawnTarget,
  sessionName: string,
  prompt: string,
  onSpawn: (sessionId: string) => void
): Promise<string | null> {
  if (!target.worktreePath) return null;
  try {
    const db = getDb();
    const provider = getProvider(target.agentType);
    const model = resolveModelForAgent(target.agentType, undefined);
    const cwd = expandHome(target.worktreePath);
    const sessionId = randomUUID();
    const tmuxName = sessionKey({
      kind: "agent",
      provider: provider.id,
      id: sessionId,
    });
    queries
      .createSession(db)
      .run(
        sessionId,
        sessionName,
        tmuxName,
        cwd,
        null,
        model,
        null,
        "sessions",
        target.agentType,
        1,
        target.projectId ?? "uncategorized"
      );
    // Persist worktree/branch on the session row (consistency with dispatcher)
    // so reviewer/fixer sessions are complete for diff/branch lookups.
    queries
      .updateSessionWorktree(db)
      .run(cwd, target.branchName, target.baseBranch, null, sessionId);
    onSpawn(sessionId); // record id BEFORE create (spawn-once)
    const { binary, args } = buildAgentArgs(target.agentType, {
      model,
      autoApprove: true,
      initialPrompt: prompt,
    });
    const command = wrapWithBanner(
      [binary, ...args.map(shellQuoteArg)].join(" ")
    );
    await getSessionBackend().create({
      name: tmuxName,
      cwd,
      command,
      binary,
      args,
    });
    return sessionId;
  } catch (err) {
    console.error(`spawn (${sessionName}) failed for ${target.label}:`, err);
    return null;
  }
}

/**
 * Spawn an agent in a dispatch worker's worktree — a thin adapter over
 * `spawnWorktreeWorker` (behavior identical to before the extraction). Exported
 * so the CI-fix loop reuses the exact same recipe.
 */
export async function spawnInWorktree(
  repo: DispatchRepo,
  d: IssueDispatch,
  sessionName: string,
  prompt: string,
  onSpawn: (sessionId: string) => void
): Promise<string | null> {
  return spawnWorktreeWorker(
    {
      agentType: repo.agent_type,
      projectId: repo.project_id,
      baseBranch: repo.base_branch,
      worktreePath: d.worktree_path,
      branchName: d.branch_name,
      label: isLocalTask(d)
        ? `${repo.repo_slug} ${taskLabel(d)}`
        : `${repo.repo_slug}#${d.issue_number}`,
    },
    sessionName,
    prompt,
    onSpawn
  );
}

/**
 * Spawn the review PANEL: one independent critic per lens, all in the worker's
 * worktree (read-only, so sharing the worktree is safe). `reviewer_session_id`
 * is set ONCE — on the first panelist — as the spawn-once guard for the whole
 * panel; the panel's completion is then judged from the PR comments, not session
 * liveness. Returns the first panelist's session id (or null if none spawned).
 */
export async function spawnReviewPanel(
  repo: DispatchRepo,
  d: IssueDispatch
): Promise<string | null> {
  if (d.pr_number == null) return null;
  let guardSet = false;
  let firstId: string | null = null;
  for (const lens of REVIEW_LENSES) {
    const sid = await spawnInWorktree(
      repo,
      d,
      `review #${d.pr_number} · ${lens.key}`,
      buildLensReviewPrompt(repo, d, lens),
      (id) => {
        if (!guardSet) {
          queries.setDispatchReviewer(getDb()).run(id, d.id);
          guardSet = true;
        }
      }
    );
    if (sid && !firstId) firstId = sid;
  }
  return firstId;
}

/** Spawn a fixer that addresses review feedback (records fixer + bumps round). */
export async function spawnFixer(
  repo: DispatchRepo,
  d: IssueDispatch
): Promise<string | null> {
  if (d.pr_number == null) return null;
  return spawnInWorktree(
    repo,
    d,
    `fix #${d.pr_number}`,
    buildFixPrompt(repo, d),
    (sid) => queries.startFixRound(getDb()).run(sid, d.id)
  );
}
