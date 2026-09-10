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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
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
    probe: 'packages/mcp-server/src/server/biome-plugin-scope-probe.ts',
  },
  {
    plugin: 'tools/biome-plugins/route-refusal-shapes.grit',
    bad: 'bad-route-refusal.ts',
    good: 'good-route-refusal.ts',
    probe: 'packages/mcp-server/src/server/routes/biome-plugin-scope-probe.ts',
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

/**
 * A plugin's `includes` patterns, as biome.json declares them.
 *
 * `entry.includes` is optional: a plugin registered as a bare path string
 * applies everywhere, which needs no shape check.
 */
function declaredIncludes(entry) {
  return typeof entry === 'string' ? [] : (entry.includes ?? [])
}

// A pattern that does not start with `**` matches NOTHING, and biome says so
// nowhere — the plugin is registered, `pnpm lint` is green, and the rule has
// never run.
//
// That is not a hypothesis. `logger-argument-order` shipped with
// `packages/mcp-server/src/server/[**]/[*].ts` and had never fired; measured on
// one real violating file under that exact directory, with only the pattern
// changed between runs (globs written with [] around each wildcard segment
// here, since a literal one would close this comment):
//
//   packages/mcp-server/src/server/[**]/[*].ts   -> 0 diagnostics
//   [**]/packages/mcp-server/src/server/[**]/[*].ts -> 1
//   [**]/mcp-server/src/server/[**]/[*].ts        -> 1
//   [**]/src/server/[**]/[*].ts                  -> 1
//
// The fixture pairs above could not catch it: they lint through a config
// that carries the plugin and no `includes` at all, so they prove the RULES
// match and say nothing about the SCOPE.
test('every plugin include pattern is anchored so it can match at all', () => {
  const config = JSON.parse(readFileSync(join(REPO_ROOT, 'biome.json'), 'utf8'))
  const unanchored = (config.plugins ?? []).flatMap((entry) =>
    declaredIncludes(entry)
      .filter((pattern) => !pattern.startsWith('!'))
      .filter((pattern) => !pattern.startsWith('**'))
      .map((pattern) => `${typeof entry === 'string' ? entry : entry.path}: ${pattern}`),
  )
  assert.deepEqual(
    unanchored,
    [],
    'a plugin include pattern not starting with ** matches no file, and biome reports nothing — prefix it with **/',
  )
})

// The empirical half, for the plugins whose scope is a PATH rather than a
// filename suffix: write the bad fixture at a real path inside the declared
// scope and lint it through the repo's own config. A suffix-scoped plugin
// (`**/*.test.ts`) has no probe because the only paths matching its scope are
// test files, and a `.test.ts` appearing in the tree for the length of one
// lint is collectable by a vitest run happening at the same moment. The probe
// files below are plain `.ts`, which nothing collects.
for (const { plugin, bad, probe } of PLUGINS.filter((entry) => entry.probe !== undefined)) {
  const name = plugin.split('/').pop()

  test(`${name}: the repo's own config applies it inside its declared scope`, () => {
    const target = join(REPO_ROOT, probe)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, readFileSync(join(FIXTURES, bad), 'utf8'))
    try {
      let out = ''
      try {
        execFileSync(join(REPO_ROOT, 'node_modules/.bin/biome'), ['lint', probe], {
          cwd: REPO_ROOT,
          encoding: 'utf8',
        })
      } catch (err) {
        out = `${err.stdout ?? ''}${err.stderr ?? ''}`
      }
      assert.match(
        out,
        PLUGIN_DIAGNOSTIC,
        `biome.json registers ${plugin} but it produced no diagnostic on ${probe}, which its own includes claim to cover. Check the include pattern is anchored with **/.`,
      )
    } finally {
      rmSync(target, { force: true })
    }
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
