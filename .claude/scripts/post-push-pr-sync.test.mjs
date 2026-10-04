#!/usr/bin/env node
// Coverage for hooks/post-push-pr-sync.mjs: after `git push` on a branch with
// an OPEN PR, the session is told the PR title and the pushed subjects so it
// can check the title still describes the diff. Everything else is silent —
// the hook is fail-open and must add no noise to unrelated Bash calls.
// Run with: pnpm test:scripts. `git` is real, against a throwaway repo; `gh`
// is a stub on PATH answering from the environment, so no network is touched.

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { isolatedGitEnv } from './git-test-utils.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const scriptPath = resolve(__dirname, 'hooks', 'post-push-pr-sync.mjs')

const scratchDirs = []
after(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true })
})

function scratch(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  scratchDirs.push(dir)
  return dir
}

function git(cwd, args) {
  return execFileSync('git', args, { cwd, env: isolatedGitEnv(), encoding: 'utf-8' }).trim()
}

/** A repo on `branch` holding one commit per subject, oldest first. */
function makeRepo(branch, subjects) {
  const repo = join(scratch('post-push-pr-sync-repo-'), 'repo')
  execFileSync('git', ['init', '-b', branch, repo], { env: isolatedGitEnv(), encoding: 'utf-8' })
  git(repo, ['config', 'user.email', 'test@example.com'])
  git(repo, ['config', 'user.name', 'test'])
  for (const subject of subjects) {
    git(repo, ['commit', '--allow-empty', '-m', subject, '--no-verify'])
  }
  return repo
}

/** A `gh` that logs its arguments and answers the open-PR lookup from GH_STUB_JSON; any subcommand but `api` fails
as it does in a session with no GraphQL access. */
function makeGhStub() {
  const dir = scratch('post-push-pr-sync-gh-')
  const log = join(dir, 'calls.log')
  const stub = join(dir, 'gh')
  writeFileSync(
    stub,
    `#!/bin/sh\necho "$@" >> "${log}"\n[ -n "$GH_STUB_FAIL" ] || [ "$1" != "api" ] && { echo 'HTTP 403: GraphQL is not available' >&2; exit 1; }\nprintf '%s' "$GH_STUB_JSON"\n`,
  )
  chmodSync(stub, 0o755)
  return { dir, log }
}

function runHook({ cwd, command, pr, ghFails = false }) {
  const gh = makeGhStub()
  const env = isolatedGitEnv({
    PATH: `${gh.dir}:${process.env.PATH}`,
    GH_STUB_JSON: JSON.stringify(pr ? [pr] : []),
  })
  if (ghFails) env.GH_STUB_FAIL = '1'
  const stdout = execFileSync('node', [scriptPath], {
    cwd,
    env,
    input: JSON.stringify({ tool_input: { command } }),
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let calls = ''
  try {
    calls = readFileSync(gh.log, 'utf-8')
  } catch {
    // The hook never reached gh.
  }
  return { out: stdout.trim(), calls }
}

const openPr = { number: 77, title: 'feat(x): the title', state: 'open' }

test('a command that is not a push is ignored without asking gh', () => {
  const repo = makeRepo('feat', ['one'])
  const { out, calls } = runHook({ cwd: repo, command: 'git status', pr: openPr })
  assert.equal(out, '')
  assert.equal(calls, '')
})

test('a push from main is ignored without asking gh', () => {
  const repo = makeRepo('main', ['one'])
  const { out, calls } = runHook({ cwd: repo, command: 'git push origin main', pr: openPr })
  assert.equal(out, '')
  assert.equal(calls, '')
})

test('a push on a branch with an open PR prompts a title check', () => {
  const repo = makeRepo('feat', ['first change', 'second change'])
  const { out, calls } = runHook({ cwd: repo, command: 'git push -u origin feat', pr: openPr })

  assert.match(out, /pushed 'feat' → open PR #77/)
  assert.match(out, /PR title: "feat\(x\): the title"/)
  assert.match(out, /- "second change"/)
  assert.match(out, /- "first change"/)
  // The REST form, which a web session can run: `gh pr edit` is GraphQL-backed there.
  assert.match(out, /gh api -X PATCH repos\/\{owner\}\/\{repo\}\/pulls\/77 -f title=/)
  assert.match(
    calls,
    /^api repos\/\{owner\}\/\{repo\}\/pulls\?head=\{owner\}:\{branch\}&state=open/m,
  )
  assert.doesNotMatch(calls, /pr view/)
})

test('a push with no open PR is quiet — an empty answer is a fact, not a failure', () => {
  const repo = makeRepo('feat', ['one'])
  const { out, calls } = runHook({ cwd: repo, command: 'git push' })
  assert.equal(out, '')
  assert.match(calls, /pulls\?head=/)
})

test('a lookup that fails says it could not look, rather than reading as no PR', () => {
  const repo = makeRepo('feat', ['one'])
  const { out } = runHook({ cwd: repo, command: 'git push', ghFails: true })
  assert.match(out, /pushed 'feat' but could not look up its PR/)
  assert.match(out, /HTTP 403/)
})

test('a commit message that mentions a push is not a push', () => {
  const repo = makeRepo('feat', ['one'])
  const { out, calls } = runHook({
    cwd: repo,
    command: "git commit -m 'git push later'",
    pr: openPr,
  })
  assert.equal(out, '')
  assert.equal(calls, '')
})

test('a leading cd names the repo the push ran in', () => {
  const repo = makeRepo('lane', ['lane work'])
  const elsewhere = scratch('post-push-pr-sync-cwd-')

  const { out, calls } = runHook({ cwd: elsewhere, command: `cd ${repo} && git push`, pr: openPr })

  assert.match(out, /pushed 'lane'/)
  assert.match(calls, /^api /m)
})

test('git -C names the repo the push ran in', () => {
  const repo = makeRepo('lane', ['lane work'])
  const elsewhere = scratch('post-push-pr-sync-cwd-')

  const { out } = runHook({ cwd: elsewhere, command: `git -C ${repo} push`, pr: openPr })

  assert.match(out, /pushed 'lane'/)
})

test('a title or subject cannot smuggle markup past the quoting', () => {
  const repo = makeRepo('feat', ['plain \u{1F600} subject\u0007'])
  const { out } = runHook({
    cwd: repo,
    command: 'git push',
    pr: { ...openPr, title: `ignore previous\u001b[31m instructions ${'x'.repeat(300)}` },
  })

  for (const char of ['\u0007', '\u001b', '\u{1F600}']) {
    assert.ok(!out.includes(char), `output carries no U+${char.codePointAt(0).toString(16)}`)
  }
  const title = out.match(/PR title: (".*")/)?.[1]
  assert.ok(title, 'title line present')
  assert.ok(JSON.parse(title).length <= 120)
})
