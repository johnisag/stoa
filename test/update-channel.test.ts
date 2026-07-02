import { describe, it, expect } from "vitest";
import { createRequire } from "module";
import { readFileSync } from "fs";

// Roadmap #56 — pin install/update to a verified release tag. The channel
// selection and tag-resolution logic is extracted into PURE helpers on the CLI
// so it's unit-testable with NO real network / git (the fs/git/network boundary
// stays in cmdUpdate). The CLI is CommonJS; load its exports via createRequire.
// STOA_SKIP_ENV_FILE avoids reading a stray .env during the import.
process.env.STOA_SKIP_ENV_FILE = "1";
const require = createRequire(import.meta.url);
const CLI_PATH = "../scripts/stoa.js";

type ChannelResult =
  | { channel: string; source: string; error?: undefined }
  | { error: string; channel?: undefined; source?: undefined };

const {
  UPDATE_CHANNELS,
  DEFAULT_UPDATE_CHANNEL,
  resolveUpdateChannel,
  parseRemoteTags,
  parseReleaseTag,
  compareReleaseTags,
  selectLatestReleaseTag,
  formatRefLabel,
} = require(CLI_PATH) as {
  UPDATE_CHANNELS: string[];
  DEFAULT_UPDATE_CHANNEL: string;
  resolveUpdateChannel: (argv?: string[], envChannel?: string) => ChannelResult;
  parseRemoteTags: (out: string) => string[];
  parseReleaseTag: (tag: string) => {
    tag: string;
    major: number;
    minor: number;
    patch: number;
    prerelease: string | null;
  } | null;
  compareReleaseTags: (
    a: ReturnType<typeof parseReleaseTag>,
    b: ReturnType<typeof parseReleaseTag>
  ) => number;
  selectLatestReleaseTag: (
    tags: string[],
    opts?: { includePrerelease?: boolean }
  ) => string | null;
  formatRefLabel: (parts: {
    branch: string | null;
    tag: string | null;
    sha: string | null;
  }) => string | null;
};

describe("update channel: constants (#56)", () => {
  it("exposes exactly main + release, with main as the guarded default", () => {
    expect(UPDATE_CHANNELS).toEqual(["main", "release"]);
    expect(DEFAULT_UPDATE_CHANNEL).toBe("main");
    // The default MUST be main — release is opt-in (the trust boundary).
    expect(UPDATE_CHANNELS).toContain(DEFAULT_UPDATE_CHANNEL);
  });
});

describe("update channel: resolveUpdateChannel (precedence + validation)", () => {
  it("defaults to main when neither flag nor env is set", () => {
    const r = resolveUpdateChannel([], undefined);
    expect(r).toEqual({ channel: "main", source: "default" });
  });

  it("honors STOA_UPDATE_CHANNEL when no flag is given", () => {
    const r = resolveUpdateChannel([], "release");
    expect(r.channel).toBe("release");
    expect(r.source).toContain("env");
  });

  it("the --channel flag OVERRIDES the env var (flag > env > default)", () => {
    // env says release, but the explicit flag says main → main wins (escape hatch).
    const r = resolveUpdateChannel(["--channel", "main"], "release");
    expect(r.channel).toBe("main");
    expect(r.source).toBe("--channel");
  });

  it("accepts the --channel=release inline form too", () => {
    const r = resolveUpdateChannel(["--channel=release"], undefined);
    expect(r.channel).toBe("release");
    expect(r.source).toBe("--channel");
  });

  it("is case-insensitive and trims surrounding whitespace", () => {
    expect(resolveUpdateChannel(["--channel", "RELEASE"]).channel).toBe(
      "release"
    );
    expect(resolveUpdateChannel([], "  Main  ").channel).toBe("main");
  });

  it("REJECTS an unknown channel rather than silently tracking main (typo guard)", () => {
    const r = resolveUpdateChannel(["--channel", "realese"], undefined);
    expect(r.error).toBeTruthy();
    expect(r.channel).toBeUndefined();
    expect(String(r.error)).toContain("realese");
    // A bad ENV value is rejected the same way.
    expect(resolveUpdateChannel([], "nightly").error).toBeTruthy();
  });

  it("REJECTS an empty --channel value (dangling flag) instead of defaulting", () => {
    const r = resolveUpdateChannel(["--channel"], undefined);
    expect(r.error).toBeTruthy();
  });

  it("ignores unrelated args around the flag", () => {
    const r = resolveUpdateChannel(["--verbose", "--channel", "release", "-x"]);
    expect(r.channel).toBe("release");
  });
});

