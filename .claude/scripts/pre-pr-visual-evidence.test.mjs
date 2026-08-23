#!/usr/bin/env node
// Regression coverage for hooks/pre-pr-visual-evidence.mjs.
// Run with: pnpm test:scripts (also wired into the CI "check" job).
//
// The hook blocks `gh pr create` when the diff changes a surface a human
// looks at and the PR body neither carries a figure nor says why there is
// none. Builds a throwaway "origin" + working repo pair per test.

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'

const __dirname = dirname(fileURLToPath(import.meta.url))
const scriptPath = resolve(__dirname, 'hooks', 'pre-pr-visual-evidence.mjs')

const scratchDirs = []
after(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true })
})

const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim()

function commitFile(repo, name, content, message) {
  mkdirSync(dirname(join(repo, name)), { recursive: true })
  writeFileSync(join(repo, name), content)
  git(repo, ['add', name])
  git(repo, ['commit', '-m', message, '--no-verify'])
}

/** origin on main + a clone on a feature branch that changed `changed`. */
function makeRepoPair(changed) {
  const dir = mkdtempSync(join(tmpdir(), 'pre-pr-visual-evidence-test-'))
  scratchDirs.push(dir)
  const origin = join(dir, 'origin')
  const work = join(dir, 'work')
  execFileSync('git', ['init', '-b', 'main', origin], { encoding: 'utf-8' })
  git(origin, ['config', 'user.email', 'test@example.com'])
  git(origin, ['config', 'user.name', 'test'])
  commitFile(origin, 'base.txt', 'base\n', 'base')
  execFileSync('git', ['clone', origin, work], { encoding: 'utf-8' })
  git(work, ['config', 'user.email', 'test@example.com'])
  git(work, ['config', 'user.name', 'test'])
  git(work, ['checkout', '-b', 'feat'])
  commitFile(work, changed, 'contents\n', 'a change')
  return work
}

/** Runs the hook against a `gh pr create` command; returns {status, stderr}. */
function runHook(cwd, command) {
  const stdin = JSON.stringify({ tool_input: { command } })
  try {
    execFileSync('node', [scriptPath], {
      cwd,
      input: stdin,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    return { status: 0, stderr: '' }
  } catch (err) {
    return { status: err.status, stderr: String(err.stderr ?? '') }
  }
}

const bodyArg = (body) => `gh pr create --title x --body ${JSON.stringify(body)}`

test('blocks a UI diff whose body carries no figure and no reason', () => {
  const work = makeRepoPair('apps/web/src/components/Thing.tsx')
  const { status, stderr } = runHook(work, bodyArg('## What\n\nSome prose.'))
  assert.equal(status, 2)
  assert.match(stderr, /apps\/web\/src\/components\/Thing\.tsx/)
})

test('allows a UI diff whose body carries a figure', () => {
  const work = makeRepoPair('apps/web/src/components/Thing.tsx')
  const body = '## Visual repro\n\n![figure.png](https://github.com/user-attachments/assets/abc)'
  assert.equal(runHook(work, bodyArg(body)).status, 0)
})

test('allows a UI diff that states why there is no figure', () => {
  const work = makeRepoPair('apps/web/src/components/Thing.tsx')
  const body = 'Visual evidence: none — renames a prop, renders identically.'
  assert.equal(runHook(work, bodyArg(body)).status, 0)
})

test('a bare "none" with no reason is not a stated decision', () => {
  // The escape exists to turn an omission into a decision. Without a reason
  // it is the same omission with a sentence in front of it.
  const work = makeRepoPair('apps/web/src/components/Thing.tsx')
  assert.equal(runHook(work, bodyArg('Visual evidence: none')).status, 2)
  assert.equal(runHook(work, bodyArg('Visual evidence: none.')).status, 2)
})

test('ignores the command text quoted inside an unrelated command', () => {
  // `echo "gh pr create …"` creates no PR, and blocking it teaches people
  // the hook is noise.
  const work = makeRepoPair('apps/web/src/components/Thing.tsx')
  assert.equal(runHook(work, `printf 'gh pr create --body x'`).status, 0)
})

test('still fires when the command follows a cd or a chained separator', () => {
  const work = makeRepoPair('apps/web/src/components/Thing.tsx')
  assert.equal(runHook(work, `cd ${work} && ${bodyArg('## What')}`).status, 2)
})

test('a section header with no image is not evidence', () => {
  // The hollow shape this hook exists for: the heading satisfies a reader
  // skimming for it while the figure was never produced.
  const work = makeRepoPair('apps/web/src/components/Thing.tsx')
  const { status } = runHook(work, bodyArg('## Visual repro\n\nSee the tests.'))
  assert.equal(status, 2)
})

test('ignores a diff that touches no surface a human looks at', () => {
  const work = makeRepoPair('packages/server-core/src/routes/thing.ts')
  assert.equal(runHook(work, bodyArg('## What\n\nprose')).status, 0)
})

test('ignores a test-only change under a UI path', () => {
  const work = makeRepoPair('apps/web/src/components/Thing.browser.test.tsx')
  assert.equal(runHook(work, bodyArg('## What\n\nprose')).status, 0)
})

test('reads the body from --body-file', () => {
  const work = makeRepoPair('apps/web/src/components/Thing.tsx')
  const file = join(work, 'body.md')
  writeFileSync(file, '## Visual repro\n\n![f.png](https://example.invalid/f.png)')
  assert.equal(runHook(work, `gh pr create --title x --body-file ${file}`).status, 0)
})

test('fails open on a command it cannot read a body out of', () => {
  // A body arriving by stdin or an editor is not readable here, and a hook
  // that blocks what it cannot inspect is a hook people learn to bypass.
  const work = makeRepoPair('apps/web/src/components/Thing.tsx')
  assert.equal(runHook(work, 'gh pr create --title x --fill').status, 0)
})

test('ignores every command that is not gh pr create', () => {
  const work = makeRepoPair('apps/web/src/components/Thing.tsx')
  assert.equal(runHook(work, 'git push').status, 0)
})
