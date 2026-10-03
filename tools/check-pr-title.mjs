#!/usr/bin/env node
// Dependency-free: pr-title.yml runs this with no install step. The functions
// are exported so the test exercises the very file CI executes.
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const CONVENTIONAL_PR_TITLE_RE =
  /^(feat|fix|chore|docs|refactor|test|perf|build|ci|revert)(\([^)]+\))?!?: .+\S$/

export function isValidPullRequestTitle(title) {
  return CONVENTIONAL_PR_TITLE_RE.test(title.trim())
}

export function explainPullRequestTitleRule() {
  return 'PR titles must be Conventional Commits, e.g. "fix: ...", "feat(scope): ...", or "chore: release main".'
}

function main(argv) {
  const title = (argv[0] === '--' ? argv.slice(1) : argv).join(' ').trim()

  if (!title) {
    console.error('Missing PR title.')
    console.error(explainPullRequestTitleRule())
    process.exit(1)
  }

  if (!isValidPullRequestTitle(title)) {
    console.error(`Invalid PR title: ${title}`)
    console.error(explainPullRequestTitleRule())
    process.exit(1)
  }

  console.log(`PR title OK: ${title}`)
}

// Importing this file must not run the check.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2))
}
