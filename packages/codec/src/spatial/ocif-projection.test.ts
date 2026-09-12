// The OCIF ledger, held in the same four directions as the JSON Canvas one
// (`.claude/rules/coverage-ledger.md`). A second projection is exactly where
// a ledger decays: the first one is written with the model fresh in mind, and
// the second is written by reading the first.
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { describe, expect, it } from 'vitest'
import { censusSpatialModel } from './census.js'
import type { OcifDocument, OcifExtension } from './ocif.js'
import { OCIF_PROJECTION } from './ocif-projection.js'
import { fromOcif, toOcif } from './ocif-projection-io.js'
import { JSON_CANVAS_PROJECTION, valueLeafPaths } from './projection.js'

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
      // correct the three entries written from the spec alone.
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
})

/**
 * The rung that turns the ledger from a claim into a guard, and the analogue
 * of `projection.test.ts`'s comparison against `strictDegrade`.
 *
 * OCIF has no strict mode to compare against — conformance REQUIRES a reader
 * to preserve an extension it does not understand, which is the whole reason
 * nothing in this ledger is `dropped`. So the thing to model is not a mode,
 * it is a READER: one that understands the format and none of this project's
 * extensions. Strip every `@whiteboard/*` entry and lift what is left.
 *
 * Without this, "extension" and "native" were two words in a table nothing
 * compared to behaviour — and the first run of it found the table wrong:
 * three facet buckets were declared `native` while the projection carried
 * them on a vendor key, so a conforming foreign tool would have preserved
 * them as an opaque blob rather than read them. They are ordinary OCIF
 * extensions now, which is what the claim always said.
 */
describe('the ledger agrees with what a conforming foreign reader keeps', () => {
  const canvas = fullyPopulatedCanvas()

  it('has a fixture that occupies every position the model can hold', () => {
    // Same reason as the JSON Canvas fixture's: a position the fixture stopped
    // covering would leave BOTH sides of the comparison below short, and the
    // equality would still hold — a guard weakened rather than broken.
    expect(valueLeafPaths(canvas)).toEqual(modelPaths)
  })

  it('loses exactly the positions the ledger calls extension — no more, no less', () => {
    const before = valueLeafPaths(canvas)
    const after = valueLeafPaths(fromOcif(withoutOurExtensions(toOcif(canvas))))

    const lost = before.filter((path) => !after.includes(path)).sort()
    const declared = modelPaths.filter((path) => OCIF_PROJECTION[path]?.kind === 'extension').sort()

    // Equality in both directions, which is the correction the JSON Canvas
    // comparison needed: filtering the ledger down to what was already lost
    // makes the declared set a subset by construction, so OVER-declaring — a
    // loss table telling a user a field does not survive when it does — passes
    // every other check.
    expect(lost).toEqual(declared)
    expect(lost.length).toBeGreaterThan(0)
  })

  it('keeps every degraded position, changed rather than dropped', () => {
    // What `degraded` promises and `extension` does not: the field is still
    // there after the trip, carrying something else. It is the only reason
    // this projection lifts from `@ocif/edge` and `@ocif/arrow` at all —
    // reading our own extension first would make every entry look native.
    const surviving = valueLeafPaths(fromOcif(withoutOurExtensions(toOcif(canvas))))
    const degraded = modelPaths.filter((path) => OCIF_PROJECTION[path]?.kind === 'degraded')
    expect(degraded.length).toBeGreaterThan(0)
    for (const path of degraded) expect(surviving).toContain(path)
  })

  it('states a facet as an ordinary extension, not as a payload on a vendor key', () => {
    // The shape behind `native`, pinned by example because the comparison
    // above only sees that the position survived. A foreign tool that knows
    // `visual.shape/v0` reads its properties where the format says they are.
    const projected = toOcif(canvas)
    const shape = projected.nodes?.[0]?.data?.find((entry) => entry.type === 'visual.shape/v0')
    expect(shape).toEqual({ type: 'visual.shape/v0', kind: 'rect' })
    expect(projected.data).toContainEqual({ type: 'visual.theme/v0', theme: 'sketch' })
  })
})

/** A conforming reader that understands OCIF and none of our extensions. */
function withoutOurExtensions(ocif: OcifDocument): OcifDocument {
  const keep = (data: readonly OcifExtension[] | undefined) => {
    const kept = (data ?? []).filter((entry) => !entry.type.startsWith('@whiteboard/'))
    return kept.length === 0 ? undefined : kept
  }
  return {
    ...ocif,
    data: keep(ocif.data),
    nodes: (ocif.nodes ?? []).map((node) => ({ ...node, data: keep(node.data) })),
  }
}

/** A canvas carrying every field position the model has, so a loss shows up. */
function fullyPopulatedCanvas(): SpatialCanvas {
  return {
    nodes: [
      {
        id: 'n1',
        type: 'text',
        x: 0,
        y: 0,
        width: 10,
        height: 10,
        text: 'a',
        color: '1',
        facets: { 'visual.shape/v0': { kind: 'rect' } },
      },
      { id: 'n2', type: 'file', x: 1, y: 1, width: 2, height: 2, file: 'a.png', subpath: '#x' },
      { id: 'n3', type: 'link', x: 2, y: 2, width: 2, height: 2, url: 'https://e.test/' },
      {
        // The embed rides the GROUP, which is the one node kind with no content
        // of its own to be shadowed by it. On any other kind the embed takes the
        // resource slot and the content moves onto an extension of ours — real,
        // and a different measurement from this one, so it is the round-trip
        // property's to cover rather than a second variable in this fixture.
        id: 'n4',
        type: 'group',
        x: 3,
        y: 3,
        width: 4,
        height: 4,
        label: 'g',
        background: 'b.png',
        backgroundStyle: 'cover',
        embed: { documentId: '01M231FG6BGKKWW4BAA6Z1C945', versionRef: 'v1' },
      },
    ],
    edges: [
      {
        id: 'e1',
        from: { kind: 'node', node: 'n1', side: 'right', end: 'none' },
        to: { kind: 'node', node: 'n2', side: 'left', end: 'arrow' },
        color: '2',
        label: 'l',
        bends: [{ x: 1, y: 1 }],
        facets: { 'visual.edges/v0': { routing: 'orthogonal' } },
      },
      // The free-ended edge, and the only way to occupy the four `point`
      // positions — an `@ocif/arrow` rather than an `@ocif/edge`, which is the
      // conflation ADR-0036 decision 2 splits.
      {
        id: 'e2',
        from: { kind: 'point', point: { x: 42, y: -7 } },
        to: { kind: 'point', point: { x: 43, y: -8 } },
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
