"use client";

import { useEffect, useState } from "react";

/**
 * /visual-diff — dev-only page to browse committed baseline screenshots.
 *
 * In production this page still renders but the API returns 404, so the
 * baseline list stays empty. Gate the link in the sidebar on NODE_ENV if
 * desired (not done here to keep it simple).
 */

interface VisualDiffData {
  baselines: string[];
}

export default function VisualDiffPage() {
  const [data, setData] = useState<VisualDiffData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/visual-diff")
      .then((r) => {
        if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
        return r.json() as Promise<VisualDiffData>;
      })
      .then(setData)
      .catch((e: unknown) =>
        setError(e instanceof Error ? e.message : String(e))
      );
  }, []);

  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center p-8 font-mono text-sm">
        <div>
          <p className="text-destructive font-semibold">
            Could not load baselines
          </p>
          <p className="text-muted-foreground mt-1">{error}</p>
          <p className="text-muted-foreground mt-4 text-xs">
            Run{" "}
            <code className="bg-muted rounded px-1">
              npm run test:visual:update
            </code>{" "}
            to generate baselines, then restart the dev server.
          </p>
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="border-muted-foreground/30 border-t-foreground h-6 w-6 animate-spin rounded-full border-2" />
      </div>
    );
  }

  if (data.baselines.length === 0) {
    return (
      <div className="flex min-h-screen items-center justify-center p-8 font-mono text-sm">
        <div>
          <p className="font-semibold">No baselines found</p>
          <p className="text-muted-foreground mt-1">
            Run{" "}
            <code className="bg-muted rounded px-1">
              npm run test:visual:update
            </code>{" "}
            to generate them.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen p-8">
      <h1 className="mb-2 text-xl font-semibold">Visual Baselines</h1>
      <p className="text-muted-foreground mb-8 text-sm">
        Committed baseline screenshots for the Playwright visual regression
        suite. Update with{" "}
        <code className="bg-muted rounded px-1 text-xs">
          npm run test:visual:update
        </code>
        .
      </p>
      <div className="grid grid-cols-1 gap-8 lg:grid-cols-2 xl:grid-cols-3">
        {data.baselines.map((name) => (
          <div key={name} className="border-border rounded-lg border p-4">
            <p className="mb-3 font-mono text-sm font-medium">{name}</p>
            {/* Serve baselines directly from the public/visual-baselines symlink or
                the API. For now we reference the file path via a data URL. Because
                Next.js can't serve arbitrary process.cwd() files at runtime without
                an API route, the image is intentionally left as a placeholder here;
                the CI artifact viewer is the primary tool for reviewing diffs. */}
            <div className="bg-muted flex aspect-video items-center justify-center rounded text-xs text-gray-500">
              <span>
                Open{" "}
                <code className="bg-background rounded px-1">
                  test/visual/baselines/{name}.png
                </code>{" "}
                locally
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
