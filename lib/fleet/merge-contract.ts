import { createHash } from "crypto";
import { resolve } from "path";
import { stoaHomeDir } from "@/lib/platform";

export interface FleetPrStatus {
  number: number;
  url: string;
  state: string | null;
  baseRefName: string | null;
  baseSha: string | null;
  headSha: string | null;
  mergeSha: string | null;
  mergeable: string | null;
  checks: "none" | "passing" | "pending" | "failing";
  checkContexts: Readonly<Record<string, "passing" | "pending" | "failing">>;
}

export interface FleetRequiredCheckSet {
  checks: readonly {
    context: string;
    integrationId: number | null;
  }[];
}

const MAX_GITHUB_CHECK_IDENTITIES = 256;
const MAX_GITHUB_CHECK_IDENTITY_BYTES = 512;
export const FLEET_REQUIRED_RULES_PAGE_SIZE = 100;
export const FLEET_REQUIRED_RULES_MAX_PAGES = 10;
export const FLEET_REQUIRED_RULES_MAX_PAGE_BYTES = 256 * 1024;
export const FLEET_REQUIRED_RULES_MAX_TOTAL_BYTES = 1024 * 1024;

function boundedCheckIdentity(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  if (
    Buffer.byteLength(value, "utf8") > MAX_GITHUB_CHECK_IDENTITY_BYTES ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    return null;
  }
  return value;
}

function parseCheckContexts(
  value: unknown
): Record<string, "passing" | "pending" | "failing"> | null {
  if (!Array.isArray(value) || value.length > MAX_GITHUB_CHECK_IDENTITIES) {
    return null;
  }
  const contexts: Record<string, "passing" | "pending" | "failing"> =
    Object.create(null) as Record<string, "passing" | "pending" | "failing">;
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const row = item as Record<string, unknown>;
    const identity = boundedCheckIdentity(row.name ?? row.context);
    if (!identity || Object.hasOwn(contexts, identity)) return null;
    const state = summarizeGitHubChecks([row]);
    if (state === "none") return null;
    contexts[identity] = state;
  }
  return contexts;
}

export function fleetIntegrationIdentity(runId: string): {
  branch: string;
  worktree: string;
} {
  const digest = createHash("sha256")
    .update(runId, "utf8")
    .digest("hex")
    .slice(0, 20);
  return {
    branch: `stoa/fleet/integration-${digest}`,
    worktree: resolve(stoaHomeDir(), "fleet", "integrations", digest),
  };
}

export function summarizeGitHubChecks(value: unknown): FleetPrStatus["checks"] {
  if (!Array.isArray(value) || value.length === 0) return "none";
  let pending = false;
  const passing = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);
  const inProgress = new Set([
    "",
    "PENDING",
    "QUEUED",
    "IN_PROGRESS",
    "EXPECTED",
    "REQUESTED",
    "WAITING",
  ]);
  for (const item of value) {
    const row =
      item && typeof item === "object" ? (item as Record<string, unknown>) : {};
    const conclusion = String(row.conclusion ?? "").toUpperCase();
    const state = String(row.state ?? row.status ?? "").toUpperCase();
    if (conclusion) {
      // GitHub can add new terminal conclusions. Only explicitly accepted
      // outcomes may authorize a merge; every other conclusion fails closed.
      if (!passing.has(conclusion)) return "failing";
      continue;
    }
    if (passing.has(state)) continue;
    if (inProgress.has(state)) {
      pending = true;
      continue;
    }
    // COMPLETED without a conclusion, known failures, and unknown terminal
    // states are all unsafe to interpret as success.
    return "failing";
  }
  return pending ? "pending" : "passing";
}

export function parseFleetPrStatus(value: string): FleetPrStatus | null {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    const number = Number(parsed.number);
    const rawUrl = typeof parsed.url === "string" ? parsed.url : "";
    if (!Number.isSafeInteger(number) || number <= 0 || !rawUrl) return null;
    const parsedUrl = new URL(rawUrl);
    if (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:") {
      return null;
    }
    const mergeCommit =
      parsed.mergeCommit && typeof parsed.mergeCommit === "object"
        ? (parsed.mergeCommit as Record<string, unknown>).oid
        : null;
    const checkContexts = parseCheckContexts(parsed.statusCheckRollup);
    if (!checkContexts) return null;
    return {
      number,
      url: parsedUrl.toString(),
      state: typeof parsed.state === "string" ? parsed.state : null,
      baseRefName:
        typeof parsed.baseRefName === "string" && parsed.baseRefName.length > 0
          ? parsed.baseRefName
          : null,
      baseSha: typeof parsed.baseRefOid === "string" ? parsed.baseRefOid : null,
      headSha: typeof parsed.headRefOid === "string" ? parsed.headRefOid : null,
      mergeSha: typeof mergeCommit === "string" ? mergeCommit : null,
      mergeable: typeof parsed.mergeable === "string" ? parsed.mergeable : null,
      checks: summarizeGitHubChecks(parsed.statusCheckRollup),
      checkContexts,
    };
  } catch {
    return null;
  }
}

