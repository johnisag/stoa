import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";

// Regression guard for the Windows "flashing conhost.exe" bug class. In
// detached/production mode every child_process console spawn that omits
// `windowsHide` pops a visible console window. #163 fixed the then-known sites,
// but the post-revert restore (and pre-existing untested flows) reintroduced
// uncovered spawns — found only when a user resized to mobile and saw 4-6
// windows flash. This locks it: per source file, the count of
// execFile*/execSync call sites must not exceed the count of `windowsHide`
// occurrences. A new spawn that forgets the flag fails the gate.
//
// Heuristic (count-based, not AST) but robust in practice because we add the
// flag at every individual call site. execFileSync/execFileAsync/execFile/
// execSync are unambiguous child_process names (never abstraction methods);
// `spawn` is intentionally excluded (it doubles as in-process abstraction
// methods like PtyTransport.spawn / pty.spawn) and its few real sites are
// covered by the unit assertions in windows-hide.test.ts.

const ROOTS = ["lib", "app", "scripts", "mcp", "server.ts"];
// Immediate `(` — a real call is `execFileSync(`, never `execFileSync (` with a
// space, so this skips prose comments like "via execFile (no shell)".
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

describe("windowsHide coverage guard", () => {
  it("every execFile*/execSync site passes windowsHide (no console-flash regressions)", () => {
    const files: string[] = [];
    for (const r of ROOTS) walk(r, files);

    const violations: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, "utf-8");
      const spawns = (src.match(SPAWN_RE) || []).length;
      if (spawns === 0) continue;
      const hides = (src.match(/windowsHide/g) || []).length;
      if (hides < spawns) {
        violations.push(
          `${f.replace(/\\/g, "/")}: ${spawns} execFile*/execSync site(s) but ${hides} windowsHide`
        );
      }
    }

    expect(
      violations,
      `Console-spawn sites missing windowsHide:\n  ${violations.join("\n  ")}`
    ).toEqual([]);
  });
});
