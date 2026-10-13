#!/usr/bin/env node
// CLI coverage for complexity-of.mjs: what a reviewer actually runs.
// Run with: pnpm test:scripts
//
// The script measures the git checkout it is run FROM and lints through `pnpm exec biome`, so each
// case runs it inside a throwaway repository whose node_modules is this checkout's. Its biome.json
// names a threshold of 3, which makes small fixture functions cross it.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { complexityScopeFrom } from './complexity-of-lib.mjs'
import { isolatedGitEnv } from './git-test-utils.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const script = join(here, 'complexity-of.mjs')
const repoModules = join(here, '..', '..', 'node_modules')

// The fixture's git and the script's own run without the contributor's global config: a signed
// tag or a global hook would otherwise fail the premise below and read as a missing biome.
const env = isolatedGitEnv()
const sh = (cwd, cmd, args) => spawnSync(cmd, args, { cwd, env, encoding: 'utf8' })
const git = (cwd, ...args) => sh(cwd, 'git', args)

const BASE_SOURCE = [
  'export function steady(a) {',
  '  if (a) {',
  '    if (a.b) return a.b',
  '  }',
  '  return a',
  '}',
  'export function grows(a) {',
  '  if (a) {',
  '    if (a.b) return a.b',
  '  }',
  '  return a',
  '}',
  '',
].join('\n')
const HEAD_SOURCE = [
  'export function steady(a) {',
  '  if (a) {',
  '    if (a.b) return a.b',
  '  }',
  '  return a',
  '}',
  'export function grows(a) {',
  '  if (a) {',
  '    for (const x of a) {',
  '      if (x) {',
  '        if (x.b) return x.b',
  '      }',
  '    }',
  '  }',
  '  return a',
  '}',
  '',
].join('\n')

let dir
let premise = null
before(() => {
  dir = mkdtempSync(join(tmpdir(), 'complexity-of-'))
  writeFileSync(join(dir, 'package.json'), '{"name":"fixture","private":true}\n')
  writeFileSync(
    join(dir, 'biome.json'),
    JSON.stringify({
      files: { includes: ['**/*.mjs', '**/*.md', '!wf/*.workflow.mjs'] },
      overrides: [
        {
          includes: ['**/*.mjs', '!**/*.test.mjs'],
          linter: {
            rules: {
              complexity: {
                noExcessiveCognitiveComplexity: {
                  level: 'error',
                  options: { maxAllowedComplexity: 3 },
                },
              },
            },
          },
        },
      ],
    }),
  )
  writeFileSync(join(dir, 'm.mjs'), BASE_SOURCE)
  symlinkSync(repoModules, join(dir, 'node_modules'))
  // The premise is probed by doing the thing: a repository we can commit to and a biome that runs
  // from it. Whether a case may skip is decided here, not guessed from the environment.
  const steps = [
    ['init', '-q'],
    ['add', 'm.mjs', 'biome.json', 'package.json'],
    ['commit', '-qm', 'base'],
    ['tag', 'fixture-base'],
  ]
  const committed = steps.every((step) => git(dir, ...step).status === 0)
  const biome = committed ? sh(dir, 'pnpm', ['exec', 'biome', '--version']) : null
  if (biome?.status !== 0)
    premise = 'needs git and a runnable `pnpm exec biome` in a scratch repository'
  else {
    writeFileSync(join(dir, 'm.mjs'), HEAD_SOURCE)
    // Grown beside m.mjs, and each outside what biome's complexity rule lints.
    mkdirSync(join(dir, 'wf'))
    writeFileSync(join(dir, 'wf', 'x.workflow.mjs'), HEAD_SOURCE)
    writeFileSync(join(dir, 'm.test.mjs'), HEAD_SOURCE)
    writeFileSync(join(dir, 'notes.md'), '# notes\n')
    git(dir, 'add', 'm.mjs', 'wf/x.workflow.mjs', 'm.test.mjs', 'notes.md')
    git(dir, 'commit', '-qm', 'grow')
  }
})
after(() => rmSync(dir, { recursive: true, force: true }))

// A skipped test reads like a passing one, so CI must never be able to take the skip.
test('the premise holds wherever CI runs', () => {
  if (process.env.CI) assert.equal(premise, null, premise ?? '')
})

