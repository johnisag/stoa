import { createHash } from "crypto";
import { join } from "path";
import { homeDir } from "@/lib/platform";

export interface FleetPrStatus {
  number: number;
  url: string;
  state: string | null;
  headSha: string | null;
  mergeSha: string | null;
  mergeable: string | null;
  checks: "none" | "passing" | "pending" | "failing";
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
    worktree: join(homeDir(), ".stoa", "fleet", "integrations", digest),
  };
}

export function summarizeGitHubChecks(value: unknown): FleetPrStatus["checks"] {
  if (!Array.isArray(value) || value.length === 0) return "none";
  let pending = false;
  for (const item of value) {
    const row =
      item && typeof item === "object" ? (item as Record<string, unknown>) : {};
    const conclusion = String(row.conclusion ?? "").toUpperCase();
    const state = String(row.state ?? row.status ?? "").toUpperCase();
    if (
      [
        "FAILURE",
        "ERROR",
        "CANCELLED",
        "TIMED_OUT",
        "ACTION_REQUIRED",
      ].includes(conclusion || state)
    ) {
      return "failing";
    }
    if (
      !["SUCCESS", "NEUTRAL", "SKIPPED"].includes(conclusion) &&
      !["SUCCESS", "COMPLETED"].includes(state)
    ) {
      pending = true;
    }
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
    return {
      number,
      url: parsedUrl.toString(),
      state: typeof parsed.state === "string" ? parsed.state : null,
      headSha: typeof parsed.headRefOid === "string" ? parsed.headRefOid : null,
      mergeSha: typeof mergeCommit === "string" ? mergeCommit : null,
      mergeable: typeof parsed.mergeable === "string" ? parsed.mergeable : null,
      checks: summarizeGitHubChecks(parsed.statusCheckRollup),
    };
  } catch {
    return null;
  }
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
    "number,url,state,headRefOid,mergeCommit,mergeable,statusCheckRollup",
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