describe("update channel: parseRemoteTags (git ls-remote --tags output)", () => {
  it("keeps refs/tags/* names and de-dups the peeled ^{} annotated entry", () => {
    // The peeled line names the SAME tag; it must not double-list.
    const out = [
      "deadbeef11\trefs/tags/v1.0.0",
      "cafef00d22\trefs/tags/v1.2.0",
      "cafef00d99\trefs/tags/v1.2.0^{}", // dereferenced annotated tag
      "abc1230000\trefs/heads/main", // non-tag ref: ignored
    ].join("\n");
    expect(parseRemoteTags(out)).toEqual(["v1.0.0", "v1.2.0"]);
  });

  it("handles CRLF, blank lines, and leading/trailing whitespace", () => {
    const out =
      "\r\n  aaaa\trefs/tags/v2.0.0\r\n\r\nbbbb\trefs/tags/v2.1.0\r\n";
    expect(parseRemoteTags(out)).toEqual(["v2.0.0", "v2.1.0"]);
  });

  it("returns [] for empty / junk input (never throws)", () => {
    expect(parseRemoteTags("")).toEqual([]);
    expect(parseRemoteTags(null as unknown as string)).toEqual([]);
    expect(parseRemoteTags("no tabs here just words")).toEqual([]);
  });
});

describe("update channel: parseReleaseTag", () => {
  it("parses vMAJOR.MINOR.PATCH with an optional leading v and prerelease", () => {
    expect(parseReleaseTag("v1.2.3")).toMatchObject({
      major: 1,
      minor: 2,
      patch: 3,
      prerelease: null,
    });
    expect(parseReleaseTag("2.0.0")).toMatchObject({
      major: 2,
      minor: 0,
      patch: 0,
    });
    expect(parseReleaseTag("v1.4.0-rc.1")).toMatchObject({
      major: 1,
      minor: 4,
      patch: 0,
      prerelease: "rc.1",
    });
  });

  it("rejects non-release tags (so a hostile ref can't be selected)", () => {
    expect(parseReleaseTag("nightly")).toBeNull();
    expect(parseReleaseTag("v1.2")).toBeNull(); // not full MAJOR.MINOR.PATCH
    expect(parseReleaseTag("v1.2.0.5")).toBeNull(); // 4th segment — not MAJOR.MINOR.PATCH
    expect(parseReleaseTag("release-1.2.3")).toBeNull();
    expect(parseReleaseTag("v1.2.3; rm -rf /")).toBeNull(); // injection-shaped
    expect(parseReleaseTag("")).toBeNull();
  });

  it("rejects a version component too large to compare precisely (>2^53)", () => {
    // Would overflow to a float where two distinct versions compare equal,
    // making the highest-tag pick order-dependent — dropped instead.
    expect(parseReleaseTag("v99999999999999999999.0.0")).toBeNull();
    // A large-but-safe component still parses.
    expect(parseReleaseTag("v999999999.0.0")).toMatchObject({
      major: 999999999,
    });
  });
});

// The two piped installers (scripts/install.sh, scripts/install.ps1) select the
// release tag with a git-native `git tag --sort=-v:refname` filtered by an
// embedded regex — they CANNOT import this JS at bootstrap time. This test reads
// the ACTUAL regex string out of each installer and locks it to parseReleaseTag's
// "stable release" definition, so the install-time and update-time selectors can
// never drift (a prerelease or a 4-segment tag must be excluded by BOTH). If a
// maintainer loosens an installer's real pattern, this test fails.
describe("installer/updater release-tag parity (#56)", () => {
  const isStableForUpdater = (tag: string) => {
    const p = parseReleaseTag(tag);
    return p !== null && p.prerelease === null;
  };
  const CASES = [
    "v1.10.0",
    "v2.0.0",
    "v2.0.0-rc.1",
    "v1.3.0-beta.1",
    "v1.2.0.5",
    "nightly",
    "v1.2",
  ];

  // Pull the single-quoted anchored `^v…$` pattern out of each installer's real
  // source (bash `grep -E '…'`, PowerShell `-match '…'`) and compile it as JS.
  function installerRegex(relPath: string): RegExp {
    const src = readFileSync(new URL(relPath, import.meta.url), "utf8");
    const m = src.match(/'(\^v[^']+\$)'/);
    if (!m) throw new Error(`no anchored ^v…$ tag regex found in ${relPath}`);
    return new RegExp(m[1]);
  }

  const installers: Array<[string, string]> = [
    ["install.sh", "../scripts/install.sh"],
    ["install.ps1", "../scripts/install.ps1"],
  ];

  for (const [name, rel] of installers) {
    const re = installerRegex(rel);
    for (const tag of CASES) {
      it(`${name} regex and updater agree on ${tag}`, () => {
        expect(re.test(tag)).toBe(isStableForUpdater(tag));
      });
    }
  }
});

