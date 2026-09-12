// The OCIF ledger, held in the same four directions as the JSON Canvas one
// (`.claude/rules/coverage-ledger.md`). A second projection is exactly where
// a ledger decays: the first one is written with the model fresh in mind, and
// the second is written by reading the first.
import { describe, expect, it } from 'vitest'
import { censusSpatialModel } from './census.js'
import { OCIF_PROJECTION } from './ocif-projection.js'
import { JSON_CANVAS_PROJECTION } from './projection.js'

const census = censusSpatialModel([])
const modelPaths = [...census.paths, ...census.facetBuckets].sort()

describe('the OCIF ledger covers the model, and only the model', () => {
  it('has an entry for every field position the model can hold', () => {
    expect(modelPaths.filter((path) => OCIF_PROJECTION[path] === undefined)).toEqual([])
  })

  it('has no entry naming a field position the model no longer holds', () => {
    expect(Object.keys(OCIF_PROJECTION).filter((path) => !modelPaths.includes(path))).toEqual([])
  })

  it('makes every degraded or dropped entry say what it costs', () => {
    const vague = Object.entries(OCIF_PROJECTION).filter(([, projection]) => {
      if (projection.kind === 'degraded') return projection.to.length < 12
      if (projection.kind === 'dropped') return projection.why.length < 12
      return false
    })
    expect(vague).toEqual([])
  })

  it('covers exactly the same positions as the JSON Canvas ledger', () => {
    // Not a restatement of the two directions above: it is what catches a
    // position added to the model and given an entry in ONE ledger, which is
    // the likeliest way these two drift now that there are two.
    expect(Object.keys(OCIF_PROJECTION).sort()).toEqual(Object.keys(JSON_CANVAS_PROJECTION).sort())
  })
})

describe('what the two formats reach, read side by side', () => {
  const kinds = (ledger: Readonly<Record<string, { kind: string }>>) => {
    const tally: Record<string, number> = { native: 0, extension: 0, degraded: 0, dropped: 0 }
    for (const path of modelPaths) {
      const kind = ledger[path]?.kind
      if (kind !== undefined) tally[kind] = (tally[kind] ?? 0) + 1
    }
    return tally
  }

  it('OCIF states more of this model than JSON Canvas does', () => {
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
      extension: 17,
      degraded: 11,
      dropped: 2,
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
})
