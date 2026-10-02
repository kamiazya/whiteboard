import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import ts from '@typescript/typescript6'
import { describe, expect, it } from 'vitest'
import { checkAllowedDependencies } from './allowed-deps-check.js'
import {
  ARCHITECTURE_MAP,
  allowedDependencies,
  exemptedBoundaryViolationKinds,
  KNOWN_IMPORT_CYCLES,
  KNOWN_TYPE_CYCLES,
} from './architecture-map.js'
import { buildValueImportGraph, findImportCycles } from './cycle-check.js'
import { checkDependencyDirection, type PackageManifest } from './direction-check.js'
import { COMPOSITION_ROOTS, listTsFiles, SHARED_LAYER_PACKAGES } from './scan-packages.js'
import { REPO_ROOT } from './scan-roots.js'
import {
  type BoundaryViolationKind,
  collectModuleSpecifiers,
  scanSourceForBoundaryViolations,
} from './scanner.js'
import { findTypeOnlyCycles } from './type-cycle-check.js'

const ARCHITECTURE_MAP_DOC = join(REPO_ROOT, '.claude', 'rules', 'architecture-map.md')
/**
 * Scope of the circular-value-import check: every scanned package's `src`,
 * both composition roots included. `apps/web/src` was excluded while a
 * concurrent session owned files under it; it is in now, and was verified
 * cycle-free when added.
 *
 * Including it is not the pure one-line inclusion it looks like, which is
 * the part worth knowing. `apps/web` writes 115 of its 554 intra-package
 * value edges as `@/...` — a fifth — and the resolver followed only `./`
 * and `../`. Adding the directory alone would have scanned it through a
 * graph missing those edges and reported a clean result from a picture it
 * could not see. `CYCLE_SCAN_ALIASES` is what closes that, and
 * `cycle-check.test.ts` pins a cycle that exists ONLY through an alias so
 * the capability cannot be dropped silently.
 */
const CYCLE_SCAN_PACKAGES = [...SHARED_LAYER_PACKAGES, 'packages/mcp-server', 'apps/web']
const CYCLE_SCAN_DIRS = CYCLE_SCAN_PACKAGES.map((packageDir) => join(REPO_ROOT, packageDir, 'src'))

/**
 * No scanned package declares a path alias any more — apps/web's `@/` was
 * retired with its mechanism (tsconfig paths + vite/vitest aliases deleted),
 * so a reintroduced `@/` import fails to RESOLVE before any scan sees it.
 * The map stays because the alias-following capability is pinned by
 * cycle-check.test.ts with its own fixture: a package that adds an alias
 * must declare it here or its edges silently leave the cycle graph.
 *
 * That last sentence used to be prose alone, which is the weakest place for
 * a rule whose whole symptom is a scan reporting a clean result over a graph
 * it could not see. `path aliases the cycle scan has to be told about`, below,
 * is the executable half.
 */
const CYCLE_SCAN_ALIASES = {} as const

describe('composition-root dependency direction', () => {
  const readManifest = (packageDir: string): PackageManifest =>
    JSON.parse(readFileSync(join(REPO_ROOT, packageDir, 'package.json'), 'utf-8'))
  const workspaceDeclarations = (manifest: PackageManifest): string[] =>
    [
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.devDependencies ?? {}),
    ].filter((name) => name in ARCHITECTURE_MAP)

  for (const packageDir of COMPOSITION_ROOTS) {
    // devDependencies count: mcp-server bundles every workspace package it
    // uses (tsdown `noExternal`) and declares them all there, so a check over
    // `dependencies` alone never saw a single one of its edges.
    it(`${packageDir}/package.json dependency direction is clean, devDependencies included`, () => {
      expect(
        checkDependencyDirection(readManifest(packageDir), { includeDevDependencies: true }),
      ).toHaveLength(0)
    })

    // The other half of the ledger: an allowance no manifest declares is a
    // door left open for the next dependency to walk through unannounced.
    it(`${packageDir} allows exactly the workspace packages its manifest declares`, () => {
      const manifest = readManifest(packageDir)
      const allowed = [...allowedDependencies(manifest.name)].sort()
      expect(allowed.length, 'a composition root must be in ARCHITECTURE_MAP').toBeGreaterThan(0)
      expect(workspaceDeclarations(manifest).sort()).toEqual(allowed)
    })

    it(`${packageDir} depends on no other composition root`, () => {
      const manifest = readManifest(packageDir)
      const otherRoots = COMPOSITION_ROOTS.filter((other) => other !== packageDir).map(
        (other) => readManifest(other).name,
      )
      const declared = new Set([
        ...Object.keys(manifest.dependencies ?? {}),
        ...Object.keys(manifest.devDependencies ?? {}),
      ])
      expect(otherRoots.filter((name) => declared.has(name))).toEqual([])
      expect(
        otherRoots.filter((name) => allowedDependencies(manifest.name).includes(name)),
      ).toEqual([])
    })
  }
})

