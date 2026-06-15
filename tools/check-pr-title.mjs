#!/usr/bin/env node

const CONVENTIONAL_PR_TITLE_RE =
  /^(feat|fix|chore|docs|refactor|test|perf|build|ci|revert)(\([^)]+\))?!?: .+\S$/

function isValidPullRequestTitle(title) {
  return CONVENTIONAL_PR_TITLE_RE.test(title.trim())
}

function explainPullRequestTitleRule() {
  return 'PR titles must be Conventional Commits, e.g. "fix: ...", "feat(scope): ...", or "chore(main): release mcp-server v0.0.3".'
}

const argv = process.argv.slice(2)
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
