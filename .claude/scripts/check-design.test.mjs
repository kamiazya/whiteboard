#!/usr/bin/env node
// Run with: pnpm test:scripts
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
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
