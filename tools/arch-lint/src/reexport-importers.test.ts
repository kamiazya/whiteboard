/**
 * A name a package entry re-exports has someone importing it through that
 * entry.
 *
 * Knip credits a re-export to its origin, so a barrel line forwarding a name
 * every importer takes from somewhere else is invisible to it as long as the
 * origin is used anywhere — and every field a contract retires leaves exactly
 * that behind. This scan reads each `exports` entry of a workspace manifest
 * that lands on a source file, lists what that file forwards (`export { x }
 * from`, and `export { x }` of an imported binding), and fails on a forwarded
 * name no file imports through the entry, by its package specifier or by a
 * relative path to the same file. Through a runtime entry only a SHIPPED
 * importer counts; a test-support entry (a `test-utils`/`testing` subpath)
 * exists for tests, so a test's import counts there.
 *
 * A namespace import counts the members read off it (`ns.x`). Otherwise it
 * errs toward false negatives: a shipped file reaching an entry wholesale — a
 * namespace passed around whole, `export * from`, a bare dynamic `import()` —
 * counts every name as used, and an import is matched by text, so a quoted
 * one in a comment counts. A TEST reaching it wholesale counts nothing: a
 * test walking a barrel's every export would otherwise excuse all of them.
 * `export *` in the entry itself is not judged, since it forwards no name.
 */
import { readFileSync } from 'node:fs'
import { dirname, join, normalize } from 'node:path'
import ts from '@typescript/typescript6'
import { describe, expect, it } from 'vitest'
import { importBindingsOf, parseSource } from './ast-helpers.js'
import { REPO_ROOT, type RepoSource, readRepoSources, readWorkspaceEntries } from './scan-roots.js'
import { isShippedPath, isTestPath } from './source-scan.js'

/**
 * Forwarded names with no importer, as `<entry path>#<name>`, each with why.
 * Shrink-only: an entry that gains an importer or goes away fails as stale.
 */
const UNIMPORTED: Readonly<Record<string, string>> = {
  'packages/server-core/src/index.ts#DocumentEngineTrapError':
    'debt: every user imports it from document-io.js inside the package; drop the re-export',
}

/**
 * Forwards from a RUNTIME entry that only tests import through it, as
 * `<entry path>#<name>`, each with why: `decision:` is kept on purpose,
 * `debt:` is a barrel line to drop once its tests import the origin.
 * Shrink-only, its size pinned by equality, so a retired contract's test
 * cannot add its forward here unnoticed.
 */
const TEST_ONLY_FORWARDS: Readonly<Record<string, string>> = {
  'packages/plugin-visual/src/index.ts#BUILT_IN_ICON_NAMES':
    "decision: the icon-name catalogue is part of the plugin's data surface; catalog.test.ts holds it to LUCIDE_ICONS",
  'packages/server-core/src/index.ts#apiErrorBodySchema':
    'decision: the strict refusal-body contract a daemon emits, published from the package root; the route fuzz holds every refusal to it',
}

/** The names a module forwards from another: `export { a, b as c } from`, and `export { x }` of an import of any form. */
function forwardedNames(path: string, text: string): string[] {
  const source = parseSource(path, text, false)
  const imported = new Set(importBindingsOf(source).map((binding) => binding.local))
  return source.statements.flatMap((statement) => {
    if (!ts.isExportDeclaration(statement)) return []
    const clause = statement.exportClause
    if (clause === undefined || !ts.isNamedExports(clause)) return []
    return clause.elements
      .filter(
        (element) =>
          statement.moduleSpecifier !== undefined ||
          imported.has((element.propertyName ?? element.name).text),
      )
      .map((element) => element.name.text)
  })
}

const NAMED =
  /(?:import|export)\s+(?:type\s+)?(?:[\w$]+\s*,\s*)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g
const DESTRUCTURED_DYNAMIC = /\{([^}]*)\}\s*=\s*await\s+import\(\s*['"]([^'"]+)['"]\s*\)/g
const NAMESPACE = /import\s+(?:type\s+)?\*\s+as\s+([\w$]+)\s+from\s*['"]([^'"]+)['"]/g
const WHOLESALE = [
  /export\s+(?:type\s+)?\*(?:\s+as\s+[\w$]+)?\s+from\s*['"]([^'"]+)['"]/g,
  /import\(\s*['"]([^'"]+)['"]\s*\)/g,
]

