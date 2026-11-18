#!/usr/bin/env node
// Regression coverage for merge-mutation-reports.mjs.
// Run with: pnpm test:scripts (also wired into the CI "check" job).

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { mergeReports } from './merge-mutation-reports.mjs'

const SCRIPT = new URL('./merge-mutation-reports.mjs', import.meta.url).pathname

test('the legs’ files and testFiles maps are concatenated; the rest is the first leg’s', () => {
  const merged = mergeReports([
    {
      schemaVersion: '2',
      thresholds: { high: 80 },
      files: { 'a.ts': 1 },
      testFiles: { 'a.test.ts': 1 },
    },
    { schemaVersion: '2', thresholds: { high: 80 }, files: { 'b.ts': 2 } },
  ])
  assert.deepEqual(merged, {
    schemaVersion: '2',
    thresholds: { high: 80 },
    files: { 'a.ts': 1, 'b.ts': 2 },
    testFiles: { 'a.test.ts': 1 },
  })
})

test('a report carrying a lone surrogate escape merges, where jq refuses it', () => {
  // Stryker writes a test's source into the report, and a test about lone
  // surrogates holds one as `\ud800` — valid JSON text that jq rejects
  // ("Invalid \uXXXX\uXXXX surrogate pair escape") and would fail the
  // report step outright.
  const dir = mkdtempSync(join(tmpdir(), 'merge-mutation-'))
  const a = join(dir, 'a.json')
  const b = join(dir, 'b.json')
  writeFileSync(a, '{"files":{"x.ts":{"source":"\\ud800"}},"testFiles":{}}')
  writeFileSync(b, '{"files":{"y.ts":{"source":"ok"}}}')
  const out = join(dir, 'out.json')
  execFileSync(process.execPath, [SCRIPT, out, a, b])
  const merged = JSON.parse(readFileSync(out, 'utf8'))
  assert.deepEqual(Object.keys(merged.files), ['x.ts', 'y.ts'])
  assert.equal(merged.files['x.ts'].source, '\ud800')
})

test('no input reports is a usage error, not an empty merge', () => {
  assert.throws(() => execFileSync(process.execPath, [SCRIPT, '/dev/null'], { stdio: 'pipe' }))
})