/** `file`'s path under `srcDir`, `/`-separated — the key `exemptBoundaryFiles` uses. */
const inSrc = (srcDir: string, file: string): string => relative(srcDir, file).split(sep).join('/')

const TSX_BANNED_KINDS: ReadonlySet<BoundaryViolationKind> = new Set([
  'node-builtin-import',
  'inversify-import',
])

describe('shared-layer boundary lint (real source coverage)', () => {
  // A walk that finds no `.tsx` reports every package clean over nothing.
  it('finds the .tsx files the import scan is meant to read', () => {
    const tsxFiles = SHARED_LAYER_PACKAGES.flatMap((packageDir) =>
      listTsFiles(join(REPO_ROOT, packageDir, 'src'), ['.tsx']),
    )
    expect(tsxFiles.length, 'the .tsx walk found almost nothing').toBeGreaterThanOrEqual(6)
  })

  for (const packageDir of SHARED_LAYER_PACKAGES) {
    it(`${packageDir}/src has zero boundary violations`, () => {
      const manifest = JSON.parse(
        readFileSync(join(REPO_ROOT, packageDir, 'package.json'), 'utf-8'),
      )
      // A violation kind is a legitimate exemption ONLY for packages
      // architecture-map.ts explicitly lists it for — never an implicit "it's
      // used here, so allow it" heuristic, so an unmapped package still fails
      // loudly.
      const srcDir = join(REPO_ROOT, packageDir, 'src')
      const files = listTsFiles(srcDir)
      expect(files.length).toBeGreaterThan(0)

      for (const file of files) {
        // A kind exempt for ONE file (`exemptBoundaryFiles`) is looked up per file.
        const exemptKinds = exemptedBoundaryViolationKinds(manifest.name, inSrc(srcDir, file))
        const allViolations = scanSourceForBoundaryViolations(file, readFileSync(file, 'utf-8'))
        const violations = allViolations.filter((v) => !exemptKinds.has(v.kind))
        expect(violations, `${file}: ${JSON.stringify(violations)}`).toHaveLength(0)
      }
    })

    // `.tsx` is scanned for the two import kinds only: a component legitimately
    // reaches for `window`/`document`, but a `node:*` or `inversify` import in
    // one breaks the browser and the Worker exactly as it does in a `.ts`.
    it(`${packageDir}/src .tsx files import no node builtin and no inversify`, () => {
      const manifest = JSON.parse(
        readFileSync(join(REPO_ROOT, packageDir, 'package.json'), 'utf-8'),
      )
      const exemptKinds = exemptedBoundaryViolationKinds(manifest.name)
      for (const file of listTsFiles(join(REPO_ROOT, packageDir, 'src'), ['.tsx'])) {
        const violations = scanSourceForBoundaryViolations(
          file,
          readFileSync(file, 'utf-8'),
        ).filter((v) => TSX_BANNED_KINDS.has(v.kind) && !exemptKinds.has(v.kind))
        expect(violations, `${file}: ${JSON.stringify(violations)}`).toHaveLength(0)
      }
    })

    it(`${packageDir}/package.json dependency direction is clean`, () => {
      const manifest = JSON.parse(
        readFileSync(join(REPO_ROOT, packageDir, 'package.json'), 'utf-8'),
      )
      const violations = checkDependencyDirection(manifest)
      expect(violations).toHaveLength(0)
    })

    it(`${packageDir}/package.json declares every third-party dependency it uses`, () => {
      const manifest = JSON.parse(
        readFileSync(join(REPO_ROOT, packageDir, 'package.json'), 'utf-8'),
      )
      const violations = checkAllowedDependencies(manifest)
      // The message names the criterion and the fix. Read as a bare
      // "unlisted dependency" this check teaches that the shared layer is
      // closed, which it is not — the bar is that a dependency runs unchanged
      // on Node, the browser and Workers and does not break the published
      // build, and the list records the ones checked against it.
      expect(
        violations,
        violations.length === 0
          ? ''
          : `${violations.map((v) => v.dependencyName).join(', ')} is not recorded in ` +
              `allowedThirdParty for ${manifest.name}. If it runs unchanged on Node, the ` +
              'browser and Workers and does not break the published build, add it to ' +
              'architecture-map.ts with a note saying what you checked — that is the fix, ' +
              'not a workaround. If it does not (BudouX drags in linkedom and the native ' +
              'canvas package), vendor it or keep it out of the shared layer.',
      ).toHaveLength(0)
    })
  }
})

