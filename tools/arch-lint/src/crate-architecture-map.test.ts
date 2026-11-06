import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ARCHITECTURE_MAP } from './architecture-map.js'
import { type CrateEntry, parseCrateMap, readCrateMap } from './crate-map.js'
import { crateDirs } from './rust-source.js'
import { REPO_ROOT } from './scan-roots.js'

// `crates/architecture-map.json` is the crate half of the architecture map:
// every crate of the target graph, planned ones included, so dependency
// direction is fixed before any code exists. `cargo xtask arch-map` holds the
// WORKSPACE to it (members, layers, edges). What it cannot see from cargo is
// the rest of this repo, and that is what is checked here: the tree under
// `crates/` against the map's `status`, the map's `absorbs` against the
// TypeScript map it is replacing, and the crates rule's table against the
// map. A crate directory nothing lists, or a listed
// crate whose status lies, reads in every other guard as a smaller workspace.

/** The `name` in a crate manifest's `[package]` table. */
function packageName(manifest: string): string | undefined {
  const table = /^\[package\]\s*$([\s\S]*?)(?=^\[|(?![\s\S]))/m.exec(manifest)?.[1] ?? ''
  return /^name\s*=\s*"([^"]+)"/m.exec(table)?.[1]
}

/**
 * Every disagreement between the map's crates and the crate directories on
 * disk: a present crate with no manifest, a planned one that has one, a
 * manifest no entry lists, and a manifest whose package name is not the
 * entry's.
 */
function treeDisagreements(
  crates: readonly CrateEntry[],
  manifests: ReadonlyMap<string, string>,
): string[] {
  const byPath = new Map(crates.map((crate) => [crate.path, crate]))
  const found: string[] = []
  for (const crate of crates) {
    const manifest = manifests.get(crate.path)
    if (crate.status === 'present' && manifest === undefined) {
      found.push(`${crate.name}: present, but ${crate.path}/Cargo.toml does not exist`)
    }
    if (crate.status === 'planned' && manifest !== undefined) {
      found.push(`${crate.name}: planned, but ${crate.path}/Cargo.toml exists — mark it present`)
    }
    if (manifest !== undefined && packageName(manifest) !== crate.name) {
      found.push(
        `${crate.path}/Cargo.toml: package ${packageName(manifest)}, map says ${crate.name}`,
      )
    }
  }
  for (const dir of manifests.keys()) {
    if (!byPath.has(dir)) found.push(`${dir}/Cargo.toml: a crate the map does not list`)
  }
  return found
}

/**
 * TypeScript paths an `absorbs` entry may name that are not packages yet,
 * each with why. Guarded from both sides below.
 */
const ABSORBED_BEFORE_IT_EXISTS: Readonly<Record<string, string>> = {
  'packages/core-wasm':
    'the TypeScript shim over the wasm artifact, created when the first core crate ships through it',
}

/** The repo path an `absorbs` entry starts with; the rest of the entry is prose qualifying it. */
const absorbedPath = (entry: string): string => entry.split(' ')[0] ?? ''

/**
 * Every `absorbs` path that names nothing in the TypeScript map: a package
 * directory whose manifest name `ARCHITECTURE_MAP` has no entry for, or a
 * path inside one that does not exist.
 */
function absorbDisagreements(
  crates: readonly CrateEntry[],
  packageNameAt: (dir: string) => string | undefined,
  pathExists: (path: string) => boolean,
  mapped: ReadonlySet<string>,
): string[] {
  return crates.flatMap((crate) =>
    crate.absorbs.flatMap((entry) => {
      const path = absorbedPath(entry)
      if (path in ABSORBED_BEFORE_IT_EXISTS) return []
      const dir = /^(?:packages|apps)\/[^/]+/.exec(path)?.[0]
      if (dir === undefined) return [`${crate.name}: absorbs ${path}, which is no package path`]
      const name = packageNameAt(dir)
      if (name === undefined || !mapped.has(name)) {
        return [
          `${crate.name}: absorbs ${dir}, which the TypeScript architecture map does not list`,
        ]
      }
      return pathExists(path) ? [] : [`${crate.name}: absorbs ${path}, which does not exist`]
    }),
  )
}

