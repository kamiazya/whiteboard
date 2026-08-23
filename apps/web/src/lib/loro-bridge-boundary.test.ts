/**
 * Source-scan guard: apps/web production code must mutate/inspect a spatial
 * LoroDoc only through crdt's bridge functions
 * (writeSpatialNode/writeSpatialEdge/deleteSpatialNode/deleteSpatialEdge/
 * writeSpatialCanvas/readSpatialCanvas), never by calling
 * `doc.getMap('nodes'|'edges')` directly — see package-crdt.md's
 * "callers never manipulate the Loro layout directly" rule.
 *
 * The one documented exemption is `src/test-utils/` — browser-document.ts
 * reads `doc.getMap('nodes')` to assert on the persisted doc from OUTSIDE the
 * production code path, which is a legitimate test-assertion use, not a
 * production call site.
 */
import { describe, expect, it } from 'vitest'

const EXEMPT_PATH_PREFIXES = ['../test-utils/'] as const

const modules = import.meta.glob('../**/*.{ts,tsx}', { query: '?raw', import: 'default' })

const productionFiles = Object.keys(modules).filter((path) => {
  if (path.includes('.test.')) return false
  if (EXEMPT_PATH_PREFIXES.some((prefix) => path.startsWith(prefix))) return false
  return true
})

const DIRECT_GET_MAP = /getMap\(\s*['"](nodes|edges)['"]\s*\)/

describe('loro spatial-doc bridge boundary (apps/web)', () => {
  it('scans a non-trivial floor of production files (guards a broken/empty glob)', () => {
    expect(productionFiles.length).toBeGreaterThan(50)
  })

  it("no production file calls doc.getMap('nodes'|'edges') directly", async () => {
    const sources = await Promise.all(
      productionFiles.map(async (path) => ({ path, source: (await modules[path]?.()) as string })),
    )
    const offenders = sources
      .filter(({ source }) => DIRECT_GET_MAP.test(source))
      .map(({ path }) => path)
    expect(offenders).toEqual([])
  })
})
