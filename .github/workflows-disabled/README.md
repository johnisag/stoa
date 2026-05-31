# Disabled workflows

GitHub only runs workflows under `.github/workflows/`. Anything in this folder
is **inert** — parked here until it's ready to turn on.

## What's here

- **`claude-code-review.yml`** — automated Claude review on every (non-draft) PR:
  inline comments + a summary.
- **`claude.yml`** — responds to `@claude` mentions in issues, PRs, and reviews.

## How to activate

1. Add a repo secret **`CLAUDE_CODE_OAUTH_TOKEN`** (generate with
   `claude setup-token`, then add via
   `gh secret set CLAUDE_CODE_OAUTH_TOKEN` or
   Settings → Secrets and variables → Actions).
2. Move the workflow(s) into `.github/workflows/`:
   ```bash
   git mv .github/workflows-disabled/claude-code-review.yml .github/workflows/
   git mv .github/workflows-disabled/claude.yml .github/workflows/
   ```
3. Commit and push. The next PR (or `@claude` mention) triggers them.

Without the secret these workflows fail on every run, which is why they ship
disabled.
