// Lint-the-linter: the GritQL plugins (tools/biome-plugins/*.grit) are
// config, and config regresses silently — a pattern edit that stops matching
// leaves `pnpm lint` green over the exact shapes it was built to catch. So a
// fixture pair pins both directions per plugin: the bad fixture must trip
// EVERY rule the plugin declares, the good one none. Fixtures live under
// .claude/scripts/fixtures/, which biome.json's `!.claude/**` keeps out of
// the real lint run.
//
// The set of rules is READ FROM EACH PLUGIN (every `register_diagnostic`
// message), never counted here: a title or an assertion carrying "all four
// rules" has to change on every rule added — and a test title is an
// identifier, which flake-watch and CI annotations key on. Adding a rule
// without a bad-fixture line for it fails this suite by itself, which is the
// property a hand-written list cannot have.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const REPO_ROOT = join(import.meta.dirname, '../..')
const FIXTURES = join(import.meta.dirname, 'fixtures/biome-plugin')

/**
 * Every plugin biome.json wires up, with the fixture pair that proves it
 * still matches. `browser-test-shapes` is separate because its shape is
 * browser-only (jsdom synthesizes the same string deterministically), and
 * `logger-argument-order`'s scope is the opposite of both: production source
 * under packages/mcp-server/src/server/**, never a test file.
 */
const PLUGINS = [
  {
    plugin: 'tools/biome-plugins/test-flake-shapes.grit',
    bad: 'bad.test.tsx',
    good: 'good.test.tsx',
  },
  {
    plugin: 'tools/biome-plugins/browser-test-shapes.grit',
    bad: 'bad.browser.test.tsx',
    good: 'good.browser.test.tsx',
  },
  {
    plugin: 'tools/biome-plugins/logger-argument-order.grit',
    bad: 'bad-logger.ts',
    good: 'good-logger.ts',
  },
]

function lint(file, plugin) {
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

/**
 * The distinct diagnostic messages a plugin can emit, read from its source.
 * Two patterns may share one message (the chronology rule covers the bare
 * and the `.skip`/`.only` call shapes), which is why this is a Set: the
 * fixture proves each MESSAGE reachable, not each pattern.
 */
function declaredMessages(plugin) {
  const source = readFileSync(join(REPO_ROOT, plugin), 'utf8')
  const messages = new Set(
    [...source.matchAll(/message\s*=\s*"((?:[^"\\]|\\.)*)"/g)].map((match) => match[1]),
  )
  assert.ok(
    messages.size > 0,
    `${plugin} declares no register_diagnostic message — the scan missed it`,
  )
  return messages
}

/** Biome prints a plugin diagnostic as `<file>:<line>:<col> plugin ━━`. */
const PLUGIN_DIAGNOSTIC = /^\S+:\d+:\d+ plugin /m

/** The first clause of a message is enough to recognise it in the output. */
function firstClause(message) {
  return message.split(/[.:]/)[0]
}

for (const { plugin, bad, good } of PLUGINS) {
  const name = plugin.split('/').pop()

  test(`${name}: the bad fixture trips every rule the plugin declares`, () => {
    const out = lint(join(FIXTURES, bad), plugin)
    const missing = [...declaredMessages(plugin)].filter((m) => !out.includes(firstClause(m)))
    assert.deepEqual(missing, [], `rules the bad fixture never reaches (add a line for each)`)
  })

  test(`${name}: the good fixture trips nothing`, () => {
    const out = lint(join(FIXTURES, good), plugin)
    assert.doesNotMatch(out, PLUGIN_DIAGNOSTIC, out)
  })
}

// Every plugin biome.json wires up has a fixture pair above. A plugin added
// to the config and not here would be unguarded, and its silent regression is
// exactly what this suite exists to prevent.
test('every plugin biome.json wires up is covered by a fixture pair', () => {
  const config = JSON.parse(readFileSync(join(REPO_ROOT, 'biome.json'), 'utf8'))
  const wired = (config.plugins ?? []).map((entry) =>
    (typeof entry === 'string' ? entry : entry.path).replace(/^\.\//, ''),
  )
  const covered = PLUGINS.map((p) => p.plugin)
  assert.deepEqual(
    wired.filter((p) => !covered.includes(p)),
    [],
    'plugins wired into biome.json with no fixture pair here',
  )
  assert.deepEqual(
    covered.filter((p) => !wired.includes(p)),
    [],
    'fixture pairs for plugins biome.json no longer wires up',
  )
})
