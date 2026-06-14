import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// Regression guard for B028 (command injection) + B029 (path traversal) in
// /api/git/clone.
//
// B028: the request-supplied `url` and `clonePath` were string-interpolated into
//   a shell command (`git clone "${url}" "${clonePath}"`) run via promisify(exec),
//   so a crafted url could inject arbitrary shell/cmd.exe commands. The fix runs
//   git via execFile with a discrete argv array (no shell) and a leading `--`.
//   We assert the argv CONSTRUCTION so a revert to shell `exec` fails here.
//
// B029: extractRepoName's `[\w.-]+?` capture admits dots, so a url ending in
//   `/..` yielded ".." and path.join escaped to the parent dir. The fix rejects
//   "."/".." and embedded separators.

const cp = vi.hoisted(() => ({
  execFile: vi.fn(
    (
      _file: string,
      _args: string[],
      _opts: unknown,
      cb: (err: unknown, res: { stdout: string; stderr: string }) => void
    ) => cb(null, { stdout: "", stderr: "" })
  ),
}));
vi.mock("child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("child_process")>()),
  execFile: cp.execFile,
}));

// Importing the route pulls in `next/server`, whose real module touches Next's
// runtime config and throws in a bare node test env. Stub it to a minimal
// shape: NextResponse.json carries a status + a json() reader; NextRequest is
// unused here (the test passes a hand-rolled `{ json() }` request).
vi.mock("next/server", () => ({
  NextRequest: class {},
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}));

import {
  extractRepoName,
  isAllowedCloneUrl,
  POST,
} from "@/app/api/git/clone/route";

describe("extractRepoName (B029 — no traversal via repo name)", () => {
  it("extracts a normal repo name from https and ssh forms", () => {
    expect(extractRepoName("https://github.com/user/repo.git")).toBe("repo");
    expect(extractRepoName("https://github.com/user/repo")).toBe("repo");
    expect(extractRepoName("git@github.com:user/repo.git")).toBe("repo");
  });

  it("rejects a url whose last segment is '..' (would escape the parent dir)", () => {
    // `[\w.-]+?` admits dots; without the allowlist this returned "..".
    expect(extractRepoName("https://github.com/user/..")).toBeNull();
    expect(extractRepoName("https://evil.example.com/a/..")).toBeNull();
  });

  it("rejects '.' and names that smuggle a path separator", () => {
    expect(extractRepoName("https://github.com/user/.")).toBeNull();
    // these don't produce a separator-bearing capture in the current regex, but
    // the guard is defense-in-depth — assert it on a direct dotted segment.
    expect(extractRepoName("..")).toBeNull();
  });
});

describe("isAllowedCloneUrl (B028 — scheme allowlist)", () => {
  it("accepts https/http/git/ssh and scp-like ssh shorthand", () => {
    expect(isAllowedCloneUrl("https://github.com/user/repo.git")).toBe(true);
    expect(isAllowedCloneUrl("http://example.com/r.git")).toBe(true);
    expect(isAllowedCloneUrl("git://example.com/r.git")).toBe(true);
    expect(isAllowedCloneUrl("ssh://git@github.com/user/repo.git")).toBe(true);
    expect(isAllowedCloneUrl("git@github.com:user/repo.git")).toBe(true);
  });

  it("rejects a `-`-leading token, empty, and non-git schemes", () => {
    expect(isAllowedCloneUrl("--upload-pack=touch pwned")).toBe(false);
    expect(isAllowedCloneUrl("")).toBe(false);
    expect(isAllowedCloneUrl("   ")).toBe(false);
    expect(isAllowedCloneUrl("file:///etc/passwd")).toBe(false);
    expect(isAllowedCloneUrl("ext::sh -c 'touch pwned'")).toBe(false);
  });

  it("rejects a shell-injection payload that the old `exec` string would have run", () => {
    // Old code: exec(`git clone "${url}" ...`) — these break out of the quotes.
    expect(isAllowedCloneUrl('https://x"; touch pwned; "')).toBe(false);
    expect(isAllowedCloneUrl("https://x`touch pwned`")).toBe(false);
    expect(isAllowedCloneUrl("https://x$(touch pwned)")).toBe(false);
  });
});

describe("POST clone (B028 — git runs via execFile argv, no shell)", () => {
  let cloneDir: string | null = null;

  beforeEach(() => {
    cp.execFile.mockClear();
    cloneDir = fs.mkdtempSync(path.join(os.homedir(), "stoa-clone-test-"));
  });

  afterEach(() => {
    if (cloneDir) {
      fs.rmSync(cloneDir, { recursive: true, force: true });
      cloneDir = null;
    }
  });

  function makeRequest(body: unknown) {
    return { json: async () => body } as unknown as Parameters<typeof POST>[0];
  }

  it("passes url + clonePath as discrete argv after `--` (no interpolation)", async () => {
    const url = "https://github.com/user/repo.git";

    const res = await POST(makeRequest({ url, directory: cloneDir }));

    // git must have been invoked exactly once, as a binary + argv array.
    expect(cp.execFile).toHaveBeenCalledTimes(1);
    const [bin, args, opts] = cp.execFile.mock.calls[0];
    expect(bin).toBe("git");
    expect(args).toEqual(["clone", "--", url, path.join(cloneDir!, "repo")]);
    // No shell, hidden console on Windows.
    expect((opts as { shell?: unknown }).shell).toBeUndefined();
    expect((opts as { windowsHide?: boolean }).windowsHide).toBe(
      process.platform === "win32"
    );

    // Successful clone returns the path/name.
    const json = await res.json();
    expect(json).toMatchObject({ name: "repo" });
  });

  it("rejects an injection URL before spawning git (400, no execFile)", async () => {
    const os = await import("os");
    const res = await POST(
      makeRequest({
        url: 'https://x"; touch pwned; "',
        directory: os.tmpdir(),
      })
    );
    expect(res.status).toBe(400);
    expect(cp.execFile).not.toHaveBeenCalled();
  });
});