/** `a`, `type a`, `a as b` and `a: b` each name `a`. */
function bindingNames(list: string): string[] {
  return list
    .split(',')
    .map((part) =>
      part
        .trim()
        .replace(/^type\s+/, '')
        .split(/\s+as\s+|\s*:\s*/)[0]
        ?.trim(),
    )
    .filter((name): name is string => name !== undefined && /^[\w$]+$/.test(name))
}

/** The repo path a specifier written in `from` lands on, if it is relative. */
function relativeTarget(from: string, spec: string): string[] {
  if (!spec.startsWith('.')) return []
  const base = normalize(join(dirname(from), spec)).replaceAll('\\', '/')
  const stem = base.replace(/\.(?:js|mjs|ts|tsx)$/, '')
  return [base, `${stem}.ts`, `${stem}.tsx`, `${base}/index.ts`]
}

/**
 * For each entry file, the names imported through it, or `'*'` when something
 * takes it wholesale.
 *
 * A test's named import credits a runtime entry only when `countTests` is set:
 * the commonest survivor of a retired contract is the contract's own test, so
 * it cannot be what keeps the barrel line alive. An entry that is itself
 * test-support (a `test-utils`/`testing` subpath) exists for tests, and a
 * test's import always counts there.
 */
function importsByEntry(
  files: readonly RepoSource[],
  entries: ReadonlyMap<string, string>,
  countTests: boolean,
): Map<string, Set<string>> {
  const entryFiles = new Set(entries.values())
  const byEntry = new Map<string, Set<string>>()
  const land = (from: string, spec: string): string | undefined =>
    entries.get(spec) ?? relativeTarget(from, spec).find((path) => entryFiles.has(path))
  const add = (entry: string, name: string) => {
    const names = byEntry.get(entry) ?? new Set<string>()
    names.add(name)
    byEntry.set(entry, names)
  }
  for (const { path, text } of files) {
    const reach = (spec: string | undefined, names: readonly string[]) => {
      const entry = spec === undefined ? undefined : land(path, spec)
      if (entry === undefined || entry === path) return
      if (!countTests && isTestPath(path) && isShippedPath(entry)) return
      for (const name of names) add(entry, name)
    }
    for (const [, names, spec] of text.matchAll(NAMED)) reach(spec, bindingNames(names ?? ''))
    for (const [, names, spec] of text.matchAll(DESTRUCTURED_DYNAMIC)) {
      reach(spec, bindingNames(names ?? ''))
    }
    // A namespace is read by member; one passed around whole (a test walking
    // a barrel's exports, say) consumes every name only when it ships.
    for (const [, name, spec] of text.matchAll(NAMESPACE)) {
      const alias = (name ?? '').replaceAll('$', '\\$')
      const members = [...text.matchAll(new RegExp(`\\b${alias}\\.([\\w$]+)`, 'g'))]
      const bare = text.split(new RegExp(`\\b${alias}\\b(?!\\.)`)).length > 2
      reach(spec, [
        ...members.map(([, name]) => name ?? ''),
        ...(bare && !isTestPath(path) ? ['*'] : []),
      ])
    }
    if (isTestPath(path)) continue
    for (const pattern of WHOLESALE) {
      for (const [, spec] of text.matchAll(pattern)) reach(spec, ['*'])
    }
  }
  return byEntry
}

function unimportedForwards(countTests: boolean): string[] {
  const entries = readWorkspaceEntries()
  const files = readRepoSources()
  const imports = importsByEntry(files, entries, countTests)
  const text = new Map(files.map((file) => [file.path, file.text]))
  return [...new Set(entries.values())].sort().flatMap((entry) => {
    const used = imports.get(entry)
    if (used?.has('*') === true) return []
    const source = text.get(entry)
    if (source === undefined) return []
    return forwardedNames(entry, source)
      .filter((name) => used?.has(name) !== true)
      .map((name) => `${entry}#${name}`)
  })
}

