// Lint-the-linter: the GritQL plugin (tools/biome-plugins/*.grit)
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

function lint(file, plugin = 'tools/biome-plugins/test-flake-shapes.grit') {
  const dir = mkdtempSync(join(tmpdir(), 'biome-plugin-guard-'))
  writeFileSync(
    join(dir, 'biome.json'),
    JSON.stringify({
      plugins: [join(REPO_ROOT, plugin)],
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

test('the bad fixture trips ALL FOUR rules', () => {
  const out = lint(join(FIXTURES, 'bad.test.tsx'))
  assert.match(out, /Side effect inside waitFor/)
  assert.match(out, /afterEach wipes document\.body/)
  assert.match(out, /vi\.useFakeTimers\(\) with no vi\.useRealTimers\(\)/)
  assert.match(out, /A focused test drops every other test/)
})

test('the good fixture trips none of the four rules', () => {
  const out = lint(join(FIXTURES, 'good.test.tsx'))
  assert.doesNotMatch(
    out,
    /Side effect inside waitFor|afterEach wipes|vi\.useFakeTimers\(\) with no vi\.useRealTimers\(\)|A focused test drops every other test/,
  )
})

// The non-ASCII keystroke rule is a browser-mode shape (jsdom synthesizes
// the same string deterministically), so it lives in a plugin biome.json
// scopes to *.browser.test.*. The bad fixture carries the four shapes it
// must catch — plain receiver, a setup() alias, a template literal, and
// type()'s second argument — because the receiver-bound form this replaced
// missed the alias, and the good fixture carries the remedy (fill) with the
// same non-ASCII text so a tightening edit cannot start flagging the fix.
const BROWSER_PLUGIN = 'tools/biome-plugins/browser-test-shapes.grit'

test('the bad browser fixture trips the non-ASCII keystroke rule on all four shapes', () => {
  const out = lint(join(FIXTURES, 'bad.browser.test.tsx'), BROWSER_PLUGIN)
  const hits = out.match(/Non-ASCII in a (?:keyboard|type)\(\) string/g) ?? []
  assert.equal(hits.length, 4, `expected all four shapes flagged, got ${hits.length}:\n${out}`)
})

test('the good browser fixture trips nothing — fill with non-ASCII text is the remedy, not a hit', () => {
  const out = lint(join(FIXTURES, 'good.browser.test.tsx'), BROWSER_PLUGIN)
  assert.doesNotMatch(out, /Non-ASCII in a/)
})

// The logger rule lives in its own plugin because its scope is the opposite
// of the flake shapes': production source under packages/mcp-server/src/
// server/**, never a test file. The good fixture carries the three shapes
// that must stay silent — fields-first, a bare message, and a real printf
// call — because the printf carve-out is the one a tightening edit would
// take out first.
const LOGGER_PLUGIN = 'tools/biome-plugins/logger-argument-order.grit'

test('the bad logger fixture trips the argument-order rule on every call', () => {
  const out = lint(join(FIXTURES, 'bad-logger.ts'), LOGGER_PLUGIN)
  const hits = out.match(/Message first, argument second/g) ?? []
  assert.equal(hits.length, 2, `expected both wrong calls flagged, got ${hits.length}`)
})

test('the good logger fixture trips nothing', () => {
  const out = lint(join(FIXTURES, 'good-logger.ts'), LOGGER_PLUGIN)
  assert.doesNotMatch(out, /Message first, argument second/)
})
