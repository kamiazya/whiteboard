import { describe, expect, it } from 'vitest'

/**
 * Every production module of this package sits in one rank, and a module
 * imports its own rank or one below it:
 *
 *   theme < highlight < leaf < quality < legend < engines < ink
 *     < scene-bounds < layout < svg < surface
 *
 * `theme/` decides appearance and geometry tokens and reads nothing else;
 * `highlight/` tokenises a code fence; `leaf` is everything that reads no
 * other stage (references, tags, the vendored line-breaker, the small root
 * helpers, the legend's measurements); `quality/` scores a drawing;
 * `legend/` lays out the legend panel; `engines` are `layout/edges/` and
 * `layout/nodes/`, which `layout/layer-boundary.test.ts` keeps free of each
 * other; `ink` is `layout/ink/`, which draws on both; `scene-bounds` is the
 * root module that knows how far a drawn node or edge reaches, so it sits
 * above the ink it measures and below the composers and the SVG backend that
 * ask it; `layout` composes the scene; `svg` draws it; `surface` is what a
 * consumer calls on a finished scene and nothing in the pipeline reads.
 *
 * Ranking is by role, not only by directory, because three files sit in a
 * directory whose rank is not theirs: `legend/legend-geometry.ts` reads
 * nothing and `scene-bounds` reads it, while `quality/drawing-score.ts` reads
 * `scene-bounds`. Left at directory grain that is a loop
 * legend -> quality -> scene-bounds -> legend no per-file check sees.
 * `layout/seed.ts` is the id-keyed random primitive: it reads nothing, and
 * `layout/ink` and `layout/node-box.ts` both draw from it.
 *
 * A file in a ranked directory inherits its rank. A root file must be named
 * in `ROOT_FILES`, so a new one is placed on purpose: one in none fails
 * `belongs to a rank`. When two stages need the same thing, it belongs in
 * the lower one, not reached for upward.
 *
 * Tests and `test-utils/` are exempt: a test of a lower stage legitimately
 * builds its fixture through a higher one. Sources are read through Vite's
 * build-time glob rather than `node:fs`, because this package must stay
 * runnable off Node.
 */
const sourceModules = import.meta.glob('./**/*.ts', {
  query: '?raw',
  eager: true,
  import: 'default',
}) as Record<string, string>

const LAYERS = [
  'theme',
  'highlight',
  'leaf',
  'quality',
  'legend',
  'engines',
  'ink',
  'scene-bounds',
  'layout',
  'svg',
  'surface',
] as const
type Layer = (typeof LAYERS)[number]

const rank = (layer: Layer): number => LAYERS.indexOf(layer)

/** Longest prefix wins, so `layout/edges/` is resolved before `layout/`. */
const DIRECTORY_LAYERS: Readonly<Record<string, Layer>> = {
  theme: 'theme',
  highlight: 'highlight',
  references: 'leaf',
  tags: 'leaf',
  vendor: 'leaf',
  quality: 'quality',
  legend: 'legend',
  'layout/edges': 'engines',
  'layout/nodes': 'engines',
  'layout/ink': 'ink',
  layout: 'layout',
  svg: 'svg',
}

/** A file whose role differs from its directory's; each reason is in the header. */
const FILE_LAYERS: Readonly<Record<string, Layer>> = {
  'legend/legend-geometry.ts': 'leaf',
  'layout/seed.ts': 'leaf',
  'quality/drawing-score.ts': 'surface',
}

/**
 * Root `*.ts`, each named by ROLE. Named rather than guessed so a new one has
 * to be placed.
 */
const ROOT_FILES: Readonly<Record<string, Layer>> = {
  'canvas-fragment.ts': 'leaf',
  'edge-arrows.ts': 'leaf',
  'finite-box.ts': 'leaf',
  'measure.ts': 'leaf',
  'scene-children.ts': 'leaf',
  'scene-entry-keys.ts': 'leaf',
  'xml-escape.ts': 'leaf',
  'scene-bounds.ts': 'scene-bounds',
  'scene-digest.ts': 'surface',
  'scoring.ts': 'surface',
  'tidy.ts': 'surface',
  'tidy-axis.ts': 'surface',
  'tidy-bands.ts': 'surface',
  'tidy-units.ts': 'surface',
  'index.ts': 'surface',
}

function isProductionSource(path: string): boolean {
  return !path.includes('.test.') && !path.includes('.bench.') && !path.startsWith('./test-utils/')
}

