// PreToolUse(Bash) hook: before `gh pr merge`, put the PR's inline review
// comments in front of the session ONCE, and block that first attempt.
//
// Why a block and not a warning: the failure this exists for is a merge
// decided before the comments were read, and it happened twice in one session
// (#1743 and #1745, each merged past unread inline findings). Both times the
// count and the `gh pr merge` were in the SAME shell call, so the number
// printed after the merge had already been sent. A warning printed alongside
// the merge would reproduce exactly that.
//
// The block is per (PR, head SHA), recorded under the git common dir, so the
// second attempt goes through and a new commit re-arms it. Nothing here asks
// for a thread to be resolved — see pre-merge-comments-lib.mjs for why that
// was the wrong gate.
//
// Fail-open: any error at all exits 0. A hook that cannot read GitHub must
// not be able to stop a merge.
import { execFileSync } from 'node:child_process'
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { gateMerge, prNumberFrom } from '../pre-merge-comments-lib.mjs'

let input
try {
  input = JSON.parse(readFileSync(0, 'utf8'))
} catch {
  process.exit(0)
}

const command = input?.tool_input?.command ?? ''
if (!/\bgh\s+pr\s+merge\b/.test(command)) process.exit(0)

const cdMatch = command.match(/(?:^|&&|;)\s*cd\s+([^\s'";&|]+)/)
const where = cdMatch ? cdMatch[1] : process.cwd()
const run = (file, args) => execFileSync(file, args, { encoding: 'utf8', cwd: where }).trim()

try {
  const pr = prNumberFrom(command) ?? Number(run('gh', ['pr', 'view', '--json', 'number', '--jq', '.number']))
  if (!Number.isFinite(pr) || pr <= 0) process.exit(0)

  const head = run('gh', ['pr', 'view', String(pr), '--json', 'headRefOid', '--jq', '.headRefOid'])
  const repo = run('gh', ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'])

  const fetch = (endpoint, jq) =>
    JSON.parse(run('gh', ['api', `repos/${repo}/${endpoint}/${pr}/comments`, '--paginate', '--jq', `[${jq}]`]) || '[]')
  const review = fetch('pulls', '.[]|{author:.user.login,path:.path,line:(.line//.original_line),body:.body}')
  const issue = fetch('issues', '.[]|{author:.user.login,body:.body}')

  const markerDir = join(resolve(where, run('git', ['rev-parse', '--git-common-dir'])), 'pr-merge-comments-shown')
  const marker = join(markerDir, `${pr}-${head}`)

  const { block, message } = gateMerge({ pr, review, issue, alreadySeen: existsSync(marker) })
  if (message) console.error(message)
  if (block) {
    mkdirSync(markerDir, { recursive: true })
    writeFileSync(marker, new Date().toISOString())
    process.exit(2)
  }
} catch {
  process.exit(0)
}
process.exit(0)
