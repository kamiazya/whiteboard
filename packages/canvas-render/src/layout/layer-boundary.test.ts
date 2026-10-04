import { describe, expect, it } from 'vitest'

/**
 * `layout/` holds two engines that have nothing to say to each other:
 * `edges/` routes orthogonal edges (pure geometry over boxes) and
 * `nodes/` decides how a node's box is drawn and filled (outline, colour,
 * markdown body). They were measured to share zero production imports at
 * the point they were split apart, and this guard is what keeps that true
 * — the property is only worth the directory split for as long as nobody
 * quietly reintroduces the coupling.
 *
 * `spatial-canvas.ts` is the composer that draws on both, so it sits ABOVE
 * them in `layout/` itself. The subdirectories are therefore leaves: they
 * reach out to the package (`../../scene-graph.js`, `../../measure.js`),
 * never sideways to each other and never up to the composer.
 *
 * Tests are exempt. A test for the edge router legitimately builds its
 * fixture by composing a whole scene, and that is setup, not a dependency
 * of the engine under test.
 *
 * Sources are captured via Vite's build-time `import.meta.glob` (raw text)
 * rather than `node:fs`, because this package must stay runnable off Node
 * — the same reason `import-guard.test.ts` reads them that way.
 */
const sourceModules = import.meta.glob('./**/*.ts', {
  query: '?raw',
  eager: true,
  import: 'default',
}) as Record<string, string>

const CLUSTERS = ['edges', 'nodes'] as const
type Cluster = (typeof CLUSTERS)[number]

function isProductionSource(path: string): boolean {
  return !path.includes('.test.') && !path.includes('.bench.')
}

function clusterOf(path: string): Cluster | undefined {
  return CLUSTERS.find((c) => path.startsWith(`./${c}/`))
}

// Named, type, re-export and side-effect imports in either quote, and dynamic
// `import()`: a specifier the reader skips is an edge the guard cannot see.
function specifiersOf(source: string): readonly string[] {
  return [...source.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])([^'"\n]+)\1/g)].map(
    (m) => m[2] as string,
  )
}

interface ClusterSource {
  readonly path: string
  readonly cluster: Cluster
  readonly specifiers: readonly string[]
}

function clusterSourcesOf(sources: Readonly<Record<string, string>>): readonly ClusterSource[] {
  return Object.entries(sources)
    .filter(([path]) => isProductionSource(path) && clusterOf(path) !== undefined)
    .map(([path, source]) => ({
      path,
      cluster: clusterOf(path) as Cluster,
      specifiers: specifiersOf(source),
    }))
}

function crossingsOf(sources: readonly ClusterSource[]): readonly string[] {
  return sources.flatMap(({ path, cluster, specifiers }) => {
    const other = cluster === 'edges' ? 'nodes' : 'edges'
    return specifiers.filter((s) => s.startsWith(`../${other}/`)).map((s) => `${path} imports ${s}`)
  })
}

// `../x.js` resolves to a module sitting directly in `layout/` — the composer
// or one of its helpers. Reaching it from a leaf inverts the direction.
// Package-level reads (`../../x.js`) are fine.
function inversionsOf(sources: readonly ClusterSource[]): readonly string[] {
  return sources.flatMap(({ path, specifiers }) =>
    specifiers.filter((s) => /^\.\.\/[^.][^/]*\.js$/.test(s)).map((s) => `${path} imports ${s}`),
  )
}

const clusterSources = clusterSourcesOf(sourceModules)

describe('layout cluster boundaries', () => {
  // A guard over a glob that matched nothing passes for the wrong reason.
  it('scans production sources in both clusters', () => {
    for (const cluster of CLUSTERS) {
      const scanned = clusterSources.filter((s) => s.cluster === cluster)
      expect(scanned.length, `no production sources scanned under ${cluster}/`).toBeGreaterThan(0)
      expect(
        scanned.some((s) => s.specifiers.length > 0),
        `no import specifiers parsed under ${cluster}/`,
      ).toBe(true)
    }
  })

  it('keeps edges/ and nodes/ free of each other', () => {
    expect(crossingsOf(clusterSources)).toEqual([])
  })

  it('keeps both clusters below the composer that draws on them', () => {
    expect(inversionsOf(clusterSources)).toEqual([])
  })

  it('reports a planted crossing and inversion in every import spelling', () => {
    const planted = clusterSourcesOf({
      './edges/a.ts': "import { n } from '../nodes/truncate.js'",
      './edges/b.ts': "import '../nodes/truncate.js'",
      './edges/c.ts': 'import { n } from "../nodes/truncate.js"',
      './edges/d.ts': "export const m = () => import('../nodes/truncate.js')",
      './nodes/e.ts': 'export const m = () => import("../edges/edge-geometry.js")',
      './nodes/f.ts': 'import "../spatial-canvas.js"',
      './nodes/g.ts': "import type {\n  T,\n} from '../compose-node.js'",
      './nodes/ok.ts': "import { z } from '../../theme/z.js'\nimport { y } from './truncate.js'",
    })
    expect(crossingsOf(planted)).toEqual([
      './edges/a.ts imports ../nodes/truncate.js',
      './edges/b.ts imports ../nodes/truncate.js',
      './edges/c.ts imports ../nodes/truncate.js',
      './edges/d.ts imports ../nodes/truncate.js',
      './nodes/e.ts imports ../edges/edge-geometry.js',
    ])
    expect(inversionsOf(planted)).toEqual([
      './nodes/f.ts imports ../spatial-canvas.js',
      './nodes/g.ts imports ../compose-node.js',
    ])
  })
})
