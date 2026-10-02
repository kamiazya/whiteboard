#!/usr/bin/env node
// Runs the ci-triage skill's two watch loops, extracted from SKILL.md, against
// a `gh` stub and a `sleep` that returns at once. What is pinned is the
// property that matters for a loop that decides when to merge: a read that
// FAILED or came back EMPTY is "unknown" and never "settled". The loop this
// replaced fell back to '[]' on any `gh` error and exited as a clean PR.
// Run with: pnpm test:scripts.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const skill = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'ci-triage', 'SKILL.md'),
  'utf-8',
)
const [allChecksLoop, gateLoop] = [...skill.matchAll(/```bash\n(PR=<PR>[\s\S]*?)```/g)].map((m) => m[1])

const scratchDirs = []
after(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true })
})

/**
 * `answers` is the sequence of check-run listings the stub returns, one per
 * call to the check-runs endpoint (the last repeats); `null` makes that call
 * fail the way a session without GraphQL access does.
 */
function runLoop(loop, answers) {
  const dir = mkdtempSync(join(tmpdir(), 'ci-triage-watch-'))
  scratchDirs.push(dir)
  writeFileSync(join(dir, 'answers.json'), JSON.stringify(answers))
  const gh = join(dir, 'gh')
  writeFileSync(
    gh,
    `#!${process.execPath}
const fs = require('node:fs')
const dir = ${JSON.stringify(dir)}
const args = process.argv.slice(2).join(' ')
const fail = () => { process.stderr.write('HTTP 403: GitHub GraphQL is not available\\n'); process.exit(1) }
if (args.includes('/check-runs')) {
  const answers = JSON.parse(fs.readFileSync(dir + '/answers.json', 'utf8'))
  let n = 0
  try { n = Number(fs.readFileSync(dir + '/n', 'utf8')) } catch {}
  fs.writeFileSync(dir + '/n', String(n + 1))
  const answer = answers[Math.min(n, answers.length - 1)]
  if (answer === null) fail()
  process.stdout.write(answer)
} else if (/pulls\\/\\d+ /.test(args + ' ')) {
  process.stdout.write('abc123\\n')
} else fail()
`,
  )
  writeFileSync(join(dir, 'sleep'), '#!/bin/sh\nexit 0\n')
  chmodSync(gh, 0o755)
  chmodSync(join(dir, 'sleep'), 0o755)
  const result = spawnSync('bash', ['-c', loop.replace('PR=<PR>', 'PR=7')], {
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
    encoding: 'utf-8',
    timeout: 20_000,
  })
  const calls = Number(readFileSync(join(dir, 'n'), 'utf-8'))
  return { status: result.status, stdout: result.stdout, calls }
}

test('the skill carries both loops, and neither swallows a failed read into an empty one', () => {
  assert.ok(allChecksLoop && gateLoop, 'the two watch loops were not found in SKILL.md')
  for (const loop of [allChecksLoop, gateLoop]) assert.doesNotMatch(loop, /\|\|\s*echo\s+'\[\]'/)
})

test('a GitHub that cannot be read ends as UNKNOWN, not as a settled PR', () => {
  const { status, stdout } = runLoop(allChecksLoop, [null])
  assert.equal(status, 1)
  assert.match(stdout, /UNKNOWN/)
  assert.doesNotMatch(stdout, /: success/)
})

test('an empty check-run list is waiting, and the loop ends only once runs settle', () => {
  const { status, stdout, calls } = runLoop(allChecksLoop, ['', 'verify\tin_progress\t\n', 'verify\tcompleted\tsuccess\nci-gate\tcompleted\tfailure\n'])
  assert.equal(status, 0)
  assert.ok(calls >= 3, `settled after ${calls} reads, before the runs had finished`)
  assert.match(stdout, /verify: success/)
  assert.match(stdout, /ci-gate: failure/)
})

test('a run still pending keeps the loop going', () => {
  const { calls } = runLoop(allChecksLoop, [
    'verify\tcompleted\tsuccess\nWIP\tqueued\t\n',
    'verify\tcompleted\tsuccess\nWIP\tcompleted\tsuccess\n',
  ])
  assert.equal(calls, 2)
})

test('the ci-gate loop keeps waiting through unreadable and pending answers', () => {
  const { status, stdout, calls } = runLoop(gateLoop, [null, '', 'pending\n', 'failure\n'])
  assert.equal(status, 0)
  assert.equal(calls, 4)
  assert.match(stdout, /ci-gate: failure/)
})
