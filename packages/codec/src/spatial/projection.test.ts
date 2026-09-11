import { spatialCanvasArbitrary } from '@kamiazya/whiteboard-model/test-utils'
import { describe, expect, it } from 'vitest'
import { fcTest, withDefaults } from '../test-utils/fast-check.js'
import { censusSpatialModel } from './census.js'
import { parseSpatial } from './parse.js'
import {
  fromJsonCanvas,
  JSON_CANVAS_PROJECTION,
  jsonCanvasLoss,
  toJsonCanvas,
  valueLeafPaths,
} from './projection.js'
import { serializeSpatial } from './serialize.js'

const census = censusSpatialModel([])
const modelPaths = [...census.standard, ...census.extension, ...census.facetBuckets].sort()

/**
 * The ledger's four directions. `.claude/rules/coverage-ledger.md` owns the
 * shape; its `assertScannedLedger` helper lives in `apps/web`, which this
 * package cannot import, so the two type-system directions are done by hand
 * here — both of them, because a scan with only one reads exactly like a scan
 * that checked.
 */
describe('the projection ledger covers the model, and only the model', () => {
  it('has an entry for every field position the model can hold', () => {
    const missing = modelPaths.filter((path) => JSON_CANVAS_PROJECTION[path] === undefined)
    expect(missing).toEqual([])
  })

  it('has no entry naming a field position the model no longer holds', () => {
    const stale = Object.keys(JSON_CANVAS_PROJECTION).filter((path) => !modelPaths.includes(path))
    expect(stale).toEqual([])
  })

  it('makes every degraded or dropped entry say what it costs', () => {
    const vague = Object.entries(JSON_CANVAS_PROJECTION).filter(([, projection]) => {
      if (projection.kind === 'degraded') return projection.to.length < 12
      if (projection.kind === 'dropped') return projection.why.length < 12
      return false
    })
    expect(vague).toEqual([])
  })
})

describe('the ledger agrees with what strict JSON Canvas actually drops', () => {
  it('loses exactly the positions the ledger calls extension', () => {
    const canvas = fullyPopulatedCanvas()
    const before = valueLeafPaths(canvas)
    const strict = parseSpatial(serializeSpatial(canvas, 'strict'))
    expect(strict.ok).toBe(true)
    if (!strict.ok) return
    const after = valueLeafPaths(strict.value)

    const lost = before.filter((path) => !after.includes(path)).sort()
    const declared = jsonCanvasLoss()
      .filter((entry) => lost.some((path) => path === entry.path))
      .map((entry) => entry.path)
      .sort()

    // Every position the strict projection really lost is one the ledger
    // declares lost. A `native` entry that vanishes is the failure this
    // catches — the declaration would be a claim nothing checked.
    expect(lost).toEqual(declared)
    expect(lost.length).toBeGreaterThan(0)
  })
})

describe('the projection round-trips over the expressible subset', () => {
  fcTest.prop([spatialCanvasArbitrary], withDefaults())(
    'fromJsonCanvas(toJsonCanvas(x)) deep-equals x',
    (canvas) => {
      expect(fromJsonCanvas(toJsonCanvas(canvas))).toEqual(canvas)
    },
  )

  it('builds its result field by field, so an unprojected model field is caught', () => {
    const canvas = fullyPopulatedCanvas()
    expect(toJsonCanvas(canvas)).not.toBe(canvas)
    expect(valueLeafPaths(toJsonCanvas(canvas))).toEqual(valueLeafPaths(canvas))
  })
})

/** A canvas carrying every field position the model has, so a loss shows up. */
function fullyPopulatedCanvas() {
  return {
    nodes: [
      {
        id: 'n1',
        type: 'text' as const,
        x: 0,
        y: 0,
        width: 10,
        height: 10,
        text: 'a',
        color: '1' as const,
        'x-whiteboard': {
          kind: 'embed' as const,
          documentId: '01M231FG6BGKKWW4BAA6Z1C945',
          versionRef: 'v1',
          facets: { 'visual.shape/v0': { kind: 'rect' } },
        },
      },
      {
        id: 'n2',
        type: 'file' as const,
        x: 1,
        y: 1,
        width: 2,
        height: 2,
        file: 'a.png',
        subpath: '#x',
      },
      { id: 'n3', type: 'link' as const, x: 2, y: 2, width: 2, height: 2, url: 'https://e.test/' },
      {
        id: 'n4',
        type: 'group' as const,
        x: 3,
        y: 3,
        width: 4,
        height: 4,
        label: 'g',
        background: 'b.png',
        backgroundStyle: 'cover' as const,
      },
    ],
    edges: [
      {
        id: 'e1',
        fromNode: 'n1',
        toNode: 'n2',
        fromSide: 'right' as const,
        toSide: 'left' as const,
        fromEnd: 'none' as const,
        toEnd: 'arrow' as const,
        color: '2' as const,
        label: 'l',
        'x-whiteboard': { facets: { 'visual.path/v0': { waypoints: [{ x: 1, y: 1 }] } } },
      },
    ],
    'x-whiteboard': {
      comments: [
        {
          id: 'c1',
          x: 0,
          y: 0,
          text: 't',
          author: 'human:a',
          createdAt: '2026-01-01T00:00:00.000Z',
          targetNodeId: 'n1',
          resolved: false,
        },
        { id: 'c2', x: 1, y: 1, text: 'u', targetEdgeId: 'e1' },
      ],
      facets: { 'visual.theme/v0': { theme: 'sketch' } },
    },
  }
}
