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
const modelPaths = [...census.paths, ...census.facetBuckets].sort()

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
  const canvas = fullyPopulatedCanvas()

  it('has a fixture that occupies every position the model can hold', () => {
    // The comparison below is only as strong as this. A fixture that stopped
    // covering a position would leave that position out of BOTH sides and the
    // equality would still hold — a guard quietly weakened rather than broken.
    expect(valueLeafPaths(canvas)).toEqual(modelPaths)
  })

  it('loses exactly the positions the ledger calls extension — no more, no less', () => {
    const before = valueLeafPaths(canvas)
    const strict = parseSpatial(serializeSpatial(canvas, 'strict'))
    expect(strict.ok).toBe(true)
    if (!strict.ok) return
    const after = valueLeafPaths(strict.value)

    const lost = before.filter((path) => !after.includes(path)).sort()
    // `extension`, not "everything the ledger does not call native". A
    // `degraded` position is still THERE after the trip — it is the value
    // that changed, not the field — and conflating the two was a modelling
    // mistake this comparison made until geometry became the first degraded
    // entry and the sets stopped matching.
    const declared = jsonCanvasLoss()
      .filter((entry) => entry.projection.kind === 'extension')
      .map((entry) => entry.path)
      .sort()

    // Equality, in both directions, and the second one is the one that was
    // missing: filtering the ledger down to what was already lost made the
    // declared set a subset by construction, so UNDER-declaring failed and
    // OVER-declaring — telling a user a field disappears in strict mode when
    // it never does — passed all three guards. Measured: marking
    // `nodes[].color` as extension left every test green.
    expect(lost).toEqual(declared)
    expect(lost.length).toBeGreaterThan(0)
  })

  it('keeps every degraded position, changed rather than dropped', () => {
    const strict = parseSpatial(serializeSpatial(canvas, 'strict'))
    expect(strict.ok).toBe(true)
    if (!strict.ok) return
    const surviving = valueLeafPaths(strict.value)
    const degraded = jsonCanvasLoss().filter((entry) => entry.projection.kind === 'degraded')
    expect(degraded.length).toBeGreaterThan(0)
    for (const entry of degraded) expect(surviving).toContain(entry.path)
  })
})

describe('the projection round-trips over the expressible subset', () => {
  fcTest.prop([spatialCanvasArbitrary], withDefaults())(
    'is idempotent: a document that has been through the format survives it again unchanged',
    (canvas) => {
      // Equality with the INPUT holds only over the expressible subset, and
      // geometry left it when the model went sub-pixel: the format rounds.
      // Idempotence is the statement that survives, and it is not a weaker
      // one — the expressible subset IS the projection's image, so this says
      // exactly "inside the subset the trip changes nothing". It still
      // catches a field nobody projected, which is what the property is for.
      // The user-facing half — an integral canvas comes back untouched — is
      // an example in geometry-projection.test.ts, where the numbers are
      // visible rather than drawn.
      const once = fromJsonCanvas(toJsonCanvas(canvas))
      expect(fromJsonCanvas(toJsonCanvas(once))).toEqual(once)
    },
  )

  it('drops an extension object with nothing in it rather than emitting it', () => {
    // A canonicalisation, not a loss: `x-whiteboard: {}` says what its absence
    // says. It is the one place the wire trip normalises instead of preserving,
    // so it is pinned by example rather than left to the property above.
    const bare = toJsonCanvas({ nodes: [], edges: [] })
    expect(bare).not.toHaveProperty('x-whiteboard')
    expect(fromJsonCanvas({ nodes: [], edges: [], 'x-whiteboard': {} })).toEqual({
      nodes: [],
      edges: [],
    })
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
        embed: { documentId: '01M231FG6BGKKWW4BAA6Z1C945', versionRef: 'v1' },
        facets: { 'visual.shape/v0': { kind: 'rect' } },
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
        bends: [{ x: 1, y: 1 }],
        facets: { 'visual.edges/v0': { routing: 'orthogonal' } },
      },
    ],
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
  }
}
