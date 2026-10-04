// Run with: node --test .claude/workflows/lib/dependabot-load-bearing.test.mjs
//
// The dependabot-triage workflow's LOAD_BEARING list and the dependabot-review
// skill's table name the packages whose bumps get extra scrutiny. A name that no
// manifest depends on any more (a removed renderer, a replaced transport) makes
// the triage ask a model to weigh a package that is not there, and nothing else
// notices: the list is prose to every other guard. The workflow cannot import a
// helper (its sandbox has no module loader), so the list lives in the workflow
// and this test reads it from source.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const WORKFLOW = readFileSync(join(ROOT, '.claude/workflows/dependabot-triage.workflow.mjs'), 'utf8')
const SKILL = readFileSync(join(ROOT, '.claude/skills/dependabot-review/SKILL.md'), 'utf8')

const NPM_NAME = /^(?:@[a-z0-9-]+\/)?[a-z0-9][a-z0-9._-]*$/

function loadBearingNames(workflowSource) {
  const list = /const LOAD_BEARING = \[([^\]]*)\]/.exec(workflowSource)
  return [...(list?.[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1])
}

/** The backticked package names in the first column of the skill's load-bearing table. */
function tableNames(skillSource) {
  const section = /## Load-bearing runtime deps[\s\S]*?(?=\n## )/.exec(skillSource)?.[0] ?? ''
  return section
    .split('\n')
    .filter((line) => line.startsWith('| `'))
    .flatMap((line) => [...(line.split('|')[1] ?? '').matchAll(/`([^`]+)`/g)].map((m) => m[1]))
}

function runtimeDependencies() {
  const manifests = execFileSync('git', ['ls-files', '--', '*package.json'], {
    cwd: ROOT,
    encoding: 'utf8',
  })
    .split('\n')
    .filter((path) => path && !path.includes('/fixtures/') && !path.includes('node_modules'))
  const names = new Set()
  for (const path of manifests) {
    const manifest = JSON.parse(readFileSync(join(ROOT, path), 'utf8'))
    for (const name of Object.keys(manifest.dependencies ?? {})) names.add(name)
  }
  return names
}

const LOAD_BEARING = loadBearingNames(WORKFLOW)
const DEPENDENCIES = runtimeDependencies()

test('the scan reaches its subject: a real list and a real set of manifests', () => {
  assert.ok(LOAD_BEARING.length >= 10, `read ${LOAD_BEARING.length} names from LOAD_BEARING`)
  assert.ok(DEPENDENCIES.size > 50, `read ${DEPENDENCIES.size} runtime dependencies`)
  assert.ok(LOAD_BEARING.every((name) => NPM_NAME.test(name)))
})

test('every LOAD_BEARING name is a runtime dependency some workspace manifest declares', () => {
  const gone = LOAD_BEARING.filter((name) => !DEPENDENCIES.has(name))
  assert.deepEqual(gone, [], 'LOAD_BEARING names a package no manifest depends on')
})

test('the skill table names exactly the packages the workflow list does', () => {
  const table = new Set(tableNames(SKILL))
  assert.ok(table.size >= 10, `read ${table.size} names from the skill table`)
  assert.deepEqual(
    [...table].filter((name) => !LOAD_BEARING.includes(name)),
    [],
    'the skill table names a package missing from LOAD_BEARING',
  )
  assert.deepEqual(
    LOAD_BEARING.filter((name) => !table.has(name)),
    [],
    'LOAD_BEARING names a package missing from the skill table',
  )
})

test('the list readers parse their own fixtures', () => {
  assert.deepEqual(loadBearingNames("const LOAD_BEARING = [\n  'a', '@s/b',\n]"), ['a', '@s/b'])
  assert.deepEqual(
    tableNames('## Load-bearing runtime deps\n\n| P | W |\n|--|--|\n| `a` / `@s/b` | x |\n\n## Next'),
    ['a', '@s/b'],
  )
})
