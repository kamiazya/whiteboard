#!/usr/bin/env node

// Regression coverage for hooks/pre-pr-visual-evidence.mjs.
// Run with: pnpm test:scripts (also wired into the CI "check" job).
//
// The hook blocks `gh pr create` when the diff changes a surface a human
// looks at and the PR body neither carries a figure nor says why there is
// none. Builds a throwaway "origin" + working repo pair per test.

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { isolatedGitEnv } from './git-test-utils.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const scriptPath = resolve(__dirname, 'hooks', 'pre-pr-visual-evidence.mjs')

const scratchDirs = []
after(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true })
})

/** Scratch-repo git, and the hook's own, run without the contributor's global config. */
const gitEnv = isolatedGitEnv()
const git = (cwd, args) => execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf-8' }).trim()

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
  execFileSync('git', ['init', '-b', 'main', origin], { env: gitEnv, encoding: 'utf-8' })
  git(origin, ['config', 'user.email', 'test@example.com'])
  git(origin, ['config', 'user.name', 'test'])
  commitFile(origin, 'base.txt', 'base\n', 'base')
  execFileSync('git', ['clone', origin, work], { env: gitEnv, encoding: 'utf-8' })
  git(work, ['config', 'user.email', 'test@example.com'])
  git(work, ['config', 'user.name', 'test'])
  git(work, ['checkout', '-b', 'feat'])
  commitFile(work, changed, 'contents\n', 'a change')
  return work
}

