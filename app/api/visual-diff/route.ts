import { NextResponse } from "next/server";
import * as fs from "fs";
import * as path from "path";

/**
 * GET /api/visual-diff
 *
 * Returns a JSON list of baseline screenshot names available in
 * test/visual/baselines/. Dev-only — returns 404 in production.
 */
export async function GET() {
  if (process.env.NODE_ENV !== "development") {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const baselineDir = path.join(process.cwd(), "test/visual/baselines");

  if (!fs.existsSync(baselineDir)) {
    return NextResponse.json({ baselines: [] });
  }

  const files = fs
    .readdirSync(baselineDir)
    .filter((f) => f.endsWith(".png"))
    .map((f) => f.replace(/\.png$/, ""));

  return NextResponse.json({ baselines: files });
}