describe('package entries forward only names someone imports through them', () => {
  it('finds no forwarded name without a shipped importer', () => {
    const offenders = unimportedForwards(false).filter(
      (key) => !(key in UNIMPORTED) && !(key in TEST_ONLY_FORWARDS),
    )
    expect(offenders).toEqual([])
  })

  it('keeps no unimported entry that has gained an importer or gone', () => {
    const current = new Set(unimportedForwards(true))
    expect(Object.keys(UNIMPORTED).filter((key) => !current.has(key))).toEqual([])
  })

  it('keeps no test-only entry that has gained a shipped importer, lost its tests, or gone', () => {
    const shippedLess = new Set(unimportedForwards(false))
    const importerLess = new Set(unimportedForwards(true))
    expect(
      Object.keys(TEST_ONLY_FORWARDS).filter(
        (key) => !shippedLess.has(key) || importerLess.has(key),
      ),
    ).toEqual([])
  })

  it('holds the test-only ledger at its size, so it only shrinks', () => {
    expect(Object.keys(TEST_ONLY_FORWARDS)).toHaveLength(2)
    for (const reason of Object.values(TEST_ONLY_FORWARDS)) {
      expect(reason).toMatch(/^(?:decision|debt): \S/)
    }
  })

  it('reaches the barrels it judges, so a clean scan is not a blind one', () => {
    const entries = readWorkspaceEntries()
    expect(entries.size).toBeGreaterThan(40)
    const barrel = 'packages/daemon-client/src/api-contracts/index.ts'
    const forwarded = forwardedNames(barrel, readFileSync(join(REPO_ROOT, barrel), 'utf8'))
    expect(forwarded).toContain('apiErrorReason')
    const used = importsByEntry(readRepoSources(), entries, false).get(barrel)
    expect(used?.has('apiErrorReason')).toBe(true)
    // A test walking the barrel whole must not excuse every name in it.
    expect(used?.has('*')).toBe(false)
  })

  it('reads both forwarding forms, and every import form that takes a name', () => {
    expect(
      forwardedNames(
        'a.ts',
        "import { x, y } from './x.js'\nconst z = 1\nexport { x, z }\nexport { a as b, type c } from './a.js'",
      ),
    ).toEqual(['x', 'b', 'c'])
    expect(
      forwardedNames(
        'a.ts',
        "import D from './d.js'\nimport * as ns from './n.js'\nexport { D, ns as space }",
      ),
    ).toEqual(['D', 'space'])
    const entries = new Map([['@s/p', 'p/index.ts']])
    // Assembled, so the lazy-import scan does not read this fixture as a test's own import.
    const dynamicImport = ['await import', "('@s/p')"].join('')
    const found = importsByEntry(
      [
        { path: 'q.ts', text: "import D, { type a, b as c } from '@s/p'" },
        { path: 'p/t.ts', text: "export { e } from './index.js'" },
      ],
      entries,
      true,
    ).get('p/index.ts')
    expect([...(found ?? [])].sort()).toEqual(['a', 'b', 'e'])
    expect(
      importsByEntry([{ path: 'r.ts', text: dynamicImport }], entries, true).get('p/index.ts'),
    ).toEqual(new Set(['*']))
    const namespaced = (path: string) =>
      importsByEntry(
        [{ path, text: "import * as ns from '@s/p'\nns.f()\nObject.keys(ns)" }],
        entries,
        true,
      ).get('p/index.ts')
    expect(namespaced('s.ts')).toEqual(new Set(['f', '*']))
    expect(namespaced('s.test.ts')).toEqual(new Set(['f']))
  })

  it('credits a runtime entry only to shipped importers, a test-support entry to tests too', () => {
    const entries = new Map([
      ['@s/p', 'p/src/index.ts'],
      ['@s/p/test-utils', 'p/src/test-utils/index.ts'],
    ])
    const files = [
      { path: 'q.test.ts', text: "import { a } from '@s/p'\nimport { t } from '@s/p/test-utils'" },
      { path: 'q/fixtures/seed.ts', text: "import { b } from '@s/p'" },
      { path: 'q.ts', text: "import { c } from '@s/p'" },
    ]
    const shipped = importsByEntry(files, entries, false)
    expect(shipped.get('p/src/index.ts')).toEqual(new Set(['c']))
    expect(shipped.get('p/src/test-utils/index.ts')).toEqual(new Set(['t']))
    expect(importsByEntry(files, entries, true).get('p/src/index.ts')).toEqual(
      new Set(['a', 'b', 'c']),
    )
  })
})