/** Parse the authoritative active rules that GitHub says apply to a branch. */
function parseFleetRequiredCheckRuleItems(
  parsed: readonly unknown[]
): FleetRequiredCheckSet | null {
  try {
    const checks = new Map<
      string,
      { context: string; integrationId: number | null }
    >();
    for (const item of parsed) {
      if (!item || typeof item !== "object" || Array.isArray(item)) return null;
      const rule = item as Record<string, unknown>;
      if (rule.type !== "required_status_checks") continue;
      const parameters = rule.parameters;
      if (
        !parameters ||
        typeof parameters !== "object" ||
        Array.isArray(parameters)
      ) {
        return null;
      }
      const required = (parameters as Record<string, unknown>)[
        "required_status_checks"
      ];
      if (
        !Array.isArray(required) ||
        required.length > MAX_GITHUB_CHECK_IDENTITIES
      ) {
        return null;
      }
      for (const entry of required) {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
          return null;
        }
        const context = boundedCheckIdentity(
          (entry as Record<string, unknown>).context
        );
        if (!context) return null;
        const rawIntegrationId = (entry as Record<string, unknown>)[
          "integration_id"
        ];
        const integrationId =
          rawIntegrationId === null || rawIntegrationId === undefined
            ? null
            : Number(rawIntegrationId);
        if (
          integrationId !== null &&
          (!Number.isSafeInteger(integrationId) || integrationId <= 0)
        ) {
          return null;
        }
        checks.set(`${context}\u0000${integrationId ?? ""}`, {
          context,
          integrationId,
        });
        if (checks.size > MAX_GITHUB_CHECK_IDENTITIES) return null;
      }
    }
    return {
      checks: [...checks.values()].sort(
        (left, right) =>
          left.context.localeCompare(right.context) ||
          (left.integrationId ?? 0) - (right.integrationId ?? 0)
      ),
    };
  } catch {
    return null;
  }
}

export function parseFleetRequiredCheckRules(
  value: string
): FleetRequiredCheckSet | null {
  try {
    if (
      Buffer.byteLength(value, "utf8") > FLEET_REQUIRED_RULES_MAX_TOTAL_BYTES
    ) {
      return null;
    }
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return null;
    return parseFleetRequiredCheckRuleItems(parsed);
  } catch {
    return null;
  }
}

/**
 * Parse a complete, explicitly paged rules response. The final page must be
 * short; a full final page means the caller stopped at its page cap and cannot
 * prove it saw every active rule. Per-page and aggregate byte/item caps keep a
 * hostile or unexpectedly large API response bounded and fail closed.
 */
export function parseFleetRequiredCheckRulePages(
  pages: readonly string[]
): FleetRequiredCheckSet | null {
  if (pages.length === 0 || pages.length > FLEET_REQUIRED_RULES_MAX_PAGES) {
    return null;
  }
  let totalBytes = 0;
  const items: unknown[] = [];
  let lastPageLength = 0;
  try {
    for (let index = 0; index < pages.length; index++) {
      const source = pages[index];
      const pageBytes = Buffer.byteLength(source, "utf8");
      totalBytes += pageBytes;
      if (
        pageBytes > FLEET_REQUIRED_RULES_MAX_PAGE_BYTES ||
        totalBytes > FLEET_REQUIRED_RULES_MAX_TOTAL_BYTES
      ) {
        return null;
      }
      const page = JSON.parse(source) as unknown;
      if (
        !Array.isArray(page) ||
        page.length > FLEET_REQUIRED_RULES_PAGE_SIZE ||
        (index < pages.length - 1 &&
          page.length !== FLEET_REQUIRED_RULES_PAGE_SIZE)
      ) {
        return null;
      }
      lastPageLength = page.length;
      items.push(...page);
    }
    if (
      pages.length === FLEET_REQUIRED_RULES_MAX_PAGES &&
      items.length ===
        FLEET_REQUIRED_RULES_MAX_PAGES * FLEET_REQUIRED_RULES_PAGE_SIZE
    ) {
      return null;
    }
    if (lastPageLength === FLEET_REQUIRED_RULES_PAGE_SIZE) {
      return null;
    }
    return parseFleetRequiredCheckRuleItems(items);
  } catch {
    return null;
  }
}

export function buildFleetRequiredCheckRulesArgs(
  repoSlug: string,
  baseBranch: string,
  page = 1
): string[] {
  return [
    "api",
    "--method",
    "GET",
    `repos/${repoSlug}/rules/branches/${encodeURIComponent(baseBranch)}`,
    "-f",
    `per_page=${FLEET_REQUIRED_RULES_PAGE_SIZE}`,
    "-f",
    `page=${page}`,
  ];
}

export function buildFleetPrViewArgs(
  selector: string | number,
  repoSlug: string
): string[] {
  return [
    "pr",
    "view",
    String(selector),
    "--repo",
    repoSlug,
    "--json",
    "number,url,state,baseRefName,baseRefOid,headRefOid,mergeCommit,mergeable,statusCheckRollup",
  ];
}

export function buildFleetPrCreateArgs(input: {
  repoSlug: string;
  branch: string;
  baseBranch: string;
  title: string;
  body: string;
}): string[] {
  return [
    "pr",
    "create",
    "--repo",
    input.repoSlug,
    "--head",
    input.branch,
    "--base",
    input.baseBranch,
    "--title",
    input.title,
    "--body",
    input.body,
  ];
}
