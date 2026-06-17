import { NextResponse } from "next/server";
import { readdirSync, existsSync } from "fs";
import { join } from "path";

/**
 * GET /api/visual-diff
 *
 * Dev-only endpoint. Returns a list of visual test baselines alongside their
 * corresponding actual and diff images from the last Playwright run, so the
 * /visual-diff page can render a side-by-side comparison.
 *
 * Returns 404 in production.
 */

interface ScreenshotEntry {
  name: string;
  /** Relative URL for the baseline PNG (served via /test/visual/baselines/). */
  baselineUrl: string;
  /** Relative URL for the actual PNG written by Playwright, or null. */
  actualUrl: string | null;
  /** Relative URL for the diff PNG written by Playwright, or null. */
  diffUrl: string | null;
}

export async function GET() {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const baselineDir = join(process.cwd(), "test", "visual", "baselines");
  const resultsDir = join(process.cwd(), "test-results", "visual");

  if (!existsSync(baselineDir)) {
    return NextResponse.json({ screenshots: [] });
  }

  let baselineFiles: string[] = [];
  try {
    baselineFiles = readdirSync(baselineDir).filter((f) => f.endsWith(".png"));
  } catch {
    return NextResponse.json({ screenshots: [] });
  }

  const screenshots: ScreenshotEntry[] = baselineFiles.map((filename) => {
    // Playwright names actual/diff files with a suffix inside test-results/.
    // Pattern: <spec-name>/<screenshot-name>-actual.png and -diff.png.
    const stem = filename.replace(/\.png$/, "");

    // Search test-results/ for matching actual + diff files produced by Playwright.
    let actualUrl: string | null = null;
    let diffUrl: string | null = null;

    if (existsSync(resultsDir)) {
      try {
        const walk = (dir: string): string[] => {
          const entries = readdirSync(dir, { withFileTypes: true });
          return entries.flatMap((e) => {
            const full = join(dir, e.name);
            return e.isDirectory() ? walk(full) : [full];
          });
        };

        const allResults = walk(resultsDir);
        const actualFile = allResults.find(
          (f) => f.includes(stem) && f.endsWith("-actual.png")
        );
        const diffFile = allResults.find(
          (f) => f.includes(stem) && f.endsWith("-diff.png")
        );

        if (actualFile) {
          // Return a path relative to cwd so the client can construct a
          // fetch URL. The /api/visual-diff/image route (below) serves these.
          actualUrl = `/api/visual-diff/image?path=${encodeURIComponent(actualFile)}`;
        }
        if (diffFile) {
          diffUrl = `/api/visual-diff/image?path=${encodeURIComponent(diffFile)}`;
        }
      } catch {
        // Non-fatal: results dir may be empty on first run.
      }
    }

    return {
      name: stem,
      baselineUrl: `/api/visual-diff/image?path=${encodeURIComponent(join(baselineDir, filename))}`,
      actualUrl,
      diffUrl,
    };
  });

  return NextResponse.json({ screenshots });
}
