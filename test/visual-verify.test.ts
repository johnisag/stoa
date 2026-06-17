/**
 * visual-verify — unit tests for the /api/visual-diff route handler and the
 * playwright.config.ts configuration object.
 *
 * These are plain vitest tests (no real filesystem, no Playwright) so they run
 * in `npm test` on every platform.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { join, normalize } from "path";
import { readFileSync as realReadFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// fs mock — set up before any route import so the mock is in place when the
// route module is first required.
// ---------------------------------------------------------------------------

const mockExistsSync = vi.hoisted(() => vi.fn((_path: string): boolean => false));
const mockReaddirSync = vi.hoisted(() => vi.fn((_path: string, _opts?: unknown): unknown[] => []));

vi.mock("fs", async () => {
  const actual = await vi.importActual<typeof import("fs")>("fs");
  const fake = {
    ...actual,
    existsSync: mockExistsSync,
    readdirSync: mockReaddirSync,
  };
  return { ...fake, default: fake };
});

// Import the route AFTER the mock is in place.
import { GET } from "@/app/api/visual-diff/route";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CWD = process.cwd();
const baselineDir = normalize(join(CWD, "test", "visual", "baselines"));
const resultsDir = normalize(join(CWD, "test-results", "visual"));

// @types/node types process.env.NODE_ENV as readonly; cast via the env object.
const env = process.env as Record<string, string | undefined>;

// ---------------------------------------------------------------------------
// 1. Production guard
// ---------------------------------------------------------------------------

describe("/api/visual-diff — production guard", () => {
  let savedNodeEnv: string | undefined;

  beforeEach(() => {
    savedNodeEnv = env.NODE_ENV;
  });

  afterEach(() => {
    env.NODE_ENV = savedNodeEnv;
  });

  it("returns 404 when NODE_ENV is production", async () => {
    env.NODE_ENV = "production";
    const res = await GET();
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body).toEqual({ error: "Not found" });
  });

  it("does NOT return 404 in development mode", async () => {
    env.NODE_ENV = "development";
    mockExistsSync.mockReturnValue(false);
    const res = await GET();
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// 2. Baseline directory listing
// ---------------------------------------------------------------------------

describe("/api/visual-diff — baseline listing", () => {
  let savedNodeEnv: string | undefined;

  beforeEach(() => {
    savedNodeEnv = env.NODE_ENV;
    env.NODE_ENV = "test";
    vi.clearAllMocks();
  });

  afterEach(() => {
    env.NODE_ENV = savedNodeEnv;
  });

  it("returns empty screenshots when baseline dir does not exist", async () => {
    mockExistsSync.mockReturnValue(false);
    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { screenshots: unknown[] };
    expect(body).toEqual({ screenshots: [] });
  });

  it("lists PNG files from the baseline directory", async () => {
    // baseline dir exists; results dir does not
    mockExistsSync.mockImplementation((p: string) => p === baselineDir);
    mockReaddirSync.mockReturnValue(["app-shell-empty.png", "session-list-populated.png"]);

    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { screenshots: { name: string }[] };

    expect(body.screenshots).toHaveLength(2);
    const names = body.screenshots.map((s) => s.name);
    expect(names).toContain("app-shell-empty");
    expect(names).toContain("session-list-populated");
  });

  it("filters out non-PNG files", async () => {
    mockExistsSync.mockImplementation((p: string) => p === baselineDir);
    mockReaddirSync.mockReturnValue(["app-shell-empty.png", "README.md", ".gitkeep"]);

    const res = await GET();
    const body = (await res.json()) as { screenshots: { name: string }[] };
    expect(body.screenshots).toHaveLength(1);
    expect(body.screenshots[0].name).toBe("app-shell-empty");
  });

  it("sets baselineUrl to /api/visual-diff/image?path=<encoded>", async () => {
    mockExistsSync.mockImplementation((p: string) => p === baselineDir);
    mockReaddirSync.mockReturnValue(["app-shell-empty.png"]);

    const res = await GET();
    const body = (await res.json()) as { screenshots: { baselineUrl: string }[] };
    const entry = body.screenshots[0];

    expect(entry.baselineUrl).toContain("/api/visual-diff/image?path=");
    expect(entry.baselineUrl).toContain(
      encodeURIComponent(join(baselineDir, "app-shell-empty.png"))
    );
  });

  it("sets actualUrl and diffUrl to null when test-results dir has no matches", async () => {
    // baseline dir exists, results dir does not
    mockExistsSync.mockImplementation((p: string) => p === baselineDir);
    mockReaddirSync.mockReturnValue(["workflows-builder.png"]);

    const res = await GET();
    const body = (await res.json()) as {
      screenshots: { actualUrl: string | null; diffUrl: string | null }[];
    };
    const entry = body.screenshots[0];

    expect(entry.actualUrl).toBeNull();
    expect(entry.diffUrl).toBeNull();

    // suppress unused var warning
    void resultsDir;
  });

  it("returns screenshots array (shape check) when results dir exists but walk is empty", async () => {
    // both dirs "exist" but walk returns no files
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync
      .mockReturnValueOnce(["workflows-builder.png"]) // baselines listing
      .mockReturnValue([]); // walk of results (empty)

    const res = await GET();
    const body = (await res.json()) as {
      screenshots: {
        name: string;
        baselineUrl: string;
        actualUrl: string | null;
        diffUrl: string | null;
      }[];
    };

    expect(body.screenshots).toHaveLength(1);
    const entry = body.screenshots[0];
    expect(entry.name).toBe("workflows-builder");
    expect(typeof entry.baselineUrl).toBe("string");
    expect(entry.actualUrl).toBeNull();
    expect(entry.diffUrl).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 3. playwright.config.ts — validate key fields via source text
//
// We read the config as source text rather than importing it so the test does
// not require @playwright/test to be installed in the unit-test environment
// (it is an optional dev dep that is only installed before running real
// Playwright tests, not during the main `npm test` vitest run).
// ---------------------------------------------------------------------------

describe("playwright.config.ts — source validation", () => {
  let src: string;

  beforeEach(() => {
    src = realReadFileSync(join(CWD, "playwright.config.ts"), "utf8");
  });

  it("sets testDir to ./test/visual", () => {
    expect(src).toContain('"./test/visual"');
  });

  it("sets snapshotDir to ./test/visual/baselines", () => {
    expect(src).toContain('"./test/visual/baselines"');
  });

  it("names the project 'visual'", () => {
    expect(src).toContain('name: "visual"');
  });

  it("sets viewport to 1440x900", () => {
    expect(src).toContain("width: 1440");
    expect(src).toContain("height: 900");
  });

  it("sets threshold to 0.1 and maxDiffPixelRatio to 0.01", () => {
    expect(src).toContain("threshold: 0.1");
    expect(src).toContain("maxDiffPixelRatio: 0.01");
  });

  it("points webServer url at localhost:3011", () => {
    expect(src).toContain("http://localhost:3011");
  });
});
