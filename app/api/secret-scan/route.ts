import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import {
  getAllowedPathRoots,
  resolveSandboxedPathOrHome,
} from "@/lib/api-security";
import { classifySecretFiles } from "@/lib/secret-scan";

/**
 * GET /api/secret-scan?path=...
 *
 * Secrets guard for the New Session dialog (#36): ONE shallow readdir of the
 * picked working directory (entry names only — no recursion, no file contents)
 * run through the pure name matchers in lib/secret-scan.
 *
 * Path validation mirrors /api/git/check — the sibling call in this exact
 * dir-pick flow: sandboxed to the registered workspace roots PLUS the home
 * tree (resolveSandboxedPathOrHome, since a new session's directory may not be
 * registered yet), 403 outside. /api/files' `browse` relaxation is deliberately
 * NOT offered here. Advisory only: an unreadable / nonexistent directory is an
 * empty result, not an error — this route never blocks session creation.
 */
export async function GET(request: NextRequest) {
  try {
    const inputPath = request.nextUrl.searchParams.get("path");
    if (!inputPath) {
      return NextResponse.json(
        { error: "Path parameter is required" },
        { status: 400 }
      );
    }

    const roots = getAllowedPathRoots();
    const { allowed, resolved } = resolveSandboxedPathOrHome(inputPath, roots);
    if (!allowed) {
      return NextResponse.json(
        { error: "Path is outside the allowed workspace" },
        { status: 403 }
      );
    }

    let names: string[];
    try {
      names = await fs.readdir(resolved);
    } catch {
      // Nonexistent / unreadable / not a directory → nothing to warn about.
      return NextResponse.json({ findings: [] });
    }

    return NextResponse.json({ findings: classifySecretFiles(names) });
  } catch (error) {
    console.error("Error scanning for secret files:", error);
    return NextResponse.json(
      { error: "Failed to scan directory" },
      { status: 500 }
    );
  }
}
