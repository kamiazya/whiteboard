// The helper's whole value is the path where it REFUSES, and a refusal that
// stops refusing is silent: every mutation check after it passes, against
// source nothing changed. That is the class `mutate.mjs` exists to close, so
// it is the one this file pins — the same argument `biome-plugin.test.mjs`
// makes about config regressing without a sound.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const SCRIPT = join(import.meta.dirname, 'mutate.mjs')
const ORIGINAL = 'keep me\nthe exact line\nkeep me too\n'

function withFixture(run) {
  const dir = mkdtempSync(join(tmpdir(), 'mutate-guard-'))
  const file = join(dir, 'subject.txt')
  writeFileSync(file, ORIGINAL)
  try {
    return run(file)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const mutate = (args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' })

test('exits 3 and names the needle when the substitution matches nothing', () => {
  withFixture((file) => {
    const run = mutate([file, 'a line that is not there', 'x', '--', process.execPath, '-e', ''])
    assert.equal(run.status, 3, run.stderr)
    assert.match(run.stderr, /NOTHING MATCHED/)
    assert.match(run.stderr, /a line that is not there/)
    // And the command never ran, so nothing can read its exit code as a result.
    assert.equal(readFileSync(file, 'utf8'), ORIGINAL)
  })
})

test('the command sees the mutated file, and the exit code comes from it', () => {
  withFixture((file) => {
    const assertMutated = `const s=require('node:fs').readFileSync(${JSON.stringify(file)},'utf8');process.exit(s.includes('the mutation')&&!s.includes('the exact line')?7:1)`
    const run = mutate([file, 'the exact line', 'the mutation', '--', process.execPath, '-e', assertMutated])
    assert.equal(run.status, 7, `command did not see the mutation\n${run.stderr}`)
    assert.match(run.stderr, /1 occurrence\(s\) replaced/)
  })
})

test('restores the file even when the command fails', () => {
  withFixture((file) => {
    const run = mutate([file, 'the exact line', 'the mutation', '--', process.execPath, '-e', 'process.exit(1)'])
    assert.equal(run.status, 1)
    assert.equal(readFileSync(file, 'utf8'), ORIGINAL)
  })
})

test('replaces every occurrence and says how many', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mutate-guard-'))
  const file = join(dir, 'twice.txt')
  writeFileSync(file, 'x\nx\n')
  try {
    const run = mutate([file, 'x', 'y', '--', process.execPath, '-e', ''])
    assert.match(run.stderr, /2 occurrence\(s\) replaced/)
    assert.equal(readFileSync(file, 'utf8'), 'x\nx\n')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
