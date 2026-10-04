#!/usr/bin/env node
// Coverage for hooks/pre-merge-show-comments.mjs run as the harness runs it:
// a subprocess fed the hook JSON, against a throwaway repo and a `gh` stub on
// PATH. The stub refuses every subcommand but `gh api` the way a session
// without GraphQL access does, so a hook that reaches for `gh pr view` fails
// here rather than in someone's merge.
// Run with: pnpm test:scripts.

import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const hook = resolve(
  dirname(fileURLToPath(import.meta.url)),
  'hooks',
  'pre-merge-show-comments.mjs',
)

const scratchDirs = []
after(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true })
})

function scratch(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  scratchDirs.push(dir)
  return dir
}

function cleanEnv(extra) {
  const env = { ...process.env, ...extra }
  for (const key of Object.keys(env)) {
    if (
      /^GIT_(DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|COMMON_DIR|NAMESPACE)$/.test(
        key,
      )
    )
      delete env[key]
  }
  return env
}

function makeRepo(branch = 'feat') {
  const repo = join(scratch('pre-merge-show-comments-repo-'), 'repo')
  execFileSync('git', ['init', '-b', branch, repo], { env: cleanEnv({}), encoding: 'utf-8' })
  return repo
}

/**
 * A `gh` that answers only `gh api`, per endpoint, from the environment, and
 * otherwise fails with the message a GraphQL-less session gets.
 */
function makeGhStub() {
  const dir = scratch('pre-merge-show-comments-gh-')
  const log = join(dir, 'calls.log')
  const stub = join(dir, 'gh')
  writeFileSync(
    stub,
    `#!/bin/sh
echo "$@" >> "${log}"
if [ -n "$GH_STUB_FAIL" ] || [ "$1" != "api" ]; then
  echo "HTTP 403: GitHub GraphQL is not available from Claude Code sessions" >&2
  exit 1
fi
case "$2" in
  *"/pulls?head="*) printf '%s' "$GH_STUB_PR_FOR_BRANCH" ;;
  *"/pulls/"*"/comments") printf '%s' "$GH_STUB_REVIEW" ;;
  *"/issues/"*"/comments") printf '%s' "$GH_STUB_ISSUE" ;;
  *"/pulls/"*) printf '%s' "$GH_STUB_HEAD" ;;
esac
`,
  )
  chmodSync(stub, 0o755)
  return { dir, log }
}

function runHook({ repo, command, env = {} }) {
  const gh = makeGhStub()
  const result = spawnSync('node', [hook], {
    cwd: repo,
    env: cleanEnv({
      PATH: `${gh.dir}:${process.env.PATH}`,
      GH_STUB_HEAD: 'abc123',
      GH_STUB_REVIEW: '',
      GH_STUB_ISSUE: '',
      GH_STUB_PR_FOR_BRANCH: '',
      ...env,
    }),
    input: JSON.stringify({ tool_input: { command } }),
    encoding: 'utf-8',
  })
  let calls = ''
  try {
    calls = readFileSync(gh.log, 'utf-8')
  } catch {
    // The hook never reached gh.
  }
  return { status: result.status, stderr: result.stderr, calls }
}

const review = JSON.stringify({
  author: 'coderabbitai[bot]',
  path: 'src/a.ts',
  line: 3,
  body: 'This cast hides a null.',
})

test('an unreadable PR says so and blocks once, instead of exiting silently', () => {
  const repo = makeRepo()
  const first = runHook({ repo, command: 'gh pr merge 2029 --squash', env: { GH_STUB_FAIL: '1' } })
  assert.equal(first.status, 2)
  assert.match(first.stderr, /could not read PR #2029/)
  assert.match(first.stderr, /GraphQL/)

  // A GitHub that stays unreachable must not stop the merge for good.
  const second = runHook({ repo, command: 'gh pr merge 2029 --squash', env: { GH_STUB_FAIL: '1' } })
  assert.equal(second.status, 0)
})

test('a merge with no number resolves the PR over REST, and an unresolvable one is reported', () => {
  const repo = makeRepo('lane')
  const found = runHook({
    repo,
    command: 'gh pr merge --squash',
    env: { GH_STUB_PR_FOR_BRANCH: '88', GH_STUB_REVIEW: review },
  })
  assert.equal(found.status, 2)
  assert.match(found.stderr, /PR #88 has 1 inline review comment/)

  const unresolved = runHook({ repo: makeRepo('other'), command: 'gh pr merge --squash' })
  assert.equal(unresolved.status, 2)
  assert.match(unresolved.stderr, /could not read the PR being merged/)
})

test('inline comments read over REST block the first merge only', () => {
  const repo = makeRepo()
  const env = { GH_STUB_REVIEW: `${review}\n${review}` }
  const first = runHook({ repo, command: 'gh pr merge 5', env })
  assert.equal(first.status, 2)
  assert.match(first.stderr, /2 inline review comment/)
  assert.match(first.stderr, /This cast hides a null\./)
  assert.doesNotMatch(first.calls, /pr view|repo view/)

  assert.equal(runHook({ repo, command: 'gh pr merge 5', env }).status, 0)
})

test('a PR with no comments passes silently', () => {
  const result = runHook({ repo: makeRepo(), command: 'gh pr merge 5' })
  assert.equal(result.status, 0)
  assert.equal(result.stderr, '')
})

test('a command that only mentions a merge is not looked at', () => {
  const result = runHook({
    repo: makeRepo(),
    command: "git commit -m 'note: gh pr merge 2029 later'",
    env: { GH_STUB_REVIEW: review },
  })
  assert.equal(result.status, 0)
  assert.equal(result.calls, '')
})
