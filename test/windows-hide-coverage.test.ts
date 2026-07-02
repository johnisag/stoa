import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";

// Regression guard for the Windows "flashing conhost.exe" bug class. In
// detached/production mode every child_process console spawn that omits
// `windowsHide` pops a visible console window. #163 fixed the then-known sites,
// but the post-revert restore (and pre-existing untested flows) reintroduced
// uncovered spawns — found only when a user resized to mobile and saw windows
// flash. This locks it: each execFile*/execSync call site must carry
// `windowsHide` within its own argument list (or, when options are passed by
// name, within that identifier's object literal).
//
// We FIRST blank out comments and string/template interiors (length- and
// newline-preserving), so paren/quote/`execSync` text inside prose or strings
// can't corrupt the paren-balancing or the matching. Then balancing is trivial
// (no quotes survive inside spans). execFileSync/execFileAsync/execFile/execSync
// are unambiguous child_process names. `spawn`/`spawnSync` are out of scope
// (they double as in-process abstraction methods); their few real console
// sites are asserted in windows-hide.test.ts and the pty path uses
// windowsConptyOptions; scripts/stoa.js CLI spawnSync is a known residual.

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

/** Replace comment + string/template interiors with spaces (keeping length,
 * newlines, and the delimiters) so the result is "structure-only" code: no
 * parens/braces/quotes survive inside strings or comments. Offsets/line numbers
 * stay aligned with the original. */
function stripNonCode(src: string): string {
  const a = src.split("");
  const blank = (i: number) => {
    if (a[i] !== "\n") a[i] = " ";
  };
  for (let i = 0; i < a.length;) {
    const c = a[i];
    const d = a[i + 1];
    if (c === "/" && d === "/") {
      while (i < a.length && a[i] !== "\n") blank(i++);
      continue;
    }
    if (c === "/" && d === "*") {
      blank(i++);
      blank(i++);
      while (i < a.length && !(a[i] === "*" && a[i + 1] === "/")) blank(i++);
      if (i < a.length) {
        blank(i++);
        blank(i++);
      }
      continue;
    }
    if (c === "'" || c === '"' || c === "`") {
      i++; // keep the opening delimiter
      while (i < a.length && a[i] !== c) {
        if (a[i] === "\\") blank(i++);
        if (i < a.length && a[i] !== c) blank(i++);
      }
      i++; // keep the closing delimiter
      continue;
    }
    i++;
  }
  return a.join("");
}

/** Balanced (...) or {...} span from the opener index. Safe on stripped code
 * because no quotes/parens survive inside strings or comments. */
function balanced(src: string, openIdx: number): string {
  const open = src[openIdx];
  const close = open === "(" ? ")" : "}";
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    if (src[i] === open) depth++;
    else if (src[i] === close && --depth === 0)
      return src.slice(openIdx, i + 1);
  }
  return src.slice(openIdx);
}

/** True if a `const/let/var id = { … }` or `id: { … }` object literal in `code`
 * sets windowsHide (the lib/pr.ts / lib/git-status.ts options-by-name pattern). */
function optionsIdentifierSetsWindowsHide(code: string, id: string): boolean {
  // Matches `id = {`, `id: {`, and the typed `id: SomeType = {` (the annotation
  // sits between the name and the brace) — all within one statement (no ;{}=
  // crossing).
  const re = new RegExp(`\\b${id}\\b[^=;{}]*[=:]\\s*\\{`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) {
    const brace = code.indexOf("{", m.index);
    if (brace >= 0 && balanced(code, brace).includes("windowsHide"))
      return true;
  }
  return false;
}

describe("windowsHide coverage guard", () => {
  it("every execFile*/execSync call site passes windowsHide (no console-flash regressions)", () => {
    const files: string[] = [];
    for (const r of ROOTS) walk(r, files);
    // Floor: a broken cwd/scope must fail loudly, not silently pass on 0 files.
    expect(files.length).toBeGreaterThan(50);

    const violations: string[] = [];
    let sites = 0;
    for (const f of files) {
      const code = stripNonCode(readFileSync(f, "utf-8"));
      SPAWN_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = SPAWN_RE.exec(code))) {
        sites++;
        const open = m.index + m[0].length - 1;
        const span = balanced(code, open);
        if (span.includes("windowsHide")) continue;
        const idArg = span.match(/,\s*([A-Za-z_$][\w$]*)\s*\)\s*$/);
        if (idArg && optionsIdentifierSetsWindowsHide(code, idArg[1])) continue;
        const line = code.slice(0, m.index).split("\n").length;
        violations.push(
          `${f.replace(/\\/g, "/")}:${line} — ${m[1]}(…) missing windowsHide`
        );
      }
    }
    expect(sites).toBeGreaterThan(20); // dozens exist; 0 means the scan broke
    expect(
      violations,
      `Console-spawn sites missing windowsHide:\n  ${violations.join("\n  ")}`
    ).toEqual([]);
  });

  // No shell-string exec in runtime code (AGENTS.md): execSync runs through a
  // shell, so interpolating any value into its command string is a command-
  // injection vector (this is how user-controlled commitHash/file reached
  // `git show … ${x}` before conversion to execFileSync argv). Lock it — scanned
  // on stripped code so a comment/string mentioning execSync( can't break CI.
  it("no runtime shell execSync (use execFileSync with an argv array)", () => {
    const files: string[] = [];
    for (const r of ["lib", "app", "mcp", "server.ts"]) walk(r, files);
    expect(files.length).toBeGreaterThan(50);
    const offenders = files.filter((f) =>
      /\bexecSync\(/.test(stripNonCode(readFileSync(f, "utf-8")))
    );
    expect(
      offenders.map((f) => f.replace(/\\/g, "/")),
      `Runtime files using shell execSync (convert to execFileSync argv):\n  ${offenders.join("\n  ")}`
    ).toEqual([]);
  });
});