/** Runs the hook against a `gh pr create` command; returns {status, stderr}. */
function runHook(cwd, command, env = gitEnv) {
  const stdin = JSON.stringify({ tool_input: { command } })
  try {
    execFileSync('node', [scriptPath], {
      cwd,
      env,
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

test('a figure still pointing at a local path is not a figure', () => {
  // Nothing uploads a local path any more (gh image replaced --attach), so on
  // GitHub it renders as a broken image while reading like evidence here.
  const work = makeRepoPair('apps/web/src/components/Thing.tsx')
  const body = '## Visual repro\n\n![figure](tmp/screenshots/figure.png)'
  const { status, stderr } = runHook(work, bodyArg(body))
  assert.equal(status, 2)
  assert.match(stderr, /gh image/)
})

test('allows a UI diff that states why there is no figure', () => {
  const work = makeRepoPair('apps/web/src/components/Thing.tsx')
  const body = 'Visual evidence: none — renames a prop, renders identically.'
  assert.equal(runHook(work, bodyArg(body)).status, 0)
})

test('a reason beginning "a" or "an" is a stated decision', () => {
  // The rule was `\S{3}` straight after the dash, which demands three
  // CONSECUTIVE non-space characters and so rejects a reason whose first word
  // is one or two letters. Measured at three of five real skip lines from one
  // session, every one of them a sentence the hook had just asked for.
  const work = makeRepoPair('apps/web/src/components/Thing.tsx')
  for (const reason of [
    'Visual evidence: none — a shell hook, whose verified output is pasted above.',
    'Visual evidence: none — an arch-lint guard and the markdown it now reads.',
  ]) {
    assert.equal(runHook(work, bodyArg(reason)).status, 0, reason)
  }
})

test('a one-character reason is still not a stated decision', () => {
  // The other side of the pair: the length rule has to keep rejecting what
  // `\S{3}` was there to reject.
  const work = makeRepoPair('apps/web/src/components/Thing.tsx')
  assert.equal(runHook(work, bodyArg('Visual evidence: none — x')).status, 2)
})

test('a reason of exactly three non-space characters is a stated decision; two are not', () => {
  const work = makeRepoPair('apps/web/src/components/Thing.tsx')
  assert.equal(runHook(work, bodyArg('Visual evidence: none — n/a')).status, 0)
  assert.equal(runHook(work, bodyArg('Visual evidence: none — a b c')).status, 0)
  assert.equal(runHook(work, bodyArg('Visual evidence: none — ok')).status, 2)
  assert.equal(runHook(work, bodyArg('Visual evidence: none — a  b')).status, 2)
})

const TEMPLATE = readFileSync(resolve(__dirname, '../../.github/PULL_REQUEST_TEMPLATE.md'), 'utf8')

test('an unedited PR template is not a stated decision', () => {
  // The template spells the escape inside an HTML comment, placeholder and all,
  // so a body nobody filled in carried a passing line GitHub never renders.
  assert.match(TEMPLATE, /<!--[\s\S]*?Visual evidence: none — <reason>[\s\S]*?-->/)
  const work = makeRepoPair('apps/web/src/components/Thing.tsx')
  writeFileSync(join(work, 'body.md'), TEMPLATE)
  assert.equal(runHook(work, 'gh pr create --title x --body-file body.md').status, 2)
  const filled = TEMPLATE.replace(
    '## Visual evidence\n',
    '## Visual evidence\n\nVisual evidence: none — renames a prop, renders identically.\n',
  )
  assert.notEqual(filled, TEMPLATE)
  writeFileSync(join(work, 'body.md'), filled)
  assert.equal(runHook(work, 'gh pr create --title x --body-file body.md').status, 0)
})

test('the placeholder itself is not a reason, while a reason naming an element is', () => {
  const work = makeRepoPair('apps/web/src/components/Thing.tsx')
  for (const body of [
    'Visual evidence: none — <reason>',
    'Visual evidence: none — `<reason>`.',
    'Visual evidence: none - <why there is no figure>',
  ]) {
    assert.equal(runHook(work, bodyArg(body)).status, 2, body)
  }
  for (const body of [
    'Visual evidence: none — renames a prop on <Toolbar>, renders identically.',
    'Visual evidence: none — <Toolbar> only gains a test id.',
  ]) {
    assert.equal(runHook(work, bodyArg(body)).status, 0, body)
  }
})

test('a figure or reason inside an HTML comment is not rendered, so it is not evidence', () => {
  const work = makeRepoPair('apps/web/src/components/Thing.tsx')
  for (const body of [
    '<!-- Visual evidence: none — renames a prop, renders identically. -->',
    '<!-- ![f.png](https://github.com/user-attachments/assets/abc) -->',
    // An unclosed comment hides the rest of the body on GitHub.
    'prose\n<!--\nVisual evidence: none — renames a prop.',
  ]) {
    assert.equal(runHook(work, bodyArg(body)).status, 2, body)
  }
})

test('a test-utils file under a UI package is not a rendered surface', () => {
  // canvas-render's entry in VISUAL_PATHS is the whole package, so a
  // three-line fast-check configuration under it was reported as a file a
  // human looks at and asked for a figure of itself.
  const work = makeRepoPair('packages/canvas-render/src/test-utils/fast-check.ts')
  assert.equal(runHook(work, bodyArg('## What\n\nSome prose.')).status, 0)
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

test('ignores a commit message that mentions a PR creation', () => {
  const work = makeRepoPair('apps/web/src/components/Thing.tsx')
  assert.equal(runHook(work, `git commit -m 'gh pr create --body x later'`).status, 0)
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

/** A PATH holding a `gh` that has (or lacks) the `image` extension, the way `gh image --help` answers. */
function envWithGh({ hasImageExtension }) {
  const dir = mkdtempSync(join(tmpdir(), 'pre-pr-visual-evidence-gh-'))
  scratchDirs.push(dir)
  writeFileSync(
    join(dir, 'gh'),
    hasImageExtension
      ? '#!/bin/sh\nexit 0\n'
      : '#!/bin/sh\necho \'unknown command "image" for "gh"\' >&2\nexit 1\n',
    { mode: 0o755 },
  )
  return isolatedGitEnv({ PATH: `${dir}:${process.env.PATH}` })
}

test('with no gh image extension, the remedy leads with the stated-reason escape and names the install', () => {
  const work = makeRepoPair('apps/web/src/components/Thing.tsx')
  const { status, stderr } = runHook(
    work,
    bodyArg('## What\n\nprose'),
    envWithGh({ hasImageExtension: false }),
  )
  assert.equal(status, 2)
  assert.match(stderr, /gh image.*not installed/)
  assert.match(stderr, /gh extension install drogers0\/gh-image/)
  const escapeAt = stderr.indexOf('Visual evidence: none')
  const upload = stderr.indexOf('upload it with')
  assert.ok(escapeAt !== -1, 'the escape is named')
  assert.ok(upload === -1 || escapeAt < upload, 'the escape comes before the upload instruction')
})

test('with the extension present, the remedy is the upload instruction as before', () => {
  const work = makeRepoPair('apps/web/src/components/Thing.tsx')
  const { stderr } = runHook(
    work,
    bodyArg('## What\n\nprose'),
    envWithGh({ hasImageExtension: true }),
  )
  assert.match(stderr, /upload it with `gh image tmp\/screenshots\/figure\.png`/)
  assert.doesNotMatch(stderr, /not installed/)
})

// The REST call a web session makes instead of the GraphQL-backed
// `gh pr create`, carrying its body in the forms `gh api` accepts.
const restCreate = (rest) =>
  `gh api -X POST repos/{owner}/{repo}/pulls -f head=feat -f base=main ${rest}`

test('a REST create blocks a UI diff with no figure exactly as gh pr create does', () => {
  const work = makeRepoPair('apps/web/src/components/Thing.tsx')
  const { status, stderr } = runHook(work, restCreate("-f title=x -f body='## What'"))
  assert.equal(status, 2)
  assert.match(stderr, /apps\/web\/src\/components\/Thing\.tsx/)
  // A create that sends no body makes a PR with an empty one, which carries no figure either.
  assert.equal(runHook(work, restCreate('-f title=x')).status, 2)
})

test('a REST create passes with a figure or a stated reason, from a field, a file or a heredoc', () => {
  const work = makeRepoPair('apps/web/src/components/Thing.tsx')
  writeFileSync(join(work, 'body.md'), '## Visual repro\n\n![f.png](https://example.invalid/f.png)')
  writeFileSync(
    join(work, 'pr.json'),
    JSON.stringify({ head: 'feat', body: 'Visual evidence: none — n/a' }),
  )
  for (const command of [
    restCreate("-f body='Visual evidence: none — renames a prop.'"),
    restCreate('-F body=@body.md'),
    'gh api -X POST repos/{owner}/{repo}/pulls --input pr.json',
    `${restCreate('-F body=@-')} <<'EOF'\nVisual evidence: none — a hook, output pasted.\nEOF`,
  ]) {
    assert.equal(runHook(work, command).status, 0, command)
  }
})

test('a REST body this hook cannot read blocks a UI diff and says how to pass it', () => {
  // Unlike `gh pr create --fill`, a REST create in a web session has no other
  // gate behind it, so an unreadable body is not a pass.
  const work = makeRepoPair('apps/web/src/components/Thing.tsx')
  const { status, stderr } = runHook(work, `cat body.md | ${restCreate('-F body=@-')}`)
  assert.equal(status, 2)
  assert.match(stderr, /could not read/)
  assert.match(stderr, /-F body=@<file>/)
  assert.match(stderr, /--input <file\.json>/)
})

test('an unreadable REST body on a diff no human looks at passes', () => {
  const work = makeRepoPair('packages/server-core/src/routes/thing.ts')
  assert.equal(runHook(work, `cat body.md | ${restCreate('-F body=@-')}`).status, 0)
})

test('a REST edit or read of a PR is not a creation', () => {
  const work = makeRepoPair('apps/web/src/components/Thing.tsx')
  assert.equal(runHook(work, 'gh api -X PATCH repos/{owner}/{repo}/pulls/3 -f body=x').status, 0)
  assert.equal(runHook(work, 'gh api repos/{owner}/{repo}/pulls').status, 0)
})