describe('circular value-import check (real source coverage)', () => {
  const files = CYCLE_SCAN_DIRS.flatMap((dir) =>
    listTsFiles(dir, ['.ts', '.tsx']).map((path) => ({
      path: relative(REPO_ROOT, path),
      text: readFileSync(path, 'utf-8'),
    })),
  )
  const cycles = findImportCycles(buildValueImportGraph(files, CYCLE_SCAN_ALIASES))
  const knownKeys = new Set(KNOWN_IMPORT_CYCLES.map((group) => [...group].sort().join('|')))
  const foundKeys = new Set(cycles.map((group) => group.join('|')))

  it('reports no value-import cycle outside KNOWN_IMPORT_CYCLES', () => {
    const unlisted = cycles.filter((group) => !knownKeys.has(group.join('|')))
    expect(unlisted, JSON.stringify(unlisted, null, 2)).toHaveLength(0)
  })

  // The allowlist is bounded above by reality on both sides: this catches a
  // stale entry (renamed/fixed file, no longer detected) so it cannot
  // silently keep exempting nothing, same as the assertion above catches a
  // new cycle appearing.
  it('every KNOWN_IMPORT_CYCLES entry is still an actually-detected cycle', () => {
    const stale = [...knownKeys].filter((key) => !foundKeys.has(key))
    expect(stale, JSON.stringify(stale)).toHaveLength(0)
  })
})

describe('type-inclusive import-cycle check (real source coverage)', () => {
  const files = CYCLE_SCAN_DIRS.flatMap((dir) =>
    listTsFiles(dir, ['.ts', '.tsx']).map((path) => ({
      path: relative(REPO_ROOT, path),
      text: readFileSync(path, 'utf-8'),
    })),
  )
  const cycles = findTypeOnlyCycles(files, CYCLE_SCAN_ALIASES)
  const knownKeys = new Set(KNOWN_TYPE_CYCLES.map(({ members }) => [...members].sort().join('|')))
  const foundKeys = new Set(cycles.map((group) => group.join('|')))

  it('reports no type-only import cycle outside KNOWN_TYPE_CYCLES', () => {
    const unlisted = cycles.filter((group) => !knownKeys.has(group.join('|')))
    expect(unlisted, JSON.stringify(unlisted, null, 2)).toHaveLength(0)
  })

  it('every KNOWN_TYPE_CYCLES entry is still an actually-detected component', () => {
    const stale = [...knownKeys].filter((key) => !foundKeys.has(key))
    expect(stale, JSON.stringify(stale)).toHaveLength(0)
  })

  it('gives every KNOWN_TYPE_CYCLES entry a reason and no duplicate member set', () => {
    for (const { members, reason } of KNOWN_TYPE_CYCLES) {
      expect(reason.trim().length, members.join(', ')).toBeGreaterThan(20)
    }
    expect(knownKeys.size).toBe(KNOWN_TYPE_CYCLES.length)
  })

  // A scan that resolves nothing reports no cycle and reads as a clean tree.
  it('scans a graph that actually has type edges to find', () => {
    expect(files.length).toBeGreaterThan(500)
  })
})

