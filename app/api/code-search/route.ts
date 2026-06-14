import { NextRequest, NextResponse } from "next/server";
import { searchCode, formatSearchResults } from "@/lib/code-search";
import {
  getAllowedPathRoots,
  resolveSandboxedPath,
  parseBoundedInt,
} from "@/lib/api-security";

const MAX_RESULTS = 1000;
const MAX_CONTEXT_LINES = 10;

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = request.nextUrl;
    const query = searchParams.get("query");
    const path = searchParams.get("path");
    const maxResults = parseBoundedInt(
      searchParams.get("maxResults"),
      1,
      MAX_RESULTS,
      100
    );
    const contextLines = parseBoundedInt(
      searchParams.get("contextLines"),
      0,
      MAX_CONTEXT_LINES,
      2
    );

    if (!query) {
      return NextResponse.json(
        { error: "Query parameter is required" },
        { status: 400 }
      );
    }

    if (!path) {
      return NextResponse.json(
        { error: "Path parameter is required" },
        { status: 400 }
      );
    }

    const roots = getAllowedPathRoots();
    const { allowed, resolved } = resolveSandboxedPath(path, roots);
    if (!allowed) {
      return NextResponse.json(
        { error: "Path is outside the allowed workspace" },
        { status: 403 }
      );
    }

    const rawMatches = searchCode(resolved, query, {
      maxResults,
      contextLines,
    });

    const results = formatSearchResults(rawMatches);

    return NextResponse.json({
      results,
      query,
      path: resolved,
      count: results.length,
    });
  } catch (error) {
    console.error("Code search error:", error);
    const message =
      error instanceof Error ? error.message : "Failed to search code";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
