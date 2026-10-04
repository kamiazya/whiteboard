import { describe, expect, it } from 'vitest'

/**
 * Five directories hold the render pipeline's stages, and a directory
 * imports only from the ones below it:
 *
 *   theme < highlight < legend < layout < svg
 *
 * `theme/` decides appearance and geometry tokens, `highlight/` tokenises a
 * code fence, `legend/` lays out the legend panel, `layout/` composes the
 * scene from all of those, and `svg/` draws the scene. A back edge turns a
 * directory split into a cycle no per-file check sees: `cycle-check` is
 * file-level and the sibling `layout/layer-boundary.test.ts` only polices
 * the two clusters inside `layout/`. When two stages need the same thing, it
 * belongs in the lower one (or at the package root), not reached for upward.
 *
 * Tests are exempt: a test of a lower stage legitimately builds its fixture
 * through a higher one. Sources are read through Vite's build-time glob
 * rather than `node:fs`, because this package must stay runnable off Node.
 */
const sourceModules = import.meta.glob('./**/*.ts', {
  query: '?raw',
  eager: true,
  import: 'default',
}) as Record<string, string>

const LAYERS = ['theme', 'highlight', 'legend', 'layout', 'svg'] as const
type Layer = (typeof LAYERS)[number]

function isProductionSource(path: string): boolean {
  return !path.includes('.test.') && !path.includes('.bench.')
}

function layerOf(path: string): Layer | undefined {
  return LAYERS.find((layer) => path.startsWith(`./${layer}/`))
}

function specifiersOf(source: string): readonly string[] {
  return [...source.matchAll(/(?:from\s+|import\(\s*)'(\.[^']*)'/g)].map((m) => m[1] as string)
}

/** Resolves a relative specifier against the importing path, without an extension probe. */
function resolveFrom(path: string, specifier: string): string {
  const segments = path.split('/').slice(0, -1)
  for (const part of specifier.split('/')) {
    if (part === '..') segments.pop()
    else if (part !== '.') segments.push(part)
  }
  return segments.join('/')
}

function backEdges(sources: Readonly<Record<string, string>>): readonly string[] {
  return Object.entries(sources).flatMap(([path, source]) => {
    const from = layerOf(path)
    if (from === undefined || !isProductionSource(path)) return []
    return specifiersOf(source).flatMap((specifier) => {
      const to = layerOf(resolveFrom(path, specifier))
      return to !== undefined && LAYERS.indexOf(to) > LAYERS.indexOf(from)
        ? [`${path} (${from}) imports ${specifier} (${to})`]
        : []
    })
  })
}

describe('render pipeline directory layers', () => {
  it('scans production sources in every layer', () => {
    for (const layer of LAYERS) {
      const scanned = Object.keys(sourceModules).filter(
        (path) => layerOf(path) === layer && isProductionSource(path),
      )
      expect(scanned.length, `no production sources scanned under ${layer}/`).toBeGreaterThan(0)
    }
    // A scan that resolves nothing agrees with every layering.
    const crossLayer = Object.entries(sourceModules).filter(
      ([path, source]) =>
        isProductionSource(path) &&
        layerOf(path) !== undefined &&
        specifiersOf(source).some((s) => {
          const to = layerOf(resolveFrom(path, s))
          return to !== undefined && to !== layerOf(path)
        }),
    )
    expect(crossLayer.length, 'no cross-layer import resolved').toBeGreaterThan(5)
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
      './theme/a.ts (theme) imports ../layout/nodes/spatial-appearance.js (layout)',
      './highlight/b.ts (highlight) imports ../layout/nodes/mdast-layout-options.js (layout)',
      './layout/nodes/c.ts (layout) imports ../../svg/format.js (svg)',
    ])
  })
})
