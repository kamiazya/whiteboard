const CONVENTIONAL_PR_TITLE_RE =
  /^(feat|fix|chore|docs|refactor|test|perf|build|ci|revert)(\([^)]+\))?!?: .+\S$/

export function isValidPullRequestTitle(title: string): boolean {
  return CONVENTIONAL_PR_TITLE_RE.test(title.trim())
}

export function explainPullRequestTitleRule(): string {
  return 'PR titles must be Conventional Commits, e.g. "fix: ...", "feat(scope): ...", or "chore(main): release mcp-server v0.0.3".'
}
