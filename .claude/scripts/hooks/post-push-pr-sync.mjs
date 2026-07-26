// PostToolUse(Bash) hook: after `git push` on a branch that has an open PR,
// surface the PR's current title plus the just-pushed commit subjects into the
// session context, prompting a check that the title/body still describe the
// diff. Rewriting the body needs judgment, so this hook only detects and
// instructs — the session performs the `gh pr edit`.
//
// The squash-merge title IS the release-please changelog entry, so a stale
// title is a release-notes bug, not cosmetics.
//
// Fail-open: any resolution failure exits 0 silently.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

let input
try {
  input = JSON.parse(readFileSync(0, 'utf8'))
} catch {
  process.exit(0)
}

const command = input?.tool_input?.command ?? ''
if (!/\bgit\s+([^\s]+\s+)*push\b/.test(command)) process.exit(0)

const sh = (cmd, args, cwd) =>
  execFileSync(cmd, args, { encoding: 'utf8', ...(cwd ? { cwd } : {}) }).trim()

try {
  const cdMatch = command.match(/(?:^|&&|;)\s*cd\s+([^\s'";&|]+)/)
  const dashC = command.match(/git\s+-C\s+([^\s'";&|]+)/)
  const where = cdMatch?.[1] ?? dashC?.[1] ?? process.cwd()
  const branch = sh('git', ['branch', '--show-current'], where)
  if (!branch || branch === 'main') process.exit(0)

  const pr = JSON.parse(
    sh('gh', ['pr', 'view', branch, '--json', 'number,title,state'], where),
  )
  if (pr.state !== 'OPEN') process.exit(0)

  const subjects = sh('git', ['log', '--format=%s', '-3', branch], where)
    .split('\n')
    .filter(Boolean)
    .map((s) => `  - ${s}`)
    .join('\n')
  console.log(
    `[post-push-pr-sync] pushed '${branch}' → open PR #${pr.number} "${pr.title}".\n` +
      `Latest commits:\n${subjects}\n` +
      `Check that the PR title (future squash-merge / release-notes line) and body still describe the full diff; update with \`gh pr edit ${pr.number}\` if not.`,
  )
} catch {
  process.exit(0)
}
process.exit(0)
