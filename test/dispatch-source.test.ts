import { describe, it, expect } from "vitest";
import { parseGitHubSlug } from "../lib/git";

describe("parseGitHubSlug", () => {
  it("parses https remotes", () => {
    expect(parseGitHubSlug("https://github.com/owner/name")).toBe("owner/name");
    expect(parseGitHubSlug("https://github.com/owner/name.git")).toBe(
      "owner/name"
    );
  });

  it("parses scp-like ssh remotes", () => {
    expect(parseGitHubSlug("git@github.com:owner/name.git")).toBe("owner/name");
    expect(parseGitHubSlug("git@github.com:owner/name")).toBe("owner/name");
  });

  it("parses ssh:// url remotes", () => {
    expect(parseGitHubSlug("ssh://git@github.com/owner/name.git")).toBe(
      "owner/name"
    );
  });

  it("trims whitespace and a trailing newline (git stdout) and slash", () => {
    expect(parseGitHubSlug("  https://github.com/owner/name.git\n")).toBe(
      "owner/name"
    );
    expect(parseGitHubSlug("https://github.com/owner/name/")).toBe(
      "owner/name"
    );
  });

  it("handles hyphens, dots and underscores in owner/name", () => {
    expect(parseGitHubSlug("https://github.com/my-org/my.cool_repo.git")).toBe(
      "my-org/my.cool_repo"
    );
  });

  it("returns null for non-GitHub remotes", () => {
    expect(parseGitHubSlug("https://gitlab.com/owner/name.git")).toBeNull();
    expect(parseGitHubSlug("git@bitbucket.org:owner/name.git")).toBeNull();
  });

  it("rejects github.com look-alike hosts", () => {
    expect(parseGitHubSlug("https://evil-github.com/owner/name")).toBeNull();
    expect(
      parseGitHubSlug("https://github.com.evil.com/owner/name")
    ).toBeNull();
    expect(parseGitHubSlug("https://notgithub.com/owner/name")).toBeNull();
  });

  it("returns null for empty or unparseable input", () => {
    expect(parseGitHubSlug("")).toBeNull();
    expect(parseGitHubSlug("   ")).toBeNull();
    expect(parseGitHubSlug("not a url")).toBeNull();
    expect(parseGitHubSlug("https://github.com/owner")).toBeNull();
  });
});
