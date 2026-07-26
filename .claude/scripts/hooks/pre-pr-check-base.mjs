// PreToolUse(Bash) hook: before `gh pr create`, verify the branch being
// published is not behind a freshly fetched origin/main. Catching up BEFORE
// the PR exists avoids the create-then-immediately-BEHIND churn (extra CI
// runs, stale review context). Blocking instead of auto-merging is deliberate:
// catching up may need the pnpm-lock conflict recipe, which requires judgment.
//
// Fail-open: if the target branch cannot be determined, exit 0 silently.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

let input
try {
  input = JSON.parse(readFileSync(0, 'utf8'))
} catch {
  process.exit(0)
}

const command = input?.tool_input?.command ?? ''
if (!/\bgh\s+pr\s+create\b/.test(command)) process.exit(0)

const git = (args, cwd) => execFileSync('git', args, { encoding: 'utf8', ...(cwd ? { cwd } : {}) }).trim()

try {
  // Determine which branch is being published: --head wins; otherwise the
  // current branch of a leading `cd <path> && ...`; otherwise this process cwd.
  const headMatch = command.match(/--head[= ]([^\s'"]+)/)
  const cdMatch = command.match(/(?:^|&&|;)\s*cd\s+([^\s'";&|]+)/)
  let branch
  let where
  if (headMatch) {
    branch = headMatch[1]
  } else {
    where = cdMatch ? cdMatch[1] : process.cwd()
    branch = git(['branch', '--show-current'], where)
  }
  if (!branch || branch === 'main') process.exit(0)

  const commonDir = git(['rev-parse', '--git-common-dir'], where)
  const repoRoot = resolve(where ?? process.cwd(), commonDir, '..')
  git(['-C', repoRoot, 'fetch', 'origin', 'main'])
  const behind = git(['-C', repoRoot, 'rev-list', '--count', `${branch}..origin/main`])
  if (behind !== '0') {
    console.error(
      `[pre-pr-check-base] branch '${branch}' is ${behind} commit(s) behind origin/main. ` +
        `Merge origin/main into it first (use the pnpm-lock recipe in .claude/rules/integrator-flow.md if the lockfile conflicts), then re-run gh pr create.`,
    )
    process.exit(2)
  }
} catch {
  process.exit(0)
}
process.exit(0)
