#!/usr/bin/env node
// Regression coverage for compose-figure.mjs.
// Run with: pnpm test:scripts (also wired into the CI "check" job).
//
// The script exists for one refusal: two panels that came out identical.
// That is what a `git stash` with nothing to stash, or a revert that did not
// take, silently produces — and the resulting figure shows a reviewer the
// same picture twice under a "before" and an "after" label.

import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'

const __dirname = dirname(fileURLToPath(import.meta.url))
const scriptPath = resolve(__dirname, 'compose-figure.mjs')

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

test('refuses two panels that are byte-identical', () => {
  const dir = scratch()
  const before = join(dir, 'before.png')
  const after = join(dir, 'after.png')
  png(before, 'white')
  png(after, 'white')
  const out = join(dir, 'figure.png')
  const { status, stderr } = run(['--before', before, '--after', after, '--out', out])
  assert.equal(status, 1)
  assert.match(stderr, /identical/i)
  assert.equal(existsSync(out), false, 'must not leave a figure that shows one picture twice')
})

test('composes a figure when the panels differ, and reports both digests', () => {
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

test('refuses a missing input rather than composing half a figure', () => {
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

test('carries the labels it was given into the figure', () => {
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
