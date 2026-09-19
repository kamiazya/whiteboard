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

  it('leaves NEITHER format dropping anything, which is what the split bought', () => {
    // The headline, pinned so a later change to either ledger has to restate
    // it. Before ADR-0038 decision 2 this read `JSON Canvas dropped 4, OCIF
    // dropped 0`; splitting the relation from the ink took JSON Canvas's four
    // to zero as well — those rows WERE an edge's point ends, which the format
    // was right to refuse and which are no longer an edge's to have.
    //
    // OCIF's `native` rose 15 -> 23 in the same move, because a line lands on
    // `@ocif/arrow`, whose ends really are coordinates and which is the one
    // element shape the format gives a per-end marker. Under the old shape one
    // element served both meanings, so those positions were `degraded` for
    // every edge whether or not that edge was ink.
    //
    // ADR-0040 added three positions — the board's, a box's and a relation's
    // tag set — and both formats carry them on an extension: `extension`
    // 34 -> 37 and 29 -> 32, `native` and `dropped` unmoved. Neither format
    // has a classification vocabulary to state a tag natively.
    //
    // ADR-0038 decision 3 then took OCIF's resource into the model, and the
    // two tables moved in OPPOSITE directions on the same five rows — which
    // is the clearest thing either table has said about what the decision
    // bought. Five model positions (`type`/`text`/`file`/`url`/`subpath`)
    // became four (`resource.mimeType`/`content`/`location`/`subpath`), so
    // the totals fall by one each. JSON Canvas: 19 -> 17 native, 4 -> 5
    // degraded, because the format has a node KIND and no media type, and
    // `mimeType` now has to cross as one. OCIF: 5 -> 4 degraded with its
    // native count UNMOVED at 23 — the row that was degraded is simply GONE,
    // since the discriminator OCIF had no field for is no longer a field of
    // ours, and the three content rows it kept natively it still keeps.
    expect(kinds(JSON_CANVAS_PROJECTION)).toEqual({
      native: 17,
      extension: 37,
      degraded: 5,
      dropped: 0,
    })
    expect(kinds(OCIF_PROJECTION)).toEqual({
      native: 23,
      extension: 32,
      degraded: 4,
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
      'lines[].facets/*',
      'lines[].from.end',
      'lines[].from.point.x',
      'lines[].from.point.y',
      'lines[].id',
      'lines[].to.end',
      'lines[].to.point.x',
      'lines[].to.point.y',
      'nodes[].embed.documentId',
      'nodes[].facets/*',
      'nodes[].height',
      // OCIF's resource carries a media type; JSON Canvas's node kind does
      // not, so `image/png` on a file node comes back as the generic stream.
      'nodes[].resource.mimeType',
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
      'edges[].from.side',
      'edges[].label',
      'edges[].to.end',
      'edges[].to.side',
      'nodes[].background',
      'nodes[].backgroundStyle',
      'nodes[].color',
      'nodes[].label',
      'nodes[].resource.subpath',
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