/** The rank of a `./`-rooted path under `src/`, or `undefined` when it belongs to none. */
function layerOf(path: string): Layer | undefined {
  const relative = path.replace(/^\.\//, '')
  const named = FILE_LAYERS[relative]
  if (named !== undefined) return named
  const parts = relative.split('/')
  if (parts.length === 1) return ROOT_FILES[relative]
  for (let depth = parts.length - 1; depth >= 1; depth--) {
    const layer = DIRECTORY_LAYERS[parts.slice(0, depth).join('/')]
    if (layer !== undefined) return layer
  }
  return undefined
}

/**
 * Every relative specifier: named, type, re-export and side-effect imports in
 * either quote, and dynamic `import()`. A specifier a reader skips is an edge
 * the order cannot see.
 */
function specifiersOf(source: string): readonly string[] {
  return [
    ...source.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])(\.[^'"\n]*)\1/g),
  ].map((m) => m[2] as string)
}

/** Resolves a relative specifier against the importing path to the `.ts` it names. */
function resolveFrom(path: string, specifier: string): string {
  const segments = path.split('/').slice(0, -1)
  for (const part of specifier.split('/')) {
    if (part === '..') segments.pop()
    else if (part !== '.') segments.push(part)
  }
  return segments.join('/').replace(/\.js$/, '.ts')
}

function backEdges(sources: Readonly<Record<string, string>>): readonly string[] {
  return Object.entries(sources).flatMap(([path, source]) => {
    const from = layerOf(path)
    if (from === undefined || !isProductionSource(path)) return []
    return specifiersOf(source).flatMap((specifier) => {
      const to = layerOf(resolveFrom(path, specifier))
      return to !== undefined && rank(to) > rank(from)
        ? [`${path} (${from}) imports ${specifier} (${to})`]
        : []
    })
  })
}

const productionPaths = Object.keys(sourceModules).filter(isProductionSource)

describe('render pipeline layers', () => {
  it('belongs to a rank for every production file', () => {
    expect(productionPaths.filter((path) => layerOf(path) === undefined)).toEqual([])
  })

  it('scans production sources in every rank', () => {
    for (const layer of LAYERS) {
      const scanned = productionPaths.filter((path) => layerOf(path) === layer)
      expect(scanned.length, `no production sources scanned in ${layer}`).toBeGreaterThan(0)
    }
    // A scan that resolves nothing agrees with every layering.
    const crossLayer = productionPaths.filter((path) =>
      specifiersOf(sourceModules[path] as string).some((s) => {
        const to = layerOf(resolveFrom(path, s))
        return to !== undefined && to !== layerOf(path)
      }),
    )
    expect(crossLayer.length, 'no cross-layer import resolved').toBeGreaterThan(30)
  })

  it('names only files and directories that exist', () => {
    const known = new Set(productionPaths.map((path) => path.replace(/^\.\//, '')))
    const staleFiles = [...Object.keys(ROOT_FILES), ...Object.keys(FILE_LAYERS)].filter(
      (file) => !known.has(file),
    )
    const staleDirectories = Object.keys(DIRECTORY_LAYERS).filter(
      (directory) => ![...known].some((file) => file.startsWith(`${directory}/`)),
    )
    expect([...staleFiles, ...staleDirectories]).toEqual([])
  })

  it('resolves every relative import of a production file to a production file', () => {
    const known = new Set(productionPaths)
    const dangling = productionPaths.flatMap((path) =>
      specifiersOf(sourceModules[path] as string)
        .filter((specifier) => !known.has(resolveFrom(path, specifier)))
        .map((specifier) => `${path} imports ${specifier}`),
    )
    expect(dangling).toEqual([])
  })

  it('imports only downward', () => {
    expect(backEdges(sourceModules)).toEqual([])
  })

  it('reports a planted back edge, in a value import, a type import and a dynamic import', () => {
    const planted = {
      './theme/a.ts': "import type { X } from '../layout/nodes/spatial-appearance.js'",
      './highlight/b.ts': "export type { Y } from '../layout/nodes/mdast-layout-options.js'",
      './layout/nodes/c.ts': "export const m = () => import('../../svg/format.js')",
      './layout/nodes/ok.ts': "import { z } from '../../theme/z.js'",
      './svg/ok.ts': "import { w } from '../layout/w.js'",
    }
    expect(backEdges(planted)).toEqual([
      './theme/a.ts (theme) imports ../layout/nodes/spatial-appearance.js (engines)',
      './highlight/b.ts (highlight) imports ../layout/nodes/mdast-layout-options.js (engines)',
      './layout/nodes/c.ts (engines) imports ../../svg/format.js (svg)',
    ])
  })

  it('reports a back edge into a root file, a side-effect import and a quality scorer', () => {
    const planted = {
      './theme/zz-plant.ts': "import { b } from '../scene-bounds.js'",
      './theme/zz-plant2.ts': "import '../layout/spatial-canvas.js'",
      './highlight/zz-plant3.ts': "import { s } from '../quality/drawing-score.js'",
    }
    expect(backEdges(planted)).toEqual([
      './theme/zz-plant.ts (theme) imports ../scene-bounds.js (scene-bounds)',
      './theme/zz-plant2.ts (theme) imports ../layout/spatial-canvas.js (layout)',
      './highlight/zz-plant3.ts (highlight) imports ../quality/drawing-score.js (surface)',
    ])
  })

  it('reads double-quoted, side-effect, dynamic and multi-line specifiers', () => {
    const planted = {
      './theme/q1.ts': 'import { a } from "../svg/format.js"',
      './theme/q2.ts': 'import "../svg/format.js"',
      './theme/q3.ts': 'export const m = () => import("../svg/format.js")',
      './theme/q4.ts': "import {\n  a,\n  b,\n} from '../svg/format.js'",
      './theme/q5.ts': 'export * from "../svg/format.js"',
    }
    expect(backEdges(planted)).toHaveLength(5)
  })

  it('does not read a package specifier as a relative edge', () => {
    expect(specifiersOf("import { z } from 'zod'\nimport 'vitest'\nimport('node:fs')")).toEqual([])
  })
})
