/**
 * Source-scan guard: apps/web production code must mutate/inspect a spatial
 * LoroDoc only through canvas-workspace's bridge functions
 * (writeSpatialNode/writeSpatialEdge/deleteSpatialNode/deleteSpatialEdge/
 * writeSpatialCanvas/readSpatialCanvas), never by calling
 * `doc.getMap('nodes'|'edges')` directly — see package-canvas-workspace.md's
 * "callers never manipulate the Loro layout directly" rule.
 *
 * The one documented exemption is `src/test-utils/` — browser-local-canvas.ts
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

  it('the documented exemption is exactly src/test-utils/, nothing wider', () => {
    expect([...EXEMPT_PATH_PREFIXES]).toEqual(['../test-utils/'])
  })

  for (const path of productionFiles) {
    it(`${path} does not call doc.getMap('nodes'|'edges') directly`, async () => {
      const loader = modules[path]
      const source = (await loader?.()) as string
      expect(source).not.toMatch(DIRECT_GET_MAP)
    })
  }
})
