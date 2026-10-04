#!/usr/bin/env node
// Run with: pnpm test:scripts
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const script = join(dirname(fileURLToPath(import.meta.url)), 'check-design.mjs')

test('--help prints usage instead of trying to read a file called --help', () => {
  const result = spawnSync('node', [script, '--help'], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /usage: check-design/)
})

test('an unknown option exits 2 with usage', () => {
  const result = spawnSync('node', [script, '--bogus'], { encoding: 'utf8' })
  assert.equal(result.status, 2)
  assert.match(result.stderr, /unknown option --bogus/)
})

const complete = {
  completionCriteria: ['users can export a canvas'],
  scope: 'apps/web/src/pages/Export.tsx',
  testScenarios: { unit: ['export returns a PNG'] },
  properties: ['none: pure UI wiring'],
  blastRadius: ['none: new leaf module'],
  userReach: ['rendered by CanvasPage, reachable from /w/:ws'],
  benefit: 'obvious: a missing button, visible in the diff',
}
const run = (args, input) => spawnSync('node', [script, ...args], { encoding: 'utf8', input })

test('a complete design from stdin exits 0 and says every checkpoint is met', () => {
  const result = run([], JSON.stringify(complete))
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /all met/)
})

test('"-" reads stdin the same way as no argument', () => {
  const result = run(['-'], JSON.stringify(complete))
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /all met/)
})

test('an incomplete design exits 1 and lists each unmet checkpoint on its own line', () => {
  const { blastRadius, userReach, ...partial } = complete
  const result = run([], JSON.stringify(partial))
  assert.equal(result.status, 1)
  assert.match(result.stdout, /2 unmet/)
  const lines = result.stdout.split('\n').filter((line) => line.startsWith('  - '))
  assert.equal(lines.length, 2)
  assert.match(lines.join('\n'), /blastRadius/)
  assert.match(lines.join('\n'), /userReach/)
})

test('a file argument is read from disk', () => {
  const dir = mkdtempSync(join(tmpdir(), 'check-design-'))
  try {
    const file = join(dir, 'design.json')
    writeFileSync(file, JSON.stringify(complete))
    const result = run([file])
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /all met/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an unreadable file exits 2 naming the file', () => {
  const result = run(['/nonexistent/design.json'])
  assert.equal(result.status, 2)
  assert.match(result.stderr, /could not read \/nonexistent\/design\.json/)
})

test('invalid JSON exits 2', () => {
  const result = run([], '{not json')
  assert.equal(result.status, 2)
  assert.match(result.stderr, /not valid JSON/)
})
