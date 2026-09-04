// Lint-the-linter: the GritQL plugin (tools/biome-plugins/test-flake-shapes.grit)
// is config, and config regresses silently — a pattern edit that stops
// matching leaves `pnpm lint` green over the exact shapes it was built to
// catch. So a fixture pair pins both directions: the bad fixture must yield
// BOTH diagnostics, the good one none. Fixtures live under .claude/scripts/
// fixtures/, which biome.json's `!.claude/**` keeps out of the real lint run.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const REPO_ROOT = join(import.meta.dirname, '../..')
const FIXTURES = join(import.meta.dirname, 'fixtures/biome-plugin')

function lint(file) {
  const dir = mkdtempSync(join(tmpdir(), 'biome-plugin-guard-'))
  writeFileSync(
    join(dir, 'biome.json'),
    JSON.stringify({
      plugins: [join(REPO_ROOT, 'tools/biome-plugins/test-flake-shapes.grit')],
      formatter: { enabled: false },
      linter: { rules: { correctness: { noUnusedVariables: 'off' } } },
    }),
  )
  try {
    execFileSync(join(REPO_ROOT, 'node_modules/.bin/biome'), ['lint', '--config-path', dir, file], {
      encoding: 'utf8',
    })
    return ''
  } catch (err) {
    return `${err.stdout ?? ''}${err.stderr ?? ''}`
  }
}

test('the bad fixture trips BOTH rules', () => {
  const out = lint(join(FIXTURES, 'bad.test.tsx'))
  assert.match(out, /Side effect inside waitFor/)
  assert.match(out, /afterEach wipes document\.body/)
})

test('the good fixture trips neither rule', () => {
  const out = lint(join(FIXTURES, 'good.test.tsx'))
  assert.doesNotMatch(out, /Side effect inside waitFor|afterEach wipes/)
})