/**
 * Bare specifiers the scan below finds that are NOT package names, each with
 * why it cannot be a path alias into a scanned tree.
 *
 * The distinction is the whole point: `CYCLE_SCAN_ALIASES` exists because a
 * prefix standing for an intra-package DIRECTORY carries import edges, and a
 * resolver blind to it builds the cycle graph out of a subset of the real
 * one. A virtual module carries no such edge, and neither does a prefix
 * pointing outside every scanned tree.
 */
const NON_PATH_BARE_SPECIFIERS: Record<string, string> = {
  'virtual:pwa-register':
    "vite-plugin-pwa generates this module's source at build time. It is not a directory, so " +
    'there is no import edge for the cycle graph to be missing',
  'virtual:widget-fonts':
    'the widget build generates it from build-fonts-module.ts, same as above — generated source, ' +
    'not a directory',
  '@docs-assets/':
    'vitest.docs-snapshots.config.ts maps it to `docs/assets/`, which is outside every scanned ' +
    'tree. An edge that leaves the scan cannot close a cycle inside it, and the files it names ' +
    'are `.canvas` fixtures rather than modules',
}

/** `@scope/name` or `name` — everything after that is a subpath. */
function packageNameOf(specifier: string): string {
  const segments = specifier.split('/')
  return specifier.startsWith('@') ? segments.slice(0, 2).join('/') : (segments[0] as string)
}

/**
 * Every bare (non-relative, non-`node:`) specifier in the cycle scan's own
 * file set, paired with the package that imports it.
 *
 * The same file set on purpose: what this classifies is exactly what
 * `buildValueImportGraph` had to resolve, so a specifier it could not follow
 * is one the graph is missing.
 */
function bareSpecifiersInScannedTrees(): { packageDir: string; specifier: string; file: string }[] {
  return CYCLE_SCAN_PACKAGES.flatMap((packageDir) =>
    listTsFiles(join(REPO_ROOT, packageDir, 'src'), ['.ts', '.tsx']).flatMap((file) => {
      const sourceFile = ts.createSourceFile(
        file,
        readFileSync(file, 'utf-8'),
        ts.ScriptTarget.Latest,
        true,
      )
      return collectModuleSpecifiers(sourceFile)
        .map(({ specifier }) => specifier)
        .filter(
          (specifier) =>
            !specifier.startsWith('.') &&
            !specifier.startsWith('node:') &&
            specifier.trim() === specifier,
        )
        .map((specifier) => ({ packageDir, specifier, file: relative(REPO_ROOT, file) }))
    }),
  )
}

function declaredDependencies(packageDir: string): ReadonlySet<string> {
  const manifest = JSON.parse(readFileSync(join(REPO_ROOT, packageDir, 'package.json'), 'utf-8'))
  return new Set([
    manifest.name,
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.devDependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
  ])
}

/**
 * A specifier that names no declared dependency resolves through SOME alias
 * mechanism — tsconfig `paths`, a vite/vitest `resolve.alias`, a plugin's
 * virtual module. Which one does not matter here; that it is not plain node
 * resolution does, because that is precisely what `resolveSpecifier` in
 * cycle-check.ts cannot follow on its own.
 */
function aliasedSpecifiers(): { packageDir: string; specifier: string; file: string }[] {
  const declaredPerPackage = new Map(
    CYCLE_SCAN_PACKAGES.map((packageDir) => [packageDir, declaredDependencies(packageDir)]),
  )
  return bareSpecifiersInScannedTrees().filter(
    ({ packageDir, specifier }) =>
      !(declaredPerPackage.get(packageDir) as ReadonlySet<string>).has(packageNameOf(specifier)),
  )
}