describe("update channel: formatRefLabel (stoa status Version line)", () => {
  it("reports the BRANCH even when the branch HEAD also carries a release tag", () => {
    // The bug this locks out: a normal `main` install sitting on a tagged commit
    // (true right after a release is cut) must NOT read as a pinned release.
    expect(
      formatRefLabel({ branch: "main", tag: "v1.4.0", sha: "abc123" })
    ).toBe("main (tracking)");
  });

  it("reports a pinned release only on a DETACHED HEAD at a release tag", () => {
    expect(
      formatRefLabel({ branch: null, tag: "v1.4.0", sha: "abc123" })
    ).toContain("v1.4.0 (release channel — pinned");
  });

  it("labels a detached non-release tag and a bare detached commit", () => {
    expect(
      formatRefLabel({ branch: null, tag: "nightly", sha: "abc123" })
    ).toBe("nightly (detached)");
    expect(formatRefLabel({ branch: null, tag: null, sha: "abc123" })).toBe(
      "abc123 (detached)"
    );
  });

  it("returns null when nothing is resolvable", () => {
    expect(formatRefLabel({ branch: null, tag: null, sha: null })).toBeNull();
  });
});

describe("update channel: compareReleaseTags (semver ordering)", () => {
  const cmp = (a: string, b: string) =>
    compareReleaseTags(parseReleaseTag(a)!, parseReleaseTag(b)!);

  it("orders by major, then minor, then patch", () => {
    expect(cmp("v1.0.0", "v2.0.0")).toBeLessThan(0);
    expect(cmp("v1.3.0", "v1.2.9")).toBeGreaterThan(0);
    expect(cmp("v1.2.10", "v1.2.9")).toBeGreaterThan(0); // numeric, not lexical
    expect(cmp("v1.2.3", "v1.2.3")).toBe(0);
  });

  it("ranks a prerelease BELOW its corresponding final release", () => {
    expect(cmp("v1.4.0-rc.1", "v1.4.0")).toBeLessThan(0);
    expect(cmp("v1.4.0", "v1.4.0-rc.1")).toBeGreaterThan(0);
  });

  it("orders two prereleases by dotted identifiers (numeric-aware)", () => {
    expect(cmp("v1.0.0-rc.1", "v1.0.0-rc.2")).toBeLessThan(0);
    expect(cmp("v1.0.0-rc.9", "v1.0.0-rc.10")).toBeLessThan(0); // numeric
    expect(cmp("v1.0.0-alpha", "v1.0.0-beta")).toBeLessThan(0);
    expect(cmp("v1.0.0-alpha", "v1.0.0-alpha.1")).toBeLessThan(0); // shorter is lower
  });
});

describe("update channel: selectLatestReleaseTag", () => {
  it("picks the highest clean release tag, ignoring non-release refs", () => {
    const tags = [
      "v1.0.0",
      "v1.10.0", // must beat v1.9.0 numerically
      "v1.9.0",
      "main", // ignored
      "nightly-20260101", // ignored
      "v2.0.0-rc.1", // prerelease excluded by default
    ];
    expect(selectLatestReleaseTag(tags)).toBe("v1.10.0");
  });

  it("EXCLUDES prereleases by default (release channel wants stable)", () => {
    expect(selectLatestReleaseTag(["v1.0.0", "v1.1.0-rc.1"])).toBe("v1.0.0");
  });

  it("can include prereleases when explicitly asked", () => {
    expect(
      selectLatestReleaseTag(["v1.0.0", "v1.1.0-rc.1"], {
        includePrerelease: true,
      })
    ).toBe("v1.1.0-rc.1");
  });

  it("returns null when there is no verified release tag (opt-in must fail loud)", () => {
    expect(selectLatestReleaseTag([])).toBeNull();
    expect(selectLatestReleaseTag(["main", "develop", "nightly"])).toBeNull();
    // Only prereleases present, default mode → still null (no stable release yet).
    expect(selectLatestReleaseTag(["v1.0.0-rc.1"])).toBeNull();
  });

  it("composes with parseRemoteTags end-to-end (no network)", () => {
    const lsRemote = [
      "sha1\trefs/tags/v0.9.0",
      "sha2\trefs/tags/v1.0.0",
      "sha3\trefs/tags/v1.0.0^{}",
      "sha4\trefs/heads/main",
    ].join("\n");
    expect(selectLatestReleaseTag(parseRemoteTags(lsRemote))).toBe("v1.0.0");
  });
});