/**
 * The crate rows of `.claude/rules/crates.md` (the path-scoped rule for the
 * Rust workspace; the always-on map stays within its budget): a
 * table row whose first cell is a backticked crate name or `crates/` path.
 * `undefined` while the rule names no crate at all — the state before the
 * integrator adds the table. A rule that MENTIONS a crate without such a row
 * answers an empty list, so a table written in another shape fails rather
 * than reading as "not yet".
 */
function ruleCrateRows(rule: string, crates: readonly CrateEntry[]): readonly string[] | undefined {
  const names = new Set(crates.map((crate) => crate.name))
  const mentions =
    rule.includes('crates/') ||
    [...names].some((name) => new RegExp(`(?<![\\w@/-])${name}(?![\\w-])`).test(rule))
  if (!mentions) return undefined
  const byPath = new Map(crates.map((crate) => [crate.path, crate.name]))
  return [...rule.matchAll(/^\|\s*`([^`]+)`\s*\|/gm)].flatMap((match) => {
    const cell = (match[1] ?? '').replace(/\/$/, '')
    if (names.has(cell)) return [cell]
    const named = byPath.get(cell)
    if (named !== undefined) return [named]
    return cell.startsWith('crates/') ? [cell] : []
  })
}

/** What a crate table gets wrong against the map: a crate missing, unknown, or listed twice. */
function ruleTableDisagreements(rows: readonly string[], crates: readonly CrateEntry[]): string[] {
  const names = crates.map((crate) => crate.name)
  const listed = new Set(rows)
  return [
    ...names.filter((name) => !listed.has(name)).map((name) => `${name}: no row in the rule`),
    ...rows
      .filter((row) => !names.includes(row))
      .map((row) => `${row}: a row the map does not list`),
    ...rows.filter((row, index) => rows.indexOf(row) !== index).map((row) => `${row}: two rows`),
  ]
}

const CRATES = readCrateMap()
const MANIFESTS = new Map(
  crateDirs().map((dir) => [dir, readFileSync(join(REPO_ROOT, dir, 'Cargo.toml'), 'utf8')]),
)
const RULE_PATH = '.claude/rules/crates.md'

const workspacePackageName = (dir: string): string | undefined => {
  const manifest = join(REPO_ROOT, dir, 'package.json')
  if (!existsSync(manifest)) return undefined
  return (JSON.parse(readFileSync(manifest, 'utf8')) as { name?: string }).name
}

const entry = (name: string, path: string, status: 'present' | 'planned'): CrateEntry => ({
  name,
  path,
  status,
  allowedInternalDeps: [],
  absorbs: [],
})

describe('crates/architecture-map.json agrees with the tree under crates/', () => {
  it('reads the map and the crates this repo has', () => {
    // A map or a walk that came back empty would agree with anything.
    expect(CRATES.length).toBeGreaterThan(20)
    expect(CRATES.filter((crate) => crate.status === 'present').length).toBeGreaterThan(4)
    expect(MANIFESTS.size).toBeGreaterThan(4)
    expect(MANIFESTS.has('crates/xtask')).toBe(true)
  })

  it('has a manifest for every present crate, none for a planned one, and no unlisted one', () => {
    expect(treeDisagreements(CRATES, MANIFESTS)).toEqual([])
  })

  it('flags each way the map and the tree can disagree', () => {
    const manifest = (name: string) => `[package]\nname = "${name}"\n\n[lints]\nworkspace = true\n`
    const crates = [
      entry('a', 'crates/core/a', 'present'),
      entry('b', 'crates/core/b', 'planned'),
      entry('c', 'crates/core/c', 'present'),
    ]
    const tree = new Map([
      ['crates/core/b', manifest('b')],
      ['crates/core/c', manifest('not-c')],
      ['crates/core/d', manifest('d')],
    ])
    expect(treeDisagreements(crates, tree)).toEqual([
      'a: present, but crates/core/a/Cargo.toml does not exist',
      'b: planned, but crates/core/b/Cargo.toml exists — mark it present',
      'crates/core/c/Cargo.toml: package not-c, map says c',
      'crates/core/d/Cargo.toml: a crate the map does not list',
    ])
    expect(
      treeDisagreements(crates.slice(0, 1), new Map([['crates/core/a', manifest('a')]])),
    ).toEqual([])
  })

  it('reads a malformed map as an error naming the field, not as an empty one', () => {
    expect(() => parseCrateMap('{"crates":{"x":{"path":1}}}')).toThrow(/x: `path`/)
    expect(() => parseCrateMap('{"layers":{}}')).toThrow(/no `crates`/)
  })
})

describe('what a crate absorbs is a package the TypeScript architecture map lists', () => {
  const mapped = new Set(Object.keys(ARCHITECTURE_MAP))
  const exists = (path: string) => existsSync(join(REPO_ROOT, path))

  it('names only mapped packages, and paths inside them that exist', () => {
    expect(CRATES.flatMap((crate) => crate.absorbs).length).toBeGreaterThan(15)
    expect(absorbDisagreements(CRATES, workspacePackageName, exists, mapped)).toEqual([])
  })

  it('flags an unmapped package, a gone path and a non-package path', () => {
    const absorbing = (...absorbs: string[]): CrateEntry => ({
      ...entry('x', 'crates/core/x', 'planned'),
      absorbs,
    })
    expect(
      absorbDisagreements(
        [
          absorbing(
            'packages/model',
            'packages/unmapped (all of it)',
            'packages/model/src/gone.ts',
            'docs/x',
          ),
        ],
        (dir) => (dir === 'packages/model' ? '@kamiazya/whiteboard-model' : undefined),
        (path) => path === 'packages/model',
        mapped,
      ),
    ).toEqual([
      'x: absorbs packages/unmapped, which the TypeScript architecture map does not list',
      'x: absorbs packages/model/src/gone.ts, which does not exist',
      'x: absorbs docs/x, which is no package path',
    ])
  })

  it('holds no not-yet-a-package entry for a path that is a package now or that nothing absorbs', () => {
    const absorbed = new Set(CRATES.flatMap((crate) => crate.absorbs.map(absorbedPath)))
    const stale = Object.keys(ABSORBED_BEFORE_IT_EXISTS).filter(
      (path) => !absorbed.has(path) || workspacePackageName(path) !== undefined,
    )
    expect(stale).toEqual([])
  })
})

describe(`${RULE_PATH} and the crate map`, () => {
  const rule = readFileSync(join(REPO_ROOT, RULE_PATH), 'utf8')

  // Pending by design, not skipped: while the rule names no crate this
  // asserts exactly that, and the first edit that adds one — a table row, or
  // a sentence naming a crate — switches it to requiring a crate table that
  // lists every crate in the map, once each. The shape it expects is a table
  // whose first cell is the backticked crate name or `crates/` path.
  it('names no crate yet, or has a crate table listing exactly the crate map', () => {
    const rows = ruleCrateRows(rule, CRATES)
    if (rows === undefined) {
      expect(rule).not.toContain('crates/')
      return
    }
    expect(ruleTableDisagreements(rows, CRATES)).toEqual([])
  })

  it('stops being pending the moment a rule names a crate', () => {
    const named = ruleCrateRows('The Rust half is `crates/`.\n', CRATES)
    expect(named).toEqual([])
    expect(ruleTableDisagreements(named ?? [], CRATES)).toHaveLength(CRATES.length)
  })

  it('has the table now, naming every crate once', () => {
    const rows = ruleCrateRows(rule, CRATES)
    expect(rows, 'the rule must name the crates').toBeDefined()
    expect(rows?.length).toBe(CRATES.length)
  })

  it('reads a crate table by name or path, and a mention without one as a table missing', () => {
    const crates = [entry('a', 'crates/core/a', 'present'), entry('b', 'crates/core/b', 'planned')]
    expect(ruleCrateRows('| `packages/model` | zod |', crates)).toBeUndefined()
    // A crate's name inside an npm package name is not a mention of the crate.
    expect(ruleCrateRows('no `@kamiazya/a` import, nor `x-a`', crates)).toBeUndefined()
    const table = '| crate |\n|---|\n| `a` | core |\n| `crates/core/b/` | core |\n'
    expect(ruleCrateRows(table, crates)).toEqual(['a', 'b'])
    expect(ruleTableDisagreements(['a', 'b'], crates)).toEqual([])
    expect(ruleCrateRows('The `a` crate is pure.', crates)).toEqual([])
    expect(ruleTableDisagreements([], crates)).toEqual([
      'a: no row in the rule',
      'b: no row in the rule',
    ])
    expect(ruleTableDisagreements(['a', 'a', 'crates/core/z'], crates)).toEqual([
      'b: no row in the rule',
      'crates/core/z: a row the map does not list',
      'a: two rows',
    ])
  })
})
