// The decision half of hooks/pre-merge-show-comments.mjs, kept separate so a
// test can drive it without a network or a repository.
//
// Measured over the 25 most recently merged PRs in this repo: 9 carried
// inline review comments and 7 of those were still UNRESOLVED when they
// merged. That is the rate this gate fires at — roughly one merge in three,
// once each — and it is why the gate is on INLINE comments rather than on
// every comment. Top-level issue comments are on essentially every PR here
// (a Cloudflare preview link, a CodeRabbit summary, a DeepSource summary), so
// blocking on those would fire every time and be read as noise within a day.
//
// Blocking on "unresolved" was the other candidate and is worse: resolving a
// thread is a heavier act than triaging one, only 3 of those 9 PRs ever had a
// thread resolved, and a gate that demands a new habit gets bypassed. What
// actually went wrong is narrower — a merge decided before the comments had
// been READ — so the gate makes the bodies appear once, and then gets out of
// the way.

/**
 * A comment body as prose. The bots here write HTML — DeepSource opens with a
 * tracking `<!-- -->` and eleven lines of `<picture>`/`<source>` for a
 * severity badge, so a naive 12-line truncation shows the badge and cuts
 * before "Forbidden non-null assertion", which is the entire finding. Measured
 * on PR #1746, whose first comment rendered as twelve lines of markup and no
 * sentence.
 */
export function cleanBody(raw) {
  return (raw ?? '')
    .replace(/\r/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]+>/g, ' ')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
}

/** One comment, from either endpoint, flattened to what a reader needs. */
export function describeComment(comment) {
  const where = comment.path ? ` ${comment.path}:${comment.line ?? '?'}` : ''
  return `  ${comment.author}${where}\n${cleanBody(comment.body)
    .split('\n')
    .slice(0, 12)
    .map((line) => `    ${line}`)
    .join('\n')}`
}

/**
 * @param pr          the PR number, for the message
 * @param review      comments from `pulls/<n>/comments` (inline, on a line)
 * @param issue       comments from `issues/<n>/comments` (top-level)
 * @param alreadySeen true when this exact head has been shown once already
 */
export function gateMerge({ pr, review, issue, alreadySeen }) {
  if (alreadySeen) return { block: false, message: '' }
  if (review.length === 0) {
    if (issue.length === 0) return { block: false, message: '' }
    // Not a block: these are on every PR. Printed so the authors are
    // enumerated from the FEED rather than from a remembered list — scoping a
    // sweep to two named bots is how a CodeQL finding slipped past this gate
    // once (.claude/rules/dev-flow.md).
    const authors = [...new Set(issue.map((comment) => comment.author))].sort()
    return {
      block: false,
      message: `[pre-merge-show-comments] PR #${pr}: no inline review comments. Top-level comment authors: ${authors.join(', ')}.`,
    }
  }
  const lines = [
    `[pre-merge-show-comments] PR #${pr} has ${review.length} inline review comment(s), shown below because a merge was about to be decided without them.`,
    '',
    ...review.map(describeComment),
  ]
  if (issue.length > 0) {
    lines.push('', `Top-level comments (${issue.length}):`, ...issue.map(describeComment))
  }
  lines.push(
    '',
    'Triage each one against the real code, then re-run the same `gh pr merge` command — this head is now recorded as shown and will not be blocked again.',
  )
  return { block: true, message: lines.join('\n') }
}

/** `gh pr merge 1234 ...` -> 1234; a bare `gh pr merge` -> null (use the branch's PR). */
export function prNumberFrom(command) {
  const match = command.match(/\bgh\s+pr\s+merge\s+(\d+)\b/)
  return match ? Number(match[1]) : null
}
