#!/usr/bin/env node
// record-audit.mjs resolves its log relative to its own location, so each test runs a copy laid
// out like the repo inside a scratch directory: the tracked .claude/audit-log.jsonl is never
// touched. Run with: pnpm test:scripts
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const scratch = mkdtempSync(join(tmpdir(), 'record-audit-test-'))
after(() => rmSync(scratch, { recursive: true, force: true }))

mkdirSync(join(scratch, '.claude', 'scripts'), { recursive: true })
for (const file of ['record-audit.mjs', 'script-flags.mjs']) {
  copyFileSync(join(here, file), join(scratch, '.claude', 'scripts', file))
}
const logPath = join(scratch, '.claude', 'audit-log.jsonl')
const record = (...args) =>
  spawnSync('node', [join(scratch, '.claude', 'scripts', 'record-audit.mjs'), ...args], {
    encoding: 'utf8',
  })

test('a known kind appends one {kind, at} row', () => {
  const result = record('audit-triage')
  assert.equal(result.status, 0, result.stderr)
  const rows = readFileSync(logPath, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  assert.equal(rows.length, 1)
  assert.equal(rows[0].kind, 'audit-triage')
  assert.ok(!Number.isNaN(Date.parse(rows[0].at)))
  rmSync(logPath)
})

test('--help, an unknown option, a missing kind and an unlisted kind print usage and append nothing', () => {
  for (const args of [['--help'], ['--bogus'], [], ['audit-triage', 'extra'], ['made-up-kind']]) {
    const result = record(...args)
    assert.equal(result.status, args[0] === '--help' ? 0 : 2, JSON.stringify(args))
    assert.match(`${result.stdout}${result.stderr}`, /usage: record-audit/, JSON.stringify(args))
    assert.equal(existsSync(logPath), false, `${JSON.stringify(args)} wrote the log`)
  }
})

// A kind is recordable only while audit-nudge reads it: a row nothing reads says a cadence is
// being watched when nobody is watching it. dogfood-triage has no cadence check — its runs need a
// browser MCP the session may not have, so a nudge would be one nobody could act on.
test('dogfood-triage is refused: nothing reads that kind', () => {
  const result = record('dogfood-triage')
  assert.equal(result.status, 2, result.stderr)
  assert.match(result.stderr, /unknown kind dogfood-triage/)
  assert.equal(existsSync(logPath), false)
})
