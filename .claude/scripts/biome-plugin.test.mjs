// Lint-the-linter: the GritQL plugins (tools/biome-plugins/*.grit) are
// config, and config regresses silently — a pattern edit that stops matching
// leaves `pnpm lint` green over the exact shapes it was built to catch. So a
// fixture pair pins both directions: the bad fixture must trip EVERY rule the
// plugin declares, the good one none. Fixtures live under .claude/scripts/
// fixtures/, which biome.json's `!.claude/**` keeps out of the real lint run.
//
// The set of rules is READ FROM THE PLUGIN (every `register_diagnostic`
// message), never counted here: a title or an assertion carrying "all five
// rules" has to change on every rule added, and a title is an identifier —
// flake-watch and CI annotations key on it. Adding a rule without a bad-
// fixture line for it fails this suite by itself.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const REPO_ROOT = join(import.meta.dirname, '../..')
const FIXTURES = join(import.meta.dirname, 'fixtures/biome-plugin')
const FLAKE_PLUGIN = 'tools/biome-plugins/test-flake-shapes.grit'
const LOGGER_PLUGIN = 'tools/biome-plugins/logger-argument-order.grit'

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
  const messages = new Set([...source.matchAll(/message\s*=\s*"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]))
  assert.ok(messages.size > 0, `${plugin} declares no register_diagnostic message — the scan missed it`)
  return messages
}

/** Biome prints a plugin diagnostic as `<file>:<line>:<col> plugin ━━`. */
const PLUGIN_DIAGNOSTIC = /^\S+:\d+:\d+ plugin /m

/** The first line of a message is enough to recognise it in the output. */
function firstLine(message) {
  return message.split(/[.:]/)[0]
}

test('the bad fixture trips every rule the flake-shapes plugin declares', () => {
  const out = lint(join(FIXTURES, 'bad.test.tsx'), FLAKE_PLUGIN)
  const missing = [...declaredMessages(FLAKE_PLUGIN)].filter((m) => !out.includes(firstLine(m)))
  assert.deepEqual(missing, [], 'rules the bad fixture never reaches (add a line for each)')
})

test('the good fixture trips no flake-shapes rule', () => {
  const out = lint(join(FIXTURES, 'good.test.tsx'), FLAKE_PLUGIN)
  assert.doesNotMatch(out, PLUGIN_DIAGNOSTIC, out)
})

// The logger rule lives in its own plugin because its scope is the opposite
// of the flake shapes': production source under packages/mcp-server/src/
// server/**, never a test file. The good fixture carries the three shapes
// that must stay silent — fields-first, a bare message, and a real printf
// call — because the printf carve-out is the one a tightening edit would
// take out first.
test('the bad logger fixture trips the argument-order rule on every wrong call', () => {
  const out = lint(join(FIXTURES, 'bad-logger.ts'), LOGGER_PLUGIN)
  const wrongCalls = readFileSync(join(FIXTURES, 'bad-logger.ts'), 'utf8').match(/^\s*log\.\w+\('/gm) ?? []
  const hits = out.match(/Message first, argument second/g) ?? []
  assert.ok(wrongCalls.length > 0, 'the fixture holds no message-first call — the scan missed it')
  assert.equal(hits.length, wrongCalls.length, `expected every wrong call flagged, got ${hits.length}`)
})

test('the good logger fixture trips nothing', () => {
  const out = lint(join(FIXTURES, 'good-logger.ts'), LOGGER_PLUGIN)
  assert.doesNotMatch(out, PLUGIN_DIAGNOSTIC, out)
})