/**
 * The one thing `CYCLE_SCAN_ALIASES` could not say about itself: that it is
 * COMPLETE.
 *
 * `cycle-check.test.ts` pins that a declared alias is followed, and pins a
 * cycle that exists only through one. Neither can notice a package that adds
 * an alias and does not declare it here — and the symptom of that is the
 * cycle check reporting a clean result from a graph missing those edges,
 * which reads exactly like a clean codebase. Measured once already: `apps/web`
 * wrote 115 of its 554 intra-package value edges as `@/...`.
 *
 * So the probe is the IMPORT rather than the mechanism. A tsconfig `paths`
 * entry, a vite `resolve.alias`, a plugin's virtual module and whatever
 * arrives next all surface the same way — a bare specifier naming no declared
 * dependency — and one probe covers a list of mechanisms nobody has to keep.
 */
describe('path aliases the cycle scan has to be told about', () => {
  const aliased = aliasedSpecifiers()

  it('reads the scanned trees and finds ordinary package imports', () => {
    // A walk that collected nothing would report every entry below as stale
    // AND every alias as absent — two green assertions over an empty set.
    // 2000+ when written, almost all of them plain dependencies.
    expect(
      bareSpecifiersInScannedTrees().length,
      'the module-specifier walk found almost nothing; check it against how imports are written now',
    ).toBeGreaterThan(500)
  })

  it('classifies every bare specifier that node resolution cannot reach', () => {
    const aliasPrefixes = Object.keys(CYCLE_SCAN_ALIASES as Readonly<Record<string, string>>)
    const unclassified = aliased.filter(
      ({ specifier }) =>
        !aliasPrefixes.some((prefix) => specifier.startsWith(prefix)) &&
        !Object.keys(NON_PATH_BARE_SPECIFIERS).some((prefix) => specifier.startsWith(prefix)),
    )
    expect(
      unclassified,
      'this specifier names no declared dependency, so it resolves through an alias. If the alias ' +
        'stands for a directory inside a scanned package, declare it in CYCLE_SCAN_ALIASES — ' +
        'otherwise the cycle check builds its graph without those edges and reports a clean result ' +
        'it cannot see. If it does not (a virtual module, or a directory outside every scanned ' +
        'tree), record it in NON_PATH_BARE_SPECIFIERS with that reason.\n' +
        JSON.stringify(unclassified, null, 2),
    ).toEqual([])
  })

  it('every NON_PATH_BARE_SPECIFIERS entry is still a specifier the source writes', () => {
    const stale = Object.keys(NON_PATH_BARE_SPECIFIERS).filter(
      (prefix) => !aliased.some(({ specifier }) => specifier.startsWith(prefix)),
    )
    expect(
      stale,
      'NON_PATH_BARE_SPECIFIERS names a specifier nothing imports any more — drop the entry, so it ' +
        'cannot go on exempting a mechanism the repo no longer has',
    ).toEqual([])
  })
})

describe('every spatial format codec is registered', () => {
  // The direction codec's own `codecs.property.test.ts` cannot check from
  // inside itself. Every guarantee a projection makes — its round trip, what a
  // foreign reader keeps, what its published loss table says — is asked of the
  // entries in `SPATIAL_CODECS` and of nothing else. A projection table that
  // no entry points at is a format none of those questions are being asked of,
  // which reads exactly like a format that answered them.
  //
  // It lives here rather than there because the check has to READ the
  // package's source, and the only in-package way to do that is
  // `import.meta.glob`, which needs `vite/client` in codec's `types` — and
  // that drags the DOM lib into a shared-layer package whose tsconfig exists
  // to keep it out. This tool already reads every package's source textually.
  const SPATIAL_DIR = join(REPO_ROOT, 'packages/codec/src/spatial')
  const REGISTRY = join(SPATIAL_DIR, 'codecs.ts')

  const declaredTables = readdirSync(SPATIAL_DIR)
    .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
    .flatMap((file) =>
      [
        ...readFileSync(join(SPATIAL_DIR, file), 'utf-8').matchAll(
          /export const (\w+_PROJECTION)\b/g,
        ),
      ].map((match) => match[1] as string),
    )
    .sort()

  it('found the projection tables at all', () => {
    // A scan that stops matching reports itself as "every table is
    // registered", which is the failure that looks most like success.
    expect(
      declaredTables.length,
      'no *_PROJECTION export found under packages/codec/src/spatial — the scan below is checking nothing',
    ).toBeGreaterThanOrEqual(2)
  })

  it('names every declared projection table in the codec registry', () => {
    const registry = readFileSync(REGISTRY, 'utf-8')
    const unregistered = declaredTables.filter((table) => !registry.includes(table))
    expect(
      unregistered,
      'a projection table is declared under packages/codec/src/spatial and named nowhere in codecs.ts — ' +
        'add a SPATIAL_CODECS entry for it, so the round-trip, confluence and loss-table guards are asked of it too',
    ).toEqual([])
  })
})