const run = (...args) => spawnSync('node', [script, ...args], { cwd: dir, env, encoding: 'utf8' })
// Decided when the case runs, after `before` has probed: the option form would read `premise` at registration.
const probed = (body) => (t) => (premise === null ? body() : t.skip(premise))

test(
  'no files names that and exits 0',
  probed(() => {
    const result = run()
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /complexity-of: no files/)
  }),
)

test(
  'a plain run scores the function over the threshold, with no base column',
  probed(() => {
    const result = run('m.mjs')
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /^score {2}function$/m)
    assert.match(result.stdout, /^! +10 +m\.mjs:7 {2}grows$/m)
    assert.match(result.stdout, /over the 3 threshold/)
  }),
)

test(
  '--base scores the file at that ref too and prints the delta against it',
  probed(() => {
    const result = run('--base', 'fixture-base', 'm.mjs')
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /^score {2}base {2}delta {2}function$/m)
    assert.match(result.stdout, /^! +10 +3 +\+7 +m\.mjs:7 {2}grows$/m)
  }),
)

test(
  'an unchanged function reports delta 0 and sorts below the one that grew',
  probed(() => {
    const rows = run('--base', 'fixture-base', 'm.mjs').stdout.split('\n')
    const grows = rows.findIndex((row) => /grows$/.test(row))
    const steady = rows.findIndex((row) => /^~ +3 +3 +0 +m\.mjs:1 {2}steady$/.test(row))
    assert.ok(grows >= 0 && steady > grows, rows.join('\n'))
  }),
)

test(
  'a file absent at the base is scored as new rather than failing the run',
  probed(() => {
    writeFileSync(join(dir, 'added.mjs'), HEAD_SOURCE)
    const result = run('--base', 'fixture-base', 'added.mjs')
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /^! +10 +new +added\.mjs:7 {2}grows$/m)
  }),
)

test(
  'the base is the ref named, so --base HEAD measures no movement',
  probed(() => {
    const result = run('--base', 'HEAD', 'm.mjs')
    assert.match(result.stdout, /^! +10 +10 +0 +m\.mjs:7 {2}grows$/m)
  }),
)

test(
  '--changed without --base refuses',
  probed(() => {
    const result = run('--changed')
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /--changed needs --base/)
  }),
)

test(
  '--changed scores a grown .mjs file, which the lint rule covers',
  probed(() => {
    const result = run('--base', 'fixture-base', '--changed')
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /^! +10 +3 +\+7 +m\.mjs:7 {2}grows$/m)
  }),
)

test(
  '--changed leaves out the test and workflow files biome does not score',
  probed(() => {
    const result = run('--base', 'fixture-base', '--changed')
    assert.equal(result.status, 0, result.stderr)
    assert.doesNotMatch(result.stdout, /workflow|m\.test\.mjs|notes\.md/)
  }),
)

test(
  'a misspelled flag refuses with exit 2 and names the flag',
  probed(() => {
    const result = run('--base', 'fixture-base', '--chaged')
    assert.equal(result.status, 2, result.stdout)
    assert.match(result.stderr, /unknown option --chaged/)
    assert.doesNotMatch(result.stdout, /no files/)
  }),
)

test("--changed's scope is this repo's biome.json: scripts in, tests and workflow scripts out", () => {
  const linted = complexityScopeFrom(readFileSync(join(here, '..', '..', 'biome.json'), 'utf-8'))
  const scored = [
    'packages/mcp-server/scripts/dev/mcp-http-stdio-proxy.mjs',
    '.claude/scripts/complexity-of.mjs',
    'packages/mcp-server/src/server/app.ts',
    'apps/web/src/components/App.tsx',
  ]
  const unscored = [
    '.claude/scripts/complexity-of.test.mjs',
    '.claude/workflows/dev-loop.workflow.mjs',
    'apps/web/src/App.test.tsx',
    'packages/mcp-server/src/shared/test-utils/fast-check.ts',
    'packages/mcp-server/dist/index.mjs',
    'biome.json',
    'README.md',
  ]
  assert.deepEqual(
    scored.filter((f) => !linted(f)),
    [],
  )
  assert.deepEqual(unscored.filter(linted), [])
})
