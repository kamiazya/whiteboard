import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { originalSource } from './mutation-comment.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const scope = resolve(here, 'mutation-scope.mjs')
const comment = resolve(here, 'mutation-comment.mjs')
const run = (script, args, input) =>
  spawnSync('node', [script, ...args], { encoding: 'utf8', input, cwd: tmpdir() })

const dir = mkdtempSync(join(tmpdir(), 'mutation-cli-test-'))
const targets = join(dir, 'targets.mjs')
writeFileSync(targets, "export const MUTATED = ['src/a.ts', 'src/b.ts']\n")
const changed = join(dir, 'changed.txt')
writeFileSync(changed, 'pkg/src/a.ts\npkg/src/b.ts\nother/src/c.ts\n')

test('mutation-scope: --changed-from prints the comma list of curated changed files', () => {
  const r = run(scope, ['--targets', targets, '--prefix', 'pkg/', '--changed-from', changed])
  assert.equal(r.status, 0)
  assert.equal(r.stdout, 'src/a.ts,src/b.ts\n')
})

test('mutation-scope: without --changed-from it reads the diff from stdin', () => {
  const r = run(scope, ['--targets', targets, '--prefix', 'pkg/'], 'pkg/src/b.ts\n')
  assert.equal(r.stdout, 'src/b.ts\n')
})

test('mutation-scope: an empty intersection prints nothing and exits 0', () => {
  const r = run(scope, ['--targets', targets, '--prefix', 'pkg/'], 'elsewhere/x.ts\n')
  assert.equal(r.status, 0)
  assert.equal(r.stdout, '')
})

test('mutation-scope: a missing --targets or --prefix is a usage error, exit 2', () => {
  assert.equal(run(scope, ['--prefix', 'pkg/'], '').status, 2)
  assert.equal(run(scope, ['--targets', targets], '').status, 2)
})

const report = join(dir, 'report.json')
writeFileSync(
  report,
  JSON.stringify({
    files: {
      'src/a.ts': {
        mutants: [
          { mutatorName: 'EqualityOperator', replacement: 'a > b', status: 'Survived', location: { start: { line: 12, column: 1 }, end: { line: 12, column: 9 } } },
          { mutatorName: 'EqualityOperator', replacement: 'a < b', status: 'Killed', location: { start: { line: 3, column: 1 }, end: { line: 3, column: 9 } } },
        ],
      },
    },
  }),
)
const empty = join(dir, 'empty.json')
writeFileSync(empty, JSON.stringify({ files: {} }))

test('mutation-comment: renders the marker and the survivor row', () => {
  const r = run(comment, [report, '--marker', '<!-- m1 -->'])
  assert.equal(r.status, 0)
  assert.ok(r.stdout.startsWith('<!-- m1 -->'), r.stdout.slice(0, 80))
  assert.match(r.stdout, /src\/a\.ts/)
})

test('mutation-comment: the marker is taken from --marker, and a path AFTER the flag still resolves', () => {
  const r = run(comment, ['--marker', '<!-- m2 -->', report])
  assert.ok(r.stdout.startsWith('<!-- m2 -->'))
})

test('mutation-comment: default marker when none given', () => {
  const r = run(comment, [report])
  assert.ok(r.stdout.startsWith('<!-- mutation-report -->'))
})

test('mutation-comment: nothing to say prints nothing', () => {
  const r = run(comment, [empty])
  assert.equal(r.status, 0)
  assert.equal(r.stdout, '')
})

test('mutation-comment: no report path is a usage error, exit 2', () => {
  assert.equal(run(comment, []).status, 2)
  assert.equal(run(comment, ['--marker', 'x']).status, 2)
})

// The ledger must be the module the flag names: an empty one cannot tell a flag that is read from
// one that is ignored, so this survivor is recorded in it and must leave the table.
test('mutation-comment: --equivalents imports the ledger, so a recorded survivor is counted, not listed', () => {
  const equivalentsReport = join(dir, 'equivalents-report.json')
  writeFileSync(
    equivalentsReport,
    JSON.stringify({
      files: {
        'src/a.ts': {
          source: 'const x = a > b\n',
          mutants: [
            {
              mutatorName: 'EqualityOperator',
              replacement: 'a >= b',
              status: 'Survived',
              location: { start: { line: 1, column: 11 }, end: { line: 1, column: 16 } },
            },
          ],
        },
      },
    }),
  )
  const eq = join(dir, 'eq.mjs')
  writeFileSync(
    eq,
    "export const KNOWN_EQUIVALENT = { 'src/a.ts': { 'EqualityOperator: a > b -> a >= b': 1 } }\n",
  )

  const withLedger = run(comment, [equivalentsReport, '--equivalents', eq])
  assert.equal(withLedger.status, 0)
  assert.doesNotMatch(withLedger.stdout, /\| `src\/a\.ts:1`/)
  assert.match(withLedger.stdout, /already recorded as equivalent/)

  const without = run(comment, [equivalentsReport])
  assert.match(without.stdout, /\| `src\/a\.ts:1`/)
})

test('mutation-comment: originalSource spans lines — first line tail, middle lines, last line head', () => {
  const src = 'aaa BBB\nmid1\nmid2\nCCC ddd'
  const loc = { start: { line: 1, column: 5 }, end: { line: 4, column: 4 } }
  assert.equal(originalSource(src, loc), 'BBB mid1 mid2 CCC')
})

test('mutation-comment: originalSource on one line slices by columns', () => {
  assert.equal(originalSource('0123456789', { start: { line: 1, column: 3 }, end: { line: 1, column: 6 } }), '234')
})