describe('architecture-map.md doc sync', () => {
  const doc = readFileSync(ARCHITECTURE_MAP_DOC, 'utf-8')

  it('lists every SHARED_LAYER_PACKAGES entry in its prose', () => {
    const missing = SHARED_LAYER_PACKAGES.map(
      (packageDir) => packageDir.split('/').pop() as string,
    ).filter((basename) => !doc.includes(basename))
    expect(missing).toHaveLength(0)
  })

  it('no longer contains the stale "currently covers model and codec" claim', () => {
    expect(doc).not.toContain('It currently covers `model` and `codec`')
  })

  // The rule file answers "is this checked?", and for a composition root the
  // answer is split: this tool checks the manifest's direction, while
  // web-app-boundary.test.ts scans apps/web's source. A reader who only finds
  // one of the two concludes the other is unguarded.
  it('names every COMPOSITION_ROOTS entry and the enforcer that scans apps/web source', () => {
    const missing = COMPOSITION_ROOTS.filter((packageDir) => !doc.includes(packageDir))
    expect(missing).toHaveLength(0)
    expect(doc).toContain('web-app-boundary.test.ts')
  })

  it('names the circular-value-import enforcer', () => {
    expect(doc).toContain('cycle-check.ts')
  })
})

/**
 * `dev-flow.md`: "Every PR that adds a package ships its path-scoped rule in
 * the same increment." That was prose with nothing behind it. 17 of 18
 * workspaces held one when this was written, so the convention was holding by
 * habit — and a convention held by habit reads exactly like one held by a
 * guard, right up until the PR that forgets.
 *
 * The second `it` is the half worth having. A rule file that EXISTS but whose
 * `paths:` never matches its own package is loaded by nobody: the file is
 * there, the reviewer sees it, and the reader who needed it never got it.
 * That is the same failure as a biome plugin whose include pattern matches
 * nothing — registered, green, never run — one level up, in the layer that is
 * supposed to be teaching people about layers.
 */
