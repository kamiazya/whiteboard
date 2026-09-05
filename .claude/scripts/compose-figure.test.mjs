#!/usr/bin/env node
// Regression coverage for compose-figure.mjs.
// Run with: pnpm test:scripts (also wired into the CI "check" job).
//
// The script exists for one refusal: two panels that came out identical.
// That is what a `git stash` with nothing to stash, or a revert that did not
// take, silently produces — and the resulting figure shows a reviewer the
// same picture twice under a "before" and an "after" label.

import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'

const __dirname = dirname(fileURLToPath(import.meta.url))
const scriptPath = resolve(__dirname, 'compose-figure.mjs')

// The premise is PROBED, never inferred: the same binary compose-figure.mjs
// shells out to, asked directly.
const IMAGEMAGICK_ABSENT = (() => {
  try {
    execFileSync('convert', ['-version'], { stdio: 'ignore' })
    return false
  } catch {
    return true
  }
})()

// Guarded from both sides, the way every probed skip in this repo is. On CI
// the premise MUST hold — ci.yml installs ImageMagick for exactly this file —
// so absence there is the install step regressing, and a skip would let a
// guard stop running while every summary line stayed green. Locally a
// developer without it is told what to install and `pnpm check:local` still
// completes; before this, one absent binary failed the whole local gate.
if (IMAGEMAGICK_ABSENT && process.env.CI) {
  console.error(
    'compose-figure.test.mjs needs ImageMagick (`convert`, `identify`) on CI — the same tool ' +
      'compose-figure.mjs shells out to. ci.yml installs it; that step has regressed.',
  )
  process.exit(1)
}

const needsImageMagick = {
  skip: IMAGEMAGICK_ABSENT
    ? 'ImageMagick (`convert`) is absent — install it (apt: imagemagick, brew: imagemagick) to run these; CI does'
    : false,
}

const scratchDirs = []
after(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true })
})

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'compose-figure-test-'))
  scratchDirs.push(dir)
  return dir
}

/** A tiny valid PNG, `size`-px square in the given colour. */
function png(path, colour) {
  execFileSync('convert', ['-size', '40x40', `xc:${colour}`, path], { encoding: 'utf-8' })
}

function run(args) {
  try {
    const stdout = execFileSync('node', [scriptPath, ...args], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    return { status: 0, stdout, stderr: '' }
  } catch (err) {
    return { status: err.status, stdout: String(err.stdout ?? ''), stderr: String(err.stderr ?? '') }
  }
}

test('refuses two panels that are byte-identical', needsImageMagick, () => {
  const dir = scratch()
  const before = join(dir, 'before.png')
  const after = join(dir, 'after.png')
  png(before, 'white')
  png(after, 'white')
  const out = join(dir, 'figure.png')
  const { status, stderr } = run(['--before', before, '--after', after, '--out', out])
  assert.equal(status, 1)
  assert.match(stderr, /same picture/i)
  assert.equal(existsSync(out), false, 'must not leave a figure that shows one picture twice')
})

test('composes a figure when the panels differ, and reports both digests', needsImageMagick, () => {
  const dir = scratch()
  const before = join(dir, 'before.png')
  const after = join(dir, 'after.png')
  png(before, 'white')
  png(after, 'black')
  const out = join(dir, 'figure.png')
  const { status, stdout } = run(['--before', before, '--after', after, '--out', out])
  assert.equal(status, 0)
  assert.equal(existsSync(out), true)
  // The digests go in the PR body: they are what lets a reader confirm the
  // two panels were actually different renders rather than one file twice.
  const digests = stdout.match(/\b[0-9a-f]{8}\b/g) ?? []
  assert.equal(new Set(digests).size >= 2, true, `expected two distinct digests, got ${stdout}`)
})

test('refuses two panels that differ only in metadata', needsImageMagick, () => {
  // A byte compare says these differ; they are the same picture. Whatever
  // wrote them stamped something incidental, and the refusal has to survive
  // that or it protects nothing.
  const dir = scratch()
  const before = join(dir, 'before.png')
  const after = join(dir, 'after.png')
  png(before, 'white')
  execFileSync('convert', [before, '-set', 'comment', 'a different stamp', after], {
    encoding: 'utf-8',
  })
  assert.notEqual(readFileSync(before).equals(readFileSync(after)), true, 'fixture must differ in bytes')
  const { status, stderr } = run(['--before', before, '--after', after, '--out', join(dir, 'f.png')])
  assert.equal(status, 1)
  assert.match(stderr, /same picture/i)
})

test('gives a wider panel a label band of its own width', needsImageMagick, () => {
  // A change can legitimately resize what it renders, so mismatched panels
  // are not an error — but a label band built at the OTHER panel's width
  // crops the text, silently, in the half of the figure that is the point.
  const dir = scratch()
  const before = join(dir, 'before.png')
  const after = join(dir, 'after.png')
  png(before, 'white')
  execFileSync('convert', ['-size', '400x40', 'xc:white', after], { encoding: 'utf-8' })
  const out = join(dir, 'figure.png')
  const { status } = run([
    '--before',
    before,
    '--after',
    after,
    '--out',
    out,
    '--after-label',
    'a much longer after label than the narrow panel can hold',
  ])
  assert.equal(status, 0)
  // The after label band sits below [border][before label 30][before 40].
  // Past the before panel's width it must carry ink, not white padding.
  const mean = Number(
    execFileSync(
      'convert',
      [out, '-crop', '320x30+60+71', '+repage', '-format', '%[mean]', 'info:'],
      { encoding: 'utf-8' },
    ).trim(),
  )
  const white = Number(
    execFileSync('convert', ['-size', '10x10', 'xc:white', '-format', '%[mean]', 'info:'], {
      encoding: 'utf-8',
    }).trim(),
  )
  assert.equal(mean < white, true, `expected label text past x=60, got mean ${mean} vs white ${white}`)
})

test('refuses a missing input rather than composing half a figure', needsImageMagick, () => {
  const dir = scratch()
  const before = join(dir, 'before.png')
  png(before, 'white')
  const { status, stderr } = run([
    '--before',
    before,
    '--after',
    join(dir, 'nope.png'),
    '--out',
    join(dir, 'figure.png'),
  ])
  assert.equal(status, 1)
  assert.match(stderr, /nope\.png/)
})

test('carries the labels it was given into the figure', needsImageMagick, () => {
  const dir = scratch()
  const before = join(dir, 'before.png')
  const after = join(dir, 'after.png')
  png(before, 'white')
  png(after, 'black')
  const out = join(dir, 'figure.png')
  const { status } = run([
    '--before',
    before,
    '--after',
    after,
    '--out',
    out,
    '--before-label',
    'the defect',
    '--after-label',
    'the fix',
  ])
  assert.equal(status, 0)
  // Labelled panels are taller than the two inputs alone (40+40).
  const height = Number(
    execFileSync('identify', ['-format', '%h', out], { encoding: 'utf-8' }).trim(),
  )
  assert.equal(height > 80, true, `expected label bands, got height ${height}`)
})
