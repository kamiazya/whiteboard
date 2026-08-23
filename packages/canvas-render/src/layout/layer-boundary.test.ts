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

function specifiersOf(source: string): readonly string[] {
  return [...source.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1] as string)
}

const clusterSources = Object.entries(sourceModules)
  .filter(([path]) => isProductionSource(path) && clusterOf(path) !== undefined)
  .map(([path, source]) => ({
    path,
    cluster: clusterOf(path) as Cluster,
    specifiers: specifiersOf(source),
  }))

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
    const crossings = clusterSources.flatMap(({ path, cluster, specifiers }) => {
      const other = cluster === 'edges' ? 'nodes' : 'edges'
      return specifiers
        .filter((s) => s.startsWith(`../${other}/`))
        .map((s) => `${path} imports ${s}`)
    })
    expect(crossings).toEqual([])
  })

  it('keeps both clusters below the composer that draws on them', () => {
    // `../x.js` resolves to a module sitting directly in `layout/` — the
    // composer or one of its helpers. Reaching it from a leaf inverts the
    // direction. Package-level reads (`../../x.js`) are fine.
    const inversions = clusterSources.flatMap(({ path, specifiers }) =>
      specifiers.filter((s) => /^\.\.\/[^.][^/]*\.js$/.test(s)).map((s) => `${path} imports ${s}`),
    )
    expect(inversions).toEqual([])
  })
})
