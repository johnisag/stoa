import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";

// Regression guard for the Windows "flashing conhost.exe" bug class. In
// detached/production mode every child_process console spawn that omits
// `windowsHide` pops a visible console window. #163 fixed the then-known sites,
// but the post-revert restore (and pre-existing untested flows) reintroduced
// uncovered spawns — found only when a user resized to mobile and saw 4-6
// windows flash. This locks it: each execFile*/execSync call site must carry
// `windowsHide` *within its own argument list*. A new spawn that forgets the
// flag fails the gate.
//
// Per-call-site (not per-file-count): we extract each call's balanced
// `(...)` span and require `windowsHide` inside it, so a flag on one call can't
// mask its absence on another, and a `windowsHide` mention in a comment/string
// elsewhere in the file doesn't count. execFileSync/execFileAsync/execFile/
// execSync are unambiguous child_process names (never abstraction methods).
// `spawn`/`spawnSync` are intentionally out of scope here (they double as
// in-process abstraction methods — PtyTransport.spawn, pty.spawn); their few
// real console sites are asserted directly in windows-hide.test.ts and the pty
// path uses windowsConptyOptions. scripts/stoa.js CLI spawnSync is a separate,
// known residual tracked outside this guard.

const ROOTS = ["lib", "app", "scripts", "mcp", "server.ts"];
const SPAWN_RE = /\b(execFileSync|execFileAsync|execFile|execSync)\(/g;

function walk(p: string, out: string[]): void {
  let st;
  try {
    st = statSync(p);
  } catch {
    return;
  }
  if (st.isDirectory()) {
    for (const e of readdirSync(p)) {
      if (e === "node_modules" || e === ".next" || e === "dist") continue;
      walk(join(p, e), out);
    }
  } else if (/\.(ts|tsx|js|mjs|cjs)$/.test(p) && !/\.test\./.test(p)) {
    out.push(p);
  }
}

/** Extract a call's `(...args...)` span starting at the index of its `(`,
 * matching parens while skipping string/template literals. */
function callSpan(src: string, openParen: number): string {
  let depth = 0;
  let quote: string | null = null;
  for (let i = openParen; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") quote = c;
    else if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return src.slice(openParen, i + 1);
  }
  return src.slice(openParen); // unbalanced (shouldn't happen) — fail open
}

describe("windowsHide coverage guard", () => {
  it("every execFile*/execSync call site passes windowsHide (no console-flash regressions)", () => {
    const files: string[] = [];
    for (const r of ROOTS) walk(r, files);

    // Floor: if cwd/scope ever breaks so nothing is scanned, fail loudly
    // instead of silently passing on an empty set.
    expect(files.length).toBeGreaterThan(50);

    const violations: string[] = [];
    let sites = 0;
    for (const f of files) {
      const src = readFileSync(f, "utf-8");
      SPAWN_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = SPAWN_RE.exec(src))) {
        sites++;
        const openParen = m.index + m[0].length - 1;
        const span = callSpan(src, openParen);
        if (span.includes("windowsHide")) continue;
        // Helper pattern: options passed by name — `execFileSync(file, args, opts)`
        // where `const opts = { …windowsHide… }` is built nearby (lib/pr.ts,
        // lib/git-status.ts). Resolve a bare-identifier last arg to its object.
        const idArg = span.match(/,\s*([A-Za-z_$][\w$]*)\s*\)\s*$/);
        if (
          idArg &&
          new RegExp(
            `\\b${idArg[1]}\\b[\\s\\S]{0,300}windowsHide|windowsHide[\\s\\S]{0,300}\\b${idArg[1]}\\b`
          ).test(src)
        )
          continue;
        const line = src.slice(0, m.index).split("\n").length;
        violations.push(
          `${f.replace(/\\/g, "/")}:${line} — ${m[1]}(…) missing windowsHide`
        );
      }
    }

    // Floor: we know there are dozens of such sites; 0 means the scan broke.
    expect(sites).toBeGreaterThan(20);
    expect(
      violations,
      `Console-spawn sites missing windowsHide:\n  ${violations.join("\n  ")}`
    ).toEqual([]);
  });

  // No shell-string exec in runtime code (AGENTS.md): execSync runs through a
  // shell, so interpolating any value into its command string is a command-
  // injection vector (this is how user-controlled commitHash/file reached
  // `git show … ${x}` before they were converted to execFileSync argv). Lock it.
  it("no runtime shell execSync (use execFileSync with an argv array)", () => {
    const files: string[] = [];
    for (const r of ["lib", "app", "mcp"]) walk(r, files);
    expect(files.length).toBeGreaterThan(50);
    const offenders = files.filter((f) =>
      /\bexecSync\(/.test(readFileSync(f, "utf-8"))
    );
    expect(
      offenders.map((f) => f.replace(/\\/g, "/")),
      `Runtime files using shell execSync (convert to execFileSync argv):\n  ${offenders.join("\n  ")}`
    ).toEqual([]);
  });
});