describe('every workspace ships the path-scoped rule that teaches it', () => {
  /** How a rule file is named, per top-level directory. */
  const RULE_PREFIX: Record<string, string> = {
    packages: 'package',
    apps: 'app',
    tools: 'tool',
  }

  /**
   * Workspaces with no rule file of their own, and why that is right rather
   * than missing.
   *
   * Guarded from both sides below, and the reason is CHECKED rather than
   * asserted: an entry names the always-on rule that carries this workspace's
   * load-bearing part and a phrase that rule must still contain. An exemption
   * whose justification has quietly gone away fails with the workspace it
   * exempts.
   */
  const NO_RULE_OF_ITS_OWN: Record<
    string,
    { readonly reason: string; readonly documentedIn: string; readonly mentions: string }
  > = {
    'tools/checks': {
      reason:
        'its load-bearing part is the CI gate aggregation, which the INTEGRATOR reads before ' +
        'touching this directory rather than while inside it — so it is always-on in dev-flow.md ' +
        'instead. The rest is script orchestration a reader does not need taught.',
      documentedIn: '.claude/rules/dev-flow.md',
      mentions: 'ci-gate',
    },
  }

  /** Every directory carrying a package.json under the three workspace roots. */
  function workspaceDirs(): string[] {
    return Object.keys(RULE_PREFIX).flatMap((root) =>
      readdirSync(join(REPO_ROOT, root), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => `${root}/${entry.name}`)
        .filter((dir) => existsSync(join(REPO_ROOT, dir, 'package.json'))),
    )
  }

  /**
   * Where a workspace's rule lives, by convention: the top-level directory
   * picks the prefix and the workspace's own name follows it, so
   * `packages/search` is `package-search.md`. The convention is what makes
   * this checkable at all — a rule filed under a name nobody can derive is
   * one this guard reads as absent, which is the right answer.
   */
  function ruleFileFor(dir: string): string {
    const [root, name] = dir.split('/')
    return join(REPO_ROOT, '.claude', 'rules', `${RULE_PREFIX[root as string]}-${name}.md`)
  }

  /** The globs a rule's frontmatter scopes it to. */
  function declaredPaths(ruleFile: string): string[] {
    const frontmatter = /^---\n([\s\S]*?)\n---/.exec(readFileSync(ruleFile, 'utf-8'))?.[1] ?? ''
    return [...frontmatter.matchAll(/^\s*-\s*"?([^"\n#]+?)"?\s*(?:#.*)?$/gm)].map((m) => m[1] ?? '')
  }

  it('finds the workspaces it is meant to check', () => {
    // A readdir that stopped matching would report every entry as exempt-only,
    // which sends the reader to the wrong file entirely. 18 when written.
    expect(workspaceDirs().length, 'the workspace scan found almost nothing').toBeGreaterThan(12)
  })

  it('gives every workspace a rule file, or an exemption that says why', () => {
    const undocumented = workspaceDirs().filter(
      (dir) => !existsSync(ruleFileFor(dir)) && NO_RULE_OF_ITS_OWN[dir] === undefined,
    )
    expect(
      undocumented,
      'a workspace has no path-scoped rule — write .claude/rules/<prefix>-<name>.md scoped to it, or add it to NO_RULE_OF_ITS_OWN with the always-on rule that carries it instead',
    ).toEqual([])
  })

  it('scopes each rule at the whole package it teaches, so it actually loads there', () => {
    // `<dir>/**` exactly, not a glob that merely starts with `<dir>/`: a rule
    // scoped at `packages/history/src/**` does not load for that package's
    // manifest, its config, or anything beside `src/`, and the reader who
    // opened one of those is the reader this rule exists for. Every rule in
    // the repo already uses this one form, so the check costs nothing today
    // and the failure message names it.
    const unscoped = workspaceDirs()
      .filter((dir) => existsSync(ruleFileFor(dir)))
      .filter((dir) => !declaredPaths(ruleFileFor(dir)).includes(`${dir}/**`))
    expect(
      unscoped,
      'a rule file exists but its `paths:` frontmatter does not cover the whole package it is named for, so it loads for nobody who opens the rest of it — add exactly "<dir>/**"',
    ).toEqual([])
  })

  it('keeps every exemption pointing at a workspace and a reason that still holds', () => {
    const dirs = new Set(workspaceDirs())
    const stale = Object.keys(NO_RULE_OF_ITS_OWN).filter(
      (dir) => !dirs.has(dir) || existsSync(ruleFileFor(dir)),
    )
    expect(
      stale,
      'NO_RULE_OF_ITS_OWN names a workspace that is gone or now has its own rule — drop the entry',
    ).toEqual([])

    // The workspace and its subject have to appear in the SAME passage.
    // `mentions` alone is satisfied by any passing use of the word, so an
    // exemption could rest on prose that says nothing about the directory it
    // exempts — the same shape as a check satisfied by an incidental import.
    // Requiring both terms independently is only half a fix: a later edit can
    // scatter them into unrelated paragraphs and still pass. These rules are
    // written one paragraph per line, so a shared line IS a shared passage,
    // and splitting the paragraph fails loudly rather than silently — which
    // is the right way round for a reference somebody has to re-point.
    const unbacked = Object.entries(NO_RULE_OF_ITS_OWN).filter(([dir, entry]) => {
      const doc = readFileSync(join(REPO_ROOT, entry.documentedIn), 'utf-8')
      return !doc.split('\n').some((line) => line.includes(dir) && line.includes(entry.mentions))
    })
    expect(
      unbacked,
      'an exemption says an always-on rule carries this workspace, and no single passage in that rule names both the workspace and its subject — write the path-scoped rule, or re-point the reason at the passage that does',
    ).toEqual([])
  })
})
