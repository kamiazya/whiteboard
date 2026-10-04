/**
 * `apps/web/src` has layers, and until this test it had them only by
 * convention: `lib/` (browser-only mechanics, no React), `contexts/` and
 * `hooks/` (React state over lib), `components/`, `pages/`, and the
 * composition at the root (`App.tsx`, `boot.ts`, `main.tsx`). Every edge
 * should point DOWN that order — a page may use a hook, a hook may use lib;
 * lib importing a component means the type or helper lib wanted was filed
 * under the screen that first needed it and never moved.
 *
 * Measured before writing this: 21 upward edges, 15 of them `import type`;
 * the first burn-down moved four pure modules into `lib/` and retired six,
 * the second moved eight types down and retired eight more, the third moved
 * the spatial editor's pure core into `lib/spatial/` and retired four, and
 * the fourth moved the render glue the layout worker runs and retired the
 * last three. The list is empty; it stays so a new edge has a place to be
 * refused rather than a place to be written down.
 * They are allowlisted below rather than fixed here, because each is a
 * relocation with its own importers to carry, and the point of the guard is
 * that the count only ever goes down. The list is guarded from both sides —
 * an entry that stops being a real edge fails, and the length is pinned by
 * equality — the way `adapter-mechanic-check.ts` holds ADR-0018's debt.
 *
 * Type-only edges COUNT. tsc erases them, so the bundle never sees the
 * inversion, but layering is about what a module has to know: a lib module
 * that names `EditorCommand` from a component is a lib module whose contract
 * is defined above it. They are tagged so the burn-down can read which are
 * a type move and which are a helper move.
 *
 * `lib/` is also React-free. A hook is state over lib, so it files under
 * `hooks/`; a `lib/` module importing `react` is a hook that was written next
 * to the mechanic it wraps and never moved, and it drags React into every
 * non-React importer of that directory.
 *
 * Edges are read from the AST by `collectRelativeImportEdges`, the same
 * reader `mcp-server-layer-order.test.ts` uses, so a dynamic `import()` counts:
 * `lazy(() => import('../components/X.js'))` is how this app is most likely to
 * reach upward, and a text pattern over `import ... from` could not see it.
 *
 * It lives here and not beside the app because the AST reader is this tool's
 * (`@typescript/typescript6` is a dependency of this package alone) and
 * apps/web's own tests read sources through `?raw` globs.
 */

import { readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import ts from '@typescript/typescript6'
import { describe, expect, it } from 'vitest'
import { collectRelativeImportEdges } from './cycle-check.js'
import { directoryLoops, resolvedImportEdges, spellLoop } from './directory-loops.js'
import { REPO_ROOT, walk } from './scan-roots.js'
import { collectModuleSpecifiers } from './scanner.js'
import { isShippedPath } from './source-scan.js'
import { resolveRelativeSource } from './value-import-closure.js'

const WEB_SRC = join(REPO_ROOT, 'apps/web/src')

/** Source text by path relative to `apps/web/src`, `/`-separated. */
type Sources = ReadonlyMap<string, string>

function readWebSources(): Sources {
  const sources = new Map<string, string>()
  for (const file of walk(WEB_SRC, { include: (path) => /\.tsx?$/.test(path) })) {
    sources.set(relative(WEB_SRC, file).split('\\').join('/'), readFileSync(file, 'utf8'))
  }
  return sources
}

/** Bottom to top. A module may import from its own layer or any layer before it. */
const LAYERS = ['lib', 'pwa', 'contexts', 'hooks', 'components', 'pages', 'app'] as const
type Layer = (typeof LAYERS)[number]

/**
 * Root-level modules are the composition — except `runtime-config.ts`, a
 * zod config leaf that README and ADR-0002 name at the root, so it stays
 * there and is filed with lib, which is what it is.
 */
const ROOT_MODULES: Record<string, Layer> = {
  'runtime-config.ts': 'lib',
  'App.tsx': 'app',
  'app-screens.tsx': 'app',
  'boot.ts': 'app',
  'boot-splash.ts': 'app',
  'main.tsx': 'app',
}

/** Tests, their support and doc snapshots are setup for tests, not part of the app's graph. */
const isOutsideTheGraph = (key: string): boolean => !isShippedPath(key)

function layerOf(key: string): Layer | undefined {
  if (isOutsideTheGraph(key)) return undefined
  const root = ROOT_MODULES[key]
  if (root !== undefined) return root
  return LAYERS.find((layer) => key.startsWith(`${layer}/`))
}

const rank = (layer: Layer): number => LAYERS.indexOf(layer)

/** `lib/<module> -> hooks/<module> (type)`, in the strings the allowlist is written in. */
function upwardEdges(sources: Sources): string[] {
  const edges: string[] = []
  for (const [key, source] of sources) {
    const from = layerOf(key)
    if (from === undefined) continue
    for (const { specifier, typeOnly } of collectRelativeImportEdges(key, source)) {
      const target = resolveRelativeSource(key, specifier, (path) => sources.has(path))
      if (target === null) continue
      const to = layerOf(target)
      if (to === undefined || rank(to) <= rank(from)) continue
      edges.push(`${key} -> ${target}${typeOnly ? ' (type)' : ''}`)
    }
  }
  return edges.sort()
}

/**
 * The directory a module belongs to, two levels deep: `lib/spatial` is not
 * `lib`, and `components/annotations` is not `components`. A root module (the
 * composition) and anything outside the graph is no directory's.
 */
function directoryOf(key: string): string | undefined {
  if (isOutsideTheGraph(key)) return undefined
  const parts = key.split('/')
  return parts.length === 1 ? undefined : parts.slice(0, Math.min(2, parts.length - 1)).join('/')
}

/** Every directory loop in the shipped graph, with the file imports that close it. */
function webDirectoryLoops(sources: Sources) {
  const files = [...sources].map(([path, text]) => ({ path, text }))
  return directoryLoops(resolvedImportEdges(files), directoryOf)
}

/** Whether a module names React, by import or by `import()`. */
function namesReact(key: string, source: string): boolean {
  const file = ts.createSourceFile(key, source, ts.ScriptTarget.Latest, true)
  return collectModuleSpecifiers(file).some(({ specifier }) =>
    /^react(-dom)?(\/|$)/.test(specifier),
  )
}

/** Production `lib/` modules that name React — an import, or a hook-named export. */
function reactInLib(sources: Sources): string[] {
  return [...sources]
    .filter(([key]) => layerOf(key) === 'lib')
    .filter(([key, source]) => {
      const exportsHook = /(?:^|\n)\s*export\s+(?:async\s+)?(?:function|const)\s+use[A-Z]/.test(
        source,
      )
      return namesReact(key, source) || exportsHook
    })
    .map(([key]) => key)
    .sort()
}

/**
 * Every upward edge that exists today, each a relocation still to do. Shrink
 * it by moving the target down (a type into `lib/`, a pure helper out of
 * `components/`), then delete the line and lower the ceiling. Never add to
 * it for new code — file the module where its importers can reach it.
 */
const UPWARD_EDGES: readonly string[] = []

const UPWARD_EDGES_CEILING = 0

/**
 * Every loop among the app's directories, and how many file imports close it.
 * The layer order cannot see them: `lib/` and `lib/spatial/` are both lib, and
 * the components directories are one layer. A loop is what stops one of its
 * directories being lifted without the others, so the number may only fall —
 * a new loop, a loop that gains a directory and a loop that gains an import all
 * fail, and so does one that shrank without its count following. Break a loop
 * by moving what one side wants down to a module the other already imports,
 * then lower the count (or delete the entry when the loop is gone).
 */
const DIRECTORY_LOOPS: Readonly<Record<string, number>> = {
  'lib,lib/spatial': 12,
  'components,components/annotations,components/document-editor,components/markdown-editor,components/spatial-editor,components/workspace-files,components/workspace-top-bar': 37,
}

describe('apps/web layer order', () => {
  const sources = readWebSources()
  const actual = upwardEdges(sources)

  it('keeps React out of lib', () => {
    // The probe: a scan whose pattern matches nothing would pass for the wrong
    // reason, so assert it still recognises React in the layer above.
    const hooksNamingReact = [...sources].filter(
      ([key, source]) => layerOf(key) === 'hooks' && namesReact(key, source),
    )
    expect(hooksNamingReact.length).toBeGreaterThan(10)
    expect(
      reactInLib(sources),
      'a hook belongs in hooks/ — lib/ is browser mechanics with no React',
    ).toEqual([])
  })

  it('scans every layer', () => {
    // A guard over a walk that found nothing passes for the wrong reason.
    expect(sources.size).toBeGreaterThan(100)
    for (const layer of LAYERS) {
      const inLayer = [...sources.keys()].filter((key) => layerOf(key) === layer)
      expect(inLayer.length, `no production modules filed under ${layer}`).toBeGreaterThan(0)
    }
    for (const key of sources.keys()) {
      if (isOutsideTheGraph(key)) continue
      expect(
        layerOf(key),
        `${key} belongs to no layer — file it, or name it in ROOT_MODULES`,
      ).toBeDefined()
    }
  })

  it('has no upward edge outside the allowlist', () => {
    const unexpected = actual.filter((edge) => !UPWARD_EDGES.includes(edge))
    expect(
      unexpected,
      'a module imports from a layer above it — move what it needs down rather than adding to the allowlist',
    ).toEqual([])
  })

  it('every allowlist entry is still a real edge', () => {
    const stale = UPWARD_EDGES.filter((edge) => !actual.includes(edge))
    expect(stale, 'an entry that outlives its edge is how an allowlist stops being read').toEqual(
      [],
    )
  })

  it('holds the allowlist at its declared ceiling', () => {
    expect(UPWARD_EDGES.length).toBe(UPWARD_EDGES_CEILING)
  })
})

describe('apps/web directory loops', () => {
  const sources = readWebSources()
  const actual = Object.fromEntries(
    webDirectoryLoops(sources).map((loop) => [spellLoop(loop), loop.edges]),
  )

  it('reaches the directory graph', () => {
    // A directory scan that resolved nothing reports no loop, which reads as clean.
    expect(
      resolvedImportEdges([...sources].map(([path, text]) => ({ path, text }))).filter(
        ({ from, to }) => directoryOf(from) !== directoryOf(to),
      ).length,
    ).toBeGreaterThan(500)
    expect(Object.keys(actual).length, 'the loops the ledger names were not found').toBeGreaterThan(
      0,
    )
  })

  it('has no loop outside the ledger', () => {
    expect(
      Object.keys(actual).filter((loop) => DIRECTORY_LOOPS[loop] === undefined),
      'a directory loop that is not ledgered — move what one directory needs down instead of adding to it',
    ).toEqual([])
  })

  it('names only loops that still exist', () => {
    expect(
      Object.keys(DIRECTORY_LOOPS).filter((loop) => actual[loop] === undefined),
      'a ledgered loop is gone — delete its entry',
    ).toEqual([])
  })

  it('holds each loop at exactly its ledgered edge count', () => {
    const drift = Object.entries(DIRECTORY_LOOPS).flatMap(([loop, edges]) =>
      actual[loop] === undefined || actual[loop] === edges
        ? []
        : [`${loop}: ${edges} -> ${actual[loop]}`],
    )
    expect(
      drift,
      'a loop gained an import (growth) or lost one (lower the ledger so the headroom is not left)',
    ).toEqual([])
  })
})

describe('what the directory loop scan reads, on fixture trees', () => {
  const loopsOf = (files: Record<string, string>): Record<string, number> =>
    Object.fromEntries(
      webDirectoryLoops(new Map(Object.entries(files))).map((l) => [spellLoop(l), l.edges]),
    )

  it('counts the distinct imports that close a loop between a directory and its subdirectory', () => {
    expect(
      loopsOf({
        'lib/a.ts': "import '../lib/spatial/b.js'\nimport './c.js'\n",
        'lib/c.ts': "import './spatial/d.js'\n",
        'lib/spatial/b.ts': "import type { T } from '../a.js'\nimport '../a.js'\n",
        'lib/spatial/d.ts': 'export const d = 1\n',
      }),
    ).toEqual({ 'lib,lib/spatial': 3 })
  })

  it('does not call a root module, a test or a one-way import a loop', () => {
    expect(
      loopsOf({
        'App.tsx': "import './lib/a.js'\n",
        'lib/a.ts': "import '../App.js'\nimport './spatial/b.js'\n",
        'lib/spatial/b.ts': "import '../a.test.js'\n",
        'lib/a.test.ts': "import './spatial/b.js'\n",
      }),
    ).toEqual({})
  })

  it('reports two independent loops separately', () => {
    expect(
      Object.keys(
        loopsOf({
          'lib/a.ts': "import './spatial/b.js'\n",
          'lib/spatial/b.ts': "import '../a.js'\n",
          'components/x/A.tsx': "import '../y/B.js'\n",
          'components/y/B.tsx': "import '../x/A.js'\n",
        }),
      ).sort(),
    ).toEqual(['components/x,components/y', 'lib,lib/spatial'])
  })
})

describe('what the layer scan reads, on fixture trees', () => {
  const tree = (files: Record<string, string>): Sources => new Map(Object.entries(files))
  const lib = 'lib/zz.ts'
  const chip = 'components/Chip.tsx'
  const chipSource = 'export const Chip = 1\n'

  it.each([
    [
      'a static import',
      "import { Chip } from '../components/Chip.js'\nexport const x = Chip\n",
      '',
    ],
    [
      'a type-only import',
      "import type { Chip } from '../components/Chip.js'\nexport type X = Chip\n",
      ' (type)',
    ],
    ['a re-export', "export { Chip } from '../components/Chip.js'\n", ''],
    ['an export-star', "export * from '../components/Chip.js'\n", ''],
    ['a side-effect import', "import '../components/Chip.js'\n", ''],
    ['a dynamic import', "export const load = () => import('../components/Chip.js')\n", ''],
    [
      'a dynamic import under lazy()',
      "export const C = lazy(() => import('../components/Chip.js'))\n",
      '',
    ],
  ])('finds %s from lib to a component', (_name, source, tag) => {
    expect(upwardEdges(tree({ [lib]: source, [chip]: chipSource }))).toEqual([
      `${lib} -> ${chip}${tag}`,
    ])
  })

  it('resolves a directory import to its index', () => {
    expect(
      upwardEdges(
        tree({
          [lib]: "import '../components/chip'\n",
          'components/chip/index.tsx': chipSource,
        }),
      ),
    ).toEqual([`${lib} -> components/chip/index.tsx`])
  })

  it('does not count a downward, a same-layer, an external or an asset edge', () => {
    expect(
      upwardEdges(
        tree({
          [chip]:
            "import { x } from '../lib/zz.js'\nimport './chip.css'\nimport 'react'\nexport const c = x\n",
          'components/Other.tsx': "import { Chip } from './Chip.js'\nexport const o = Chip\n",
          [lib]: 'export const x = 1\n',
        }),
      ),
    ).toEqual([])
  })

  it('does not judge a test, or test support, as part of the graph', () => {
    expect(
      upwardEdges(
        tree({
          'lib/zz.test.ts': "import '../components/Chip.js'\n",
          'test-utils/helper.ts': "import '../components/Chip.js'\n",
          [chip]: chipSource,
        }),
      ),
    ).toEqual([])
  })

  it('names React in lib whether imported statically, dynamically or exported as a hook', () => {
    expect(
      reactInLib(
        tree({
          'lib/a.ts': "import { useState } from 'react'\nexport const a = useState\n",
          'lib/b.ts': "export const load = () => import('react-dom/client')\n",
          'lib/c.ts': 'export function useThing() {}\n',
          'lib/d.ts': "import { x } from './a.js'\nexport const d = x\n",
          'hooks/e.ts': "import 'react'\n",
        }),
      ),
    ).toEqual(['lib/a.ts', 'lib/b.ts', 'lib/c.ts'])
  })
})
