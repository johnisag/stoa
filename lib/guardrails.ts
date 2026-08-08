/**
 * Behavioral guardrails — real-time rule enforcement inspired by
 * claude-code-tamagotchi (432 stars).
 *
 * Defines a set of rules that are matched against the rendered terminal
 * output of agent sessions. When a rule matches, a violation is recorded
 * and (optionally) an interrupt action is taken.
 *
 * Rules are data-driven (JSON), matching the manifest-based detection
 * pattern from the Herdr borrowing plan. Users can define custom rules
 * per-project at ~/.stoa/guardrails/<project>.json.
 *
 * Built-in dangerous-command patterns cover the most common footguns:
 * - rm -rf on home/root/important paths
 * - git push --force to main/master
 * - Destructive database commands
 * - npm publish without --dry-run
 */

/** Severity of a guardrail violation. */
export type Severity = "warn" | "block";

/** A guardrail rule definition. */
export interface GuardrailRule {
  /** Unique id for this rule. */
  id: string;
  /** Human-readable description shown in the violation alert. */
  description: string;
  /** RegExp source string matched against the last N lines of screen output. */
  pattern: string;
  /** Severity: "warn" logs a warning; "block" also triggers auto-interrupt. */
  severity: Severity;
  /** Number of recent lines to scan (default: 10). */
  scanLines?: number;
}

/** A detected violation. */
export interface GuardrailViolation {
  /** The rule that was violated. */
  ruleId: string;
  /** Human-readable description. */
  description: string;
  /** The severity level. */
  severity: Severity;
  /** The matched text fragment (truncated for display). */
  match: string;
  /** When the violation was detected. */
  detectedAt: number;
  /** The session name where it was detected. */
  sessionName: string;
}

/**
 * The built-in default rules. These cover the most common destructive
 * patterns that AI coding agents might accidentally execute.
 *
 * Patterns are deliberately NARROW: they match only unambiguous
 * destructive commands, not any mention of "rm" or "force" in normal
 * output (which would create excessive false positives).
 */
export const DEFAULT_RULES: GuardrailRule[] = [
  {
    id: "rm-rf-home",
    description: "rm -rf targeting home directory or root",
    // Matches: rm -rf ~, rm -fr ~, rm --recursive --force ~,
    // rm -rf $HOME, rm -rf /, rm -rf /home, rm -rf /Users
    // Handles both short-flag orderings (-rf and -fr) and long-form.
    pattern:
      "rm\\s+(-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*|-[a-zA-Z]*f[a-zA-Z]*r[a-zA-Z]*|--recursive.*--force|--force.*--recursive)\\s+(~|/|\\$HOME|/home|/Users)",
    severity: "block",
    scanLines: 5,
  },
  {
    id: "rm-rrf-dotfiles",
    description: "rm -rf targeting dotfiles or config directories",
    pattern:
      "rm\\s+(-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*|-[a-zA-Z]*f[a-zA-Z]*r[a-zA-Z]*|--recursive.*--force|--force.*--recursive)\\s+~/(\\.ssh|\\.gnupg|\\.config|\\.aws|\\.stoa)",
    severity: "block",
    scanLines: 5,
  },
  {
    id: "force-push-main",
    description: "git push --force to main/master (history rewrite)",
    // Matches: git push --force origin main, git push -f origin master
    pattern: "git\\s+push\\s+(?:--force|-f)\\s+\\S*\\s*(?:main|master)\\b",
    severity: "block",
    scanLines: 3,
  },
  {
    id: "drop-database",
    description: "DROP DATABASE / DROP TABLE (destructive SQL)",
    pattern: "DROP\\s+(DATABASE|TABLE|SCHEMA)\\b",
    severity: "block",
    scanLines: 5,
  },
  {
    id: "npm-publish-production",
    description: "npm publish without --dry-run (unintended package release)",
    // Warn (not block) — the user might legitimately be publishing
    pattern: "npm\\s+publish\\b(?!.*--dry-run)",
    severity: "warn",
    scanLines: 3,
  },
  {
    id: "chmod-777",
    description: "chmod 777 (world-writable — security risk)",
    pattern: "chmod\\s+777\\b",
    severity: "warn",
    scanLines: 3,
  },
  {
    id: "curl-pipe-sh",
    description: "curl/wget piped to shell (arbitrary code execution)",
    pattern: "(curl|wget)\\s+[^|]*\\|\\s*(sudo\\s+)?(ba)?sh",
    severity: "warn",
    scanLines: 3,
  },
  {
    id: "docker-rm-force",
    description: "docker rm -f on running containers",
    pattern: "docker\\s+rm\\s+-f\\b",
    severity: "warn",
    scanLines: 3,
  },
  {
    id: "killall",
    description: "killall/kill -9 on broad process groups",
    pattern: "killall\\b|kill\\s+-9\\s+(?:-1|0|\\$)",
    severity: "warn",
    scanLines: 3,
  },
];

/**
 * Check screen content against guardrail rules and return any violations.
 * Pure function — no side effects, no I/O. The caller decides what to do
 * with violations (log, alert, auto-interrupt).
 *
 * @param content The rendered terminal output (same capture the status
 *   detector uses).
 * @param rules The rules to check against (defaults to DEFAULT_RULES).
 * @param sessionName The session name (for the violation record).
 * @returns Array of violations found, or empty if none.
 */
export function checkGuardrails(
  content: string,
  rules: GuardrailRule[] = DEFAULT_RULES,
  sessionName: string = ""
): GuardrailViolation[] {
  const violations: GuardrailViolation[] = [];
  const lines = content.split("\n");
  const now = Date.now();

  for (const rule of rules) {
    const scanCount = rule.scanLines ?? 10;
    const region = lines.slice(-scanCount).join("\n");

    let regex: RegExp;
    try {
      regex = new RegExp(rule.pattern, "i");
    } catch {
      // Invalid regex in a rule — skip it (don't crash the checker).
      continue;
    }

    const match = region.match(regex);
    if (match) {
      // Truncate the matched text for display safety.
      const matchText = match[0].slice(0, 120);
      violations.push({
        ruleId: rule.id,
        description: rule.description,
        severity: rule.severity,
        match: matchText,
        detectedAt: now,
        sessionName,
      });
    }
  }

  return violations;
}

/**
 * Deduplicate violations: if the same rule matches the same session within
 * a cooldown window, don't re-report it. Returns only NEW violations.
 *
 * @param newViolations The violations just detected.
 * @param recentlyReported A map of `${ruleId}:${sessionName}` → timestamp
 *   of the last report. Will be MUTATED to include the new violations.
 * @param cooldownMs Don't re-report the same rule+session within this window.
 */
export function deduplicateViolations(
  newViolations: GuardrailViolation[],
  recentlyReported: Map<string, number>,
  cooldownMs: number = 30_000
): GuardrailViolation[] {
  const fresh: GuardrailViolation[] = [];

  for (const v of newViolations) {
    const key = `${v.ruleId}:${v.sessionName}`;
    const lastReported = recentlyReported.get(key);
    // Use the violation's detectedAt as the time reference, so callers
    // can pass violations with explicit timestamps (testable). Falls back
    // to Date.now() if detectedAt is 0 or missing.
    const checkTime = v.detectedAt || Date.now();
    if (lastReported && checkTime - lastReported < cooldownMs) {
      // Still in cooldown — skip.
      continue;
    }
    recentlyReported.set(key, checkTime);
    fresh.push(v);
  }

  return fresh;
}
