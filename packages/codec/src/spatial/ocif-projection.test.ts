// What is OCIF-SPECIFIC about this projection.
//
// The ledger's four directions, the comparison against what a conforming
// foreign reader keeps, and the round trip are in `codecs.property.test.ts`,
// asked of every registered format. What stays here is the thing only a SECOND
// format can say: how far OCIF reaches compared with JSON Canvas.
import { describe, expect, it } from 'vitest'
import { fullyPopulatedCanvas } from '../test-utils/fully-populated-canvas.js'
import { censusSpatialModel } from './census.js'
import { OCIF_PROJECTION } from './ocif-projection.js'
import { toOcif } from './ocif-projection-io.js'
import { JSON_CANVAS_PROJECTION } from './projection.js'

const census = censusSpatialModel([])
const modelPaths = [...census.paths, ...census.facetBuckets].sort()

describe('what the two formats reach, read side by side', () => {
  const kinds = (ledger: Readonly<Record<string, { kind: string }>>) => {
    const tally: Record<string, number> = { native: 0, extension: 0, degraded: 0, dropped: 0 }
    for (const path of modelPaths) {
      const kind = ledger[path]?.kind
      if (kind !== undefined) tally[kind] = (tally[kind] ?? 0) + 1
    }
    return tally
  }

  it('loses nothing this model holds, where JSON Canvas drops four positions', () => {
    // The headline of the measurement, pinned so a later change to either
    // ledger has to restate it. OCIF's `native` is wider because extensions
    // are part of the format rather than one vendor key: facets, an embedded
    // document and sub-pixel geometry are all things it can carry as itself.
    expect(kinds(JSON_CANVAS_PROJECTION)).toEqual({
      native: 21,
      extension: 16,
      degraded: 4,
      dropped: 4,
    })
    expect(kinds(OCIF_PROJECTION)).toEqual({
      native: 15,
      extension: 21,
      degraded: 9,
      // NOTHING is dropped. Every position this model can hold survives a
      // round trip through OCIF — which JSON Canvas cannot say, and which is
      // the headline of the measurement once the projection existed to
      // correct the entries written from the spec alone.
      dropped: 0,
    })
  })

  it('names the positions OCIF can state that JSON Canvas cannot', () => {
    const gained = modelPaths.filter(
      (path) =>
        OCIF_PROJECTION[path]?.kind === 'native' && JSON_CANVAS_PROJECTION[path]?.kind !== 'native',
    )
    expect(gained.sort()).toEqual([
      'edges[].facets/*',
      'facets/*',
      'nodes[].embed.documentId',
      'nodes[].facets/*',
      'nodes[].height',
      'nodes[].width',
      'nodes[].x',
      'nodes[].y',
    ])
  })

  it('names the positions JSON Canvas states that OCIF turns into something else', () => {
    const lost = modelPaths.filter(
      (path) =>
        JSON_CANVAS_PROJECTION[path]?.kind === 'native' && OCIF_PROJECTION[path]?.kind !== 'native',
    )
    expect(lost.sort()).toEqual([
      'edges[].color',
      'edges[].from.end',
      'edges[].from.kind',
      'edges[].from.side',
      'edges[].label',
      'edges[].to.end',
      'edges[].to.kind',
      'edges[].to.side',
      'nodes[].background',
      'nodes[].backgroundStyle',
      'nodes[].color',
      'nodes[].label',
      'nodes[].subpath',
      'nodes[].type',
    ])
  })

  it('states a facet as an ordinary extension, not as a payload on a vendor key', () => {
    // The SHAPE behind `native`, pinned by example because the registry's
    // comparison only sees that the position survived a foreign reader. A
    // foreign tool that knows `visual.shape/v0` reads its properties where the
    // format says they are.
    const projected = toOcif(fullyPopulatedCanvas())
    const shape = projected.nodes?.[0]?.data?.find((entry) => entry.type === 'visual.shape/v0')
    expect(shape).toEqual({ type: 'visual.shape/v0', kind: 'rect' })
    expect(projected.data).toContainEqual({ type: 'visual.theme/v0', theme: 'sketch' })
  })
})
