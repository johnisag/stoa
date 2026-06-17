"use client";

import { useEffect, useState } from "react";
import { redirect } from "next/navigation";

/**
 * /visual-diff — dev-only in-app screenshot diff viewer.
 *
 * Fetches /api/visual-diff to get the list of baseline screenshots alongside
 * any actual/diff images produced by the last `npm run test:visual` run, then
 * renders them side by side so you can review regressions without leaving the
 * app.
 *
 * Only available in development. In production the /api/visual-diff route
 * returns 404, but as an extra safety measure the page also redirects away.
 *
 * How to use:
 *   1. Run `npm run test:visual` — Playwright writes diff images to test-results/.
 *   2. Open http://localhost:3011/visual-diff in your browser.
 *   3. Baseline (expected) is on the left; actual (what the test captured) on
 *      the right; the diff image (pixel delta) is in the centre.
 *   4. If a baseline is missing its actual/diff, the test either passed or has
 *      not been run yet.
 */

interface ScreenshotEntry {
  name: string;
  baselineUrl: string;
  actualUrl: string | null;
  diffUrl: string | null;
}

interface ApiResponse {
  screenshots: ScreenshotEntry[];
}

function ScreenshotCard({ entry }: { entry: ScreenshotEntry }) {
  const hasDiff = entry.actualUrl !== null || entry.diffUrl !== null;

  return (
    <div className="rounded-lg border border-border bg-card p-4 flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-mono text-sm font-semibold text-foreground truncate">
          {entry.name}
        </h2>
        {hasDiff ? (
          <span className="shrink-0 rounded-full px-2 py-0.5 text-xs font-medium bg-destructive/15 text-destructive">
            diff
          </span>
        ) : (
          <span className="shrink-0 rounded-full px-2 py-0.5 text-xs font-medium bg-green-500/15 text-green-500">
            pass
          </span>
        )}
      </div>

      <div
        className={`grid gap-2 ${hasDiff ? "grid-cols-3" : "grid-cols-1"}`}
      >
        <div className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground font-medium">
            Baseline
          </span>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={entry.baselineUrl}
            alt={`${entry.name} baseline`}
            className="rounded border border-border w-full object-contain bg-black/30"
            loading="lazy"
          />
        </div>

        {hasDiff && (
          <>
            <div className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground font-medium">
                Diff
              </span>
              {entry.diffUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={entry.diffUrl}
                  alt={`${entry.name} diff`}
                  className="rounded border border-destructive/50 w-full object-contain bg-black/30"
                  loading="lazy"
                />
              ) : (
                <div className="rounded border border-border w-full aspect-video flex items-center justify-center text-xs text-muted-foreground">
                  no diff image
                </div>
              )}
            </div>

            <div className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground font-medium">
                Actual
              </span>
              {entry.actualUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={entry.actualUrl}
                  alt={`${entry.name} actual`}
                  className="rounded border border-border w-full object-contain bg-black/30"
                  loading="lazy"
                />
              ) : (
                <div className="rounded border border-border w-full aspect-video flex items-center justify-center text-xs text-muted-foreground">
                  no actual image
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export default function VisualDiffPage() {
  // Guard: redirect away in production at runtime. (The route also returns 404
  // in production, but this is an extra layer.)
  if (process.env.NODE_ENV === "production") {
    redirect("/");
  }

  const [entries, setEntries] = useState<ScreenshotEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/visual-diff")
      .then((r) => {
        if (!r.ok) throw new Error(`/api/visual-diff returned ${r.status}`);
        return r.json() as Promise<ApiResponse>;
      })
      .then((data) => setEntries(data.screenshots))
      .catch((e: unknown) =>
        setError(e instanceof Error ? e.message : String(e))
      );
  }, []);

  const passCount = entries?.filter((e) => !e.actualUrl && !e.diffUrl).length ?? 0;
  const failCount = entries?.filter((e) => e.actualUrl || e.diffUrl).length ?? 0;

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-10 border-b border-border bg-background/80 backdrop-blur px-6 py-3 flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <h1 className="text-base font-semibold">Visual Diff Viewer</h1>
          <span className="text-xs text-muted-foreground">dev only</span>
        </div>
        {entries !== null && (
          <div className="flex items-center gap-3 text-sm">
            <span className="text-green-500">{passCount} pass</span>
            <span className="text-destructive">{failCount} diff</span>
          </div>
        )}
        <p className="text-xs text-muted-foreground hidden md:block">
          Run{" "}
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">
            npm run test:visual
          </code>{" "}
          to generate diffs
        </p>
      </header>

      <main className="px-6 py-6">
        {error !== null && (
          <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive mb-6">
            {error}
          </div>
        )}

        {entries === null && error === null && (
          <div className="flex items-center justify-center py-24 text-muted-foreground text-sm">
            Loading&hellip;
          </div>
        )}

        {entries !== null && entries.length === 0 && (
          <div className="flex flex-col items-center justify-center py-24 gap-3 text-center">
            <p className="text-muted-foreground text-sm">
              No baseline screenshots found.
            </p>
            <p className="text-muted-foreground text-xs">
              Run{" "}
              <code className="rounded bg-muted px-1 py-0.5 font-mono">
                npm run test:visual:update
              </code>{" "}
              to generate baselines.
            </p>
          </div>
        )}

        {entries !== null && entries.length > 0 && (
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            {entries.map((entry) => (
              <ScreenshotCard key={entry.name} entry={entry} />
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
