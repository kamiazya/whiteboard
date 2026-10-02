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
// Everything is read over REST (`gh api`): the GraphQL-backed `gh pr view` and
// `gh repo view` answer HTTP 403 in some sessions, and a hook that swallowed
// that read as "no comments". A call that FAILS is reported as unreadable
// (gateUnreadable) rather than treated as an empty answer; it blocks once per
// PR so an unreachable GitHub cannot stop a merge for good. Only a failure to
// parse the hook's own input, or to find a place to record the block, exits 0
// silently.
import { execFileSync } from 'node:child_process'
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { prNumberFromMerge, runsGh } from '../hook-command-lib.mjs'
import { gateMerge, gateUnreadable } from '../pre-merge-comments-lib.mjs'

let input
try {
  input = JSON.parse(readFileSync(0, 'utf8'))
} catch {
  process.exit(0)
}

const command = input?.tool_input?.command ?? ''
if (!runsGh(command, 'pr merge')) process.exit(0)

const cdMatch = command.match(/(?:^|&&|;)\s*cd\s+([^\s'";&|]+)/)
const where = cdMatch ? cdMatch[1] : process.cwd()
const run = (file, args) => execFileSync(file, args, { encoding: 'utf8', cwd: where, stdio: ['ignore', 'pipe', 'pipe'] }).trim()

/** `gh api` placeholders ({owner}, {repo}, {branch}) resolve from the local remote — no GraphQL. */
const api = (endpoint, ...flags) => run('gh', ['api', endpoint, ...flags])

/** `--jq` prints one object per line (NDJSON), so a paginated answer stays parseable. */
const lines = (endpoint, jq) =>
  api(endpoint, '--paginate', '--jq', jq)
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))

function whyItFailed(err) {
  const text = String(err?.stderr ?? '').trim() || String(err?.message ?? '')
  return text.split('\n')[0].slice(0, 200)
}

let pr = prNumberFromMerge(command)
let markerDir
try {
  markerDir = join(resolve(where, run('git', ['rev-parse', '--git-common-dir'])), 'pr-merge-comments-shown')
} catch {
  process.exit(0)
}

/** @returns {{block: boolean, message: string}} */
function decide() {
  try {
    if (pr === null) {
      const found = Number(api('repos/{owner}/{repo}/pulls?head={owner}:{branch}&state=open', '--jq', '.[0].number'))
      if (!Number.isInteger(found) || found <= 0) throw new Error('no open PR is attached to the current branch')
      pr = found
    }
    const head = api(`repos/{owner}/{repo}/pulls/${pr}`, '--jq', '.head.sha')
    if (!head) throw new Error('the PR answered with no head commit')
    const review = lines(`repos/{owner}/{repo}/pulls/${pr}/comments`, '.[]|{author:.user.login,path:.path,line:(.line//.original_line),body:.body}')
    const issue = lines(`repos/{owner}/{repo}/issues/${pr}/comments`, '.[]|{author:.user.login,body:.body}')
    const marker = join(markerDir, `${pr}-${head}`)
    const verdict = gateMerge({ pr, review, issue, alreadySeen: existsSync(marker) })
    return { ...verdict, marker }
  } catch (err) {
    const marker = join(markerDir, `${pr ?? 'unknown'}-unreadable`)
    return { ...gateUnreadable({ pr, reason: whyItFailed(err), alreadySeen: existsSync(marker) }), marker }
  }
}

const { block, message, marker } = decide()
if (message) console.error(message)
if (block) {
  mkdirSync(markerDir, { recursive: true })
  writeFileSync(marker, new Date().toISOString())
  process.exit(2)
}
process.exit(0)
