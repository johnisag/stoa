import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  collectReadiness: vi.fn(() => ({ agents: {}, gh: false, authHint: false })),
  generatePRContent: vi.fn(async () => ({
    title: "Generated title",
    description: "Generated body",
  })),
  readReviewerFindings: vi.fn(async () => [
    { lens: "correctness", verdict: "clean", body: "Looks good" },
  ]),
}));

vi.mock("@/lib/api-security", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api-security")>();
  return {
    ...actual,
    getAllowedPathRoots: () => ["/workspace"],
    resolveRealSandboxedPath: async (input: string) => ({
      allowed: input.startsWith("/workspace"),
      resolved: input,
    }),
    resolveRealSandboxedPathOrHome: async (input: string) => ({
      allowed: input.startsWith("/workspace"),
      resolved: input,
    }),
  };
});

vi.mock("@/lib/readiness-server", () => ({
  collectReadiness: mocks.collectReadiness,
}));
vi.mock("@/lib/git-status", () => ({
  expandPath: (value: string) => value,
  isGitRepo: () => true,
}));
vi.mock("@/lib/pr", () => ({
  checkGhCli: () => true,
  getCommitsSinceBase: () => [{ hash: "abc", subject: "Change" }],
  generatePRTitle: () => "Fallback title",
  generatePRBody: () => "Fallback body",
  getPRForBranch: () => null,
  createPR: vi.fn(),
  getCurrentBranch: () => "feature/security",
  getBaseBranch: () => "main",
}));
vi.mock("@/lib/pr-generation", () => ({
  generatePRContent: mocks.generatePRContent,
}));
vi.mock("@/lib/db", () => ({
  getDb: () => ({}),
  queries: {
    getDispatch: () => ({
      get: () => ({ worktree_path: "/workspace/repo" }),
    }),
    getSession: () => ({
      get: () => ({ worktree_path: "/workspace/repo" }),
    }),
  },
}));
vi.mock("@/lib/dispatch/reviewer", () => ({
  readReviewerFindings: mocks.readReviewerFindings,
}));

import { GET as getReadiness } from "@/app/api/readiness/route";
import { GET as scanSecrets } from "@/app/api/secret-scan/route";
import { GET as getPullRequest } from "@/app/api/git/pr/route";
import { GET as getVerdictFindings } from "@/app/api/verdict-inbox/findings/route";

function request(path: string, scope: "admin" | "observer"): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    headers: {
      host: "localhost",
      "x-stoa-scope": scope,
    },
  });
}

async function expectAdminRequired(response: Response): Promise<void> {
  expect(response.status).toBe(403);
  await expect(response.json()).resolves.toEqual({
    error: "admin token required",
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("defense-in-depth GET scope gates", () => {
  it("protects readiness probes from observers", async () => {
    await expectAdminRequired(
      await getReadiness(request("/api/readiness", "observer"))
    );
    expect(mocks.collectReadiness).not.toHaveBeenCalled();

    const response = await getReadiness(request("/api/readiness", "admin"));
    expect(response.status).toBe(200);
    expect(mocks.collectReadiness).toHaveBeenCalledOnce();
  });

  it("protects secret-name scans from observers", async () => {
    await expectAdminRequired(
      await scanSecrets(
        request("/api/secret-scan?path=/workspace/repo", "observer")
      )
    );

    const response = await scanSecrets(request("/api/secret-scan", "admin"));
    expect(response.status).toBe(400);
  });

  it("keeps harmless PR metadata observable but gates AI generation", async () => {
    const metadata = await getPullRequest(
      request("/api/git/pr?path=/workspace/repo", "observer")
    );
    expect(metadata.status).toBe(200);
    expect(mocks.generatePRContent).not.toHaveBeenCalled();

    await expectAdminRequired(
      await getPullRequest(
        request("/api/git/pr?path=/workspace/repo&generate=true", "observer")
      )
    );
    expect(mocks.generatePRContent).not.toHaveBeenCalled();

    const generated = await getPullRequest(
      request("/api/git/pr?path=/workspace/repo&generate=true", "admin")
    );
    expect(generated.status).toBe(200);
    expect(mocks.generatePRContent).toHaveBeenCalledOnce();
  });

  it("protects reviewer prose from observers", async () => {
    await expectAdminRequired(
      await getVerdictFindings(
        request(
          "/api/verdict-inbox/findings?type=dispatch&id=d-1&pr=42",
          "observer"
        )
      )
    );
    expect(mocks.readReviewerFindings).not.toHaveBeenCalled();

    const response = await getVerdictFindings(
      request("/api/verdict-inbox/findings?type=dispatch&id=d-1&pr=42", "admin")
    );
    expect(response.status).toBe(200);
    expect(mocks.readReviewerFindings).toHaveBeenCalledOnce();
  });
});
