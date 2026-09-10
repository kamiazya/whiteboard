import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import ts from '@typescript/typescript6'
import { describe, expect, it } from 'vitest'
import { checkAllowedDependencies } from './allowed-deps-check.js'
import { exemptedBoundaryViolationKinds, KNOWN_IMPORT_CYCLES } from './architecture-map.js'
import { buildValueImportGraph, findImportCycles } from './cycle-check.js'
import { checkDependencyDirection } from './direction-check.js'
import { collectModuleSpecifiers, scanSourceForBoundaryViolations } from './scanner.js'

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..')
const ARCHITECTURE_MAP_DOC = join(REPO_ROOT, '.claude', 'rules', 'architecture-map.md')
const SHARED_LAYER_PACKAGES = [
  'packages/daemon-client',
  'packages/model',
  'packages/codec',
  'packages/canvas-render',
  'packages/ports',
  'packages/facet-engine',
  'packages/loro-adapter',
  'packages/search',
  'packages/server-core',
  'packages/workspace-index',
  'packages/history',
  // Browser-runtime UI package, not a "shared" model/codec/... layer package
  // in the architecture-map.md sense, but scanned the same way — see its
  // `exemptBoundaryViolationKinds` entry in architecture-map.ts for why DOM
  // globals and one build-time `Buffer` use don't trip the scan.
  'packages/canvas-viewer',
  // React packages, scanned for the same reason and with the same caveat as
  // canvas-viewer. The scan's `.ts`-only default is load-bearing here rather
  // than incidental: it covers `plugin-visual`'s react-free DATA half
  // (`data.ts`, `icons/`), which `canvas-render` imports and which therefore
  // must not reach for `node:*`, while leaving each package's `.tsx` alone.
  // Registering a package in `architecture-map.ts` does NOT scan it —
  // verified by a `node:fs` import in `plugin-visual` passing a full
  // arch-lint run before both of these were listed here.
  'packages/facet-ui',
  'packages/plugin-visual',
]

/**
 * Composition roots. Their SOURCE is deliberately unscanned — they are the
 * packages allowed `node:*`, DOM globals and inversify — and their
 * third-party surface is open by design, so they cannot join the list above.
 * Their dependency DIRECTION is still a rule, and it was the one thing
 * nothing checked: `apps/web` was absent from the map entirely, so a shared
 * package taking a dependency on it would have passed.
 */
const COMPOSITION_ROOTS = ['apps/web', 'packages/mcp-server']

// `extensions` defaults to `.ts` only, so the existing boundary/direction/
// allowed-deps scans below keep collecting exactly what they always did; the
// cycle scan further down opts into `.tsx` explicitly instead of widening
// this default for everyone.
function listTsFiles(dir: string, extensions: readonly string[] = ['.ts']): string[] {
  const files: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      // test-utils are dev surface, not shipping modules — the same line the
      // manifests already draw (ports keeps fast-check, daemon-client keeps
      // loro-crdt in devDependencies for exactly these helpers). A contract
      // suite legitimately mints real Loro bytes; holding it to the runtime
      // boundary would ban the test for being a good test. `.test.ts` files
      // are excluded below for the same reason.
      if (entry.name === 'test-utils') continue
      files.push(...listTsFiles(full, extensions))
      continue
    }
    const ext = extensions.find((candidate) => entry.name.endsWith(candidate))
    if (ext === undefined || entry.name.endsWith(`.test${ext}`)) continue
    files.push(full)
  }
  return files
}

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
  for (const packageDir of COMPOSITION_ROOTS) {
    it(`${packageDir}/package.json dependency direction is clean`, () => {
      const manifest = JSON.parse(
        readFileSync(join(REPO_ROOT, packageDir, 'package.json'), 'utf-8'),
      )
      expect(checkDependencyDirection(manifest)).toHaveLength(0)
    })
  }
})

describe('shared-layer boundary lint (real source coverage)', () => {
  for (const packageDir of SHARED_LAYER_PACKAGES) {
    it(`${packageDir}/src has zero boundary violations`, () => {
      const manifest = JSON.parse(
        readFileSync(join(REPO_ROOT, packageDir, 'package.json'), 'utf-8'),
      )
      // A violation kind is a legitimate exemption ONLY for packages
      // architecture-map.ts explicitly lists it for — never an implicit "it's
      // used here, so allow it" heuristic, so an unmapped package still fails
      // loudly.
      const exemptKinds = exemptedBoundaryViolationKinds(manifest.name)

      const srcDir = join(REPO_ROOT, packageDir, 'src')
      const files = listTsFiles(srcDir)
      expect(files.length).toBeGreaterThan(0)

      for (const file of files) {
        const allViolations = scanSourceForBoundaryViolations(file, readFileSync(file, 'utf-8'))
        const violations = allViolations.filter((v) => !exemptKinds.has(v.kind))
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
