import { NextRequest, NextResponse } from "next/server";
import { readFileSync, existsSync } from "fs";
import { join, isAbsolute, normalize, sep } from "path";

/**
 * GET /api/visual-diff/image?path=<absolute-path>
 *
 * Dev-only image server. Serves PNG files from test/visual/baselines/ and
 * test-results/ so the /visual-diff viewer can display them.
 *
 * Returns 404 in production or for paths outside allowed directories.
 */
export async function GET(req: NextRequest) {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const rawPath = req.nextUrl.searchParams.get("path");
  if (!rawPath) {
    return NextResponse.json({ error: "Missing path" }, { status: 400 });
  }

  const cwd = process.cwd();
  const resolved = isAbsolute(rawPath) ? normalize(rawPath) : normalize(join(cwd, rawPath));

  // Sandbox: only allow reads from the two expected directories.
  const allowedPrefixes = [
    normalize(join(cwd, "test", "visual", "baselines")),
    normalize(join(cwd, "test-results")),
  ];
  const isAllowed = allowedPrefixes.some((prefix) =>
    resolved.startsWith(prefix + sep) || resolved === prefix
  );

  if (!isAllowed) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  if (!existsSync(resolved)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  try {
    const buf = readFileSync(resolved);
    return new NextResponse(buf, {
      headers: { "Content-Type": "image/png" },
    });
  } catch {
    return NextResponse.json({ error: "Read error" }, { status: 500 });
  }
}
