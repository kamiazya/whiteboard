// What holds across FORMATS rather than within one — the question a second
// projection made askable and a third will make load-bearing.
//
// Everything here is driven by `SPATIAL_CODECS`, so a format added to the
// registry is asked all of it without anybody writing a line, and a format
// added to the PACKAGE and not to the registry fails the ledger at the bottom.
import { spatialCanvasArbitrary } from '@kamiazya/whiteboard-model/test-utils'
import { describe, expect, it } from 'vitest'
import { fcTest, withDefaults } from '../test-utils/fast-check.js'
import { fullyPopulatedCanvas } from '../test-utils/fully-populated-canvas.js'
import { censusSpatialModel } from './census.js'
import { foreignRoundTrip, roundTrip, SPATIAL_CODECS, type SpatialCodec, settle } from './codecs.js'
import { valueLeafPaths } from './projection.js'

const census = censusSpatialModel([])
const modelPaths = [...census.paths, ...census.facetBuckets].sort()

/**
 * Each UNORDERED pair once. `rt_b(rt_a(c)) === rt_a(rt_b(c))` is symmetric in
 * a and b, so driving both orderings states the same equation twice.
 */
const pairs: readonly (readonly [SpatialCodec, SpatialCodec])[] = SPATIAL_CODECS.flatMap(
  (a, index) => SPATIAL_CODECS.slice(index + 1).map((b) => [a, b] as const),
)

describe.each(
  SPATIAL_CODECS.map((codec) => [codec.id, codec] as const),
)('every registered codec: %s', (_id, codec) => {
  fcTest.prop([spatialCanvasArbitrary], withDefaults())(
    'is idempotent — a document that has been through the format survives it again unchanged',
    (canvas) => {
      // Equality with the INPUT holds only over the expressible subset, which
      // differs per format; idempotence is the statement every format can
      // make, and it is not the weaker one — the expressible subset IS the
      // projection's image, so this says "inside the subset the trip changes
      // nothing".
      const once = roundTrip(codec, canvas)
      expect(roundTrip(codec, once)).toEqual(once)
    },
  )

  fcTest.prop([spatialCanvasArbitrary], withDefaults())(
    'never answers with something its own reader refuses',
    (canvas) => {
      // `roundTrip` throws rather than returning when the read fails, so the
      // assertion is that it returns at all. A format whose writer and whose
      // schema disagree is drift only a reader would ever find.
      expect(roundTrip(codec, canvas)).toBeDefined()
    },
  )
})

describe('what a document costs is what each ledger says it costs', () => {
  // The per-format behaviour comparison, asked of every entry instead of
  // written once per format. The fixture is shared for the same reason: two
  // fixtures are two chances for one of them to stop covering a position, and
  // a position missing from a fixture weakens the equality below in silence.
  const canvas = fullyPopulatedCanvas()

  it('has a fixture that occupies every position the model can hold', () => {
    expect(valueLeafPaths(canvas)).toEqual(modelPaths)
  })

  it.each(
    SPATIAL_CODECS.map((codec) => [codec.id, codec] as const),
  )('%s loses exactly the positions its ledger calls extension or dropped — no more, no less', (_id, codec) => {
    const before = valueLeafPaths(canvas)
    const after = valueLeafPaths(foreignRoundTrip(codec, canvas))
    const lost = before.filter((path) => !after.includes(path)).sort()
    // `extension` AND `dropped`, never "everything the ledger does not call
    // native": a `degraded` position is still THERE after the trip — it is
    // the value that changed, not the field.
    const declared = modelPaths
      .filter((path) => {
        const kind = codec.projection[path]?.kind
        return kind === 'extension' || kind === 'dropped'
      })
      .sort()

    // Equality in BOTH directions. Filtering the ledger down to what was
    // already lost makes the declared set a subset by construction, so
    // over-declaring — a loss table telling a user a field disappears when it
    // never does — passes every other guard. Measured once, on JSON Canvas:
    // marking `nodes[].color` as extension left the whole suite green.
    expect(lost).toEqual(declared)
    expect(lost.length).toBeGreaterThan(0)
  })

  it.each(
    SPATIAL_CODECS.map((codec) => [codec.id, codec] as const),
  )('%s carries every position its ledger does not call dropped, all the way out and back', (_id, codec) => {
    // The companion to the comparison above, and the stronger of the two.
    // That one asks what a FOREIGN reader loses; this asks what OUR OWN
    // round trip loses, which the ledger says is only what it calls
    // `dropped`. Without it a projection that quietly stopped carrying a
    // field would pass everything: dropping is idempotent, so the
    // idempotence property is happy; the field is already declared lost to a
    // foreign reader, so the ledger comparison is happy; and deletion
    // commutes with every other codec's losses, so both cross-format
    // properties below are happy too. Measured: removing OCIF's edge label
    // from the lift fails this and only this, out of nineteen.
    const before = valueLeafPaths(canvas)
    const after = valueLeafPaths(roundTrip(codec, canvas))
    const lost = before.filter((path) => !after.includes(path)).sort()
    const declared = modelPaths.filter((path) => codec.projection[path]?.kind === 'dropped').sort()
    expect(lost).toEqual(declared)
  })

  it.each(
    SPATIAL_CODECS.map((codec) => [codec.id, codec] as const),
  )('%s keeps every degraded position, changed rather than dropped', (_id, codec) => {
    const surviving = valueLeafPaths(foreignRoundTrip(codec, canvas))
    const degraded = modelPaths.filter((path) => codec.projection[path]?.kind === 'degraded')
    expect(degraded.length).toBeGreaterThan(0)
    for (const path of degraded) expect(surviving).toContain(path)
  })
})

describe('the formats agree with each other, not merely with themselves', () => {
  fcTest.prop([spatialCanvasArbitrary], withDefaults())(
    'the ORDER a document passes through the formats in does not change where it lands',
    (canvas) => {
      // The cross-format claim, and the only shape of it that is both true and
      // checkable. "Write with any codec, read with any codec, get the same
      // data" cannot hold literally — each format refuses a different set of
      // things, so a document that has been through one is not the document
      // that went in. What CAN hold is confluence: whatever each format takes
      // away, taking them away in either order leaves the same document.
      //
      // Measured, because a property that passes on the first run has not yet
      // shown it can fail. Teaching OCIF its own precision rule (round to one
      // decimal, against JSON Canvas's integer) turns this red and leaves the
      // other eighteen green: 0.46 rounds to 0 through JSON Canvas first and
      // to 1 the other way round. That is the class it is for, and a third
      // format with a grid snap or a size clamp is how it arrives.
      //
      // The same measurement says what this CANNOT see. Deleting a field is
      // the commonest loss and it commutes with everything, so a projection
      // that quietly stopped carrying edge labels passes this untouched — the
      // completeness property above is what catches that one, and it did.
      for (const [first, second] of pairs) {
        expect(roundTrip(second, roundTrip(first, canvas))).toEqual(
          roundTrip(first, roundTrip(second, canvas)),
        )
      }
    },
  )

  fcTest.prop([spatialCanvasArbitrary], withDefaults())(
    'a settled document is a fixed point of EVERY format, so nothing is lost twice',
    (canvas) => {
      // What a user can actually be promised: once a document has been through
      // the formats, passing it through any of them again costs nothing. The
      // set this is true of is derived from the registry rather than written
      // down, so a third format narrows it without anyone editing a list.
      const settled = settle(canvas)
      for (const codec of SPATIAL_CODECS) expect(roundTrip(codec, settled)).toEqual(settled)
    },
  )

  it('settles onto something worth having, rather than onto the empty canvas', () => {
    // A confluence property over two functions that both answered `{nodes: [],
    // edges: []}` would pass perfectly. This is what says the agreement is
    // about a document.
    const settled = settle(fullyPopulatedCanvas())
    expect(settled.nodes.length).toBeGreaterThanOrEqual(4)
    expect(settled.edges.length).toBeGreaterThanOrEqual(1)
    expect(valueLeafPaths(settled).length).toBeGreaterThan(modelPaths.length / 2)
  })
})

describe('the registry is complete in the two directions a type can see', () => {
  // The third direction — a projection table in the package that no codec
  // points at — cannot be checked from here. It needs to read the package's
  // own source, and `import.meta.glob` would mean putting `vite/client` in
  // this package's `types`, which drags the DOM lib into a shared-layer
  // package whose whole tsconfig exists to keep it out. So that direction is
  // `tools/arch-lint`'s `repo-coverage.test.ts`, beside the repo's other
  // "a file appeared and nothing classified it" scans.

  it.each(
    SPATIAL_CODECS.map((codec) => [codec.id, codec] as const),
  )('%s gives every lossy entry a reason a reader can act on', (_id, codec) => {
    const vague = Object.entries(codec.projection).filter(([, projection]) => {
      if (projection.kind === 'degraded') return projection.to.length < 12
      if (projection.kind === 'dropped') return projection.why.length < 12
      return false
    })
    expect(vague).toEqual([])
  })

  it.each(
    SPATIAL_CODECS.map((codec) => [codec.id, codec] as const),
  )("%s's ledger covers exactly the positions the model can hold", (_id, codec) => {
    expect(Object.keys(codec.projection).sort()).toEqual(modelPaths)
  })

  it('gives each codec its own ledger, so two entries cannot share one table', () => {
    // Registering a second codec against the first one's table would make
    // every property above pass twice over one format.
    expect(new Set(SPATIAL_CODECS.map((codec) => codec.projection)).size).toBe(
      SPATIAL_CODECS.length,
    )
  })

  it('has an entry for every id, and an id for every entry', () => {
    const ids = SPATIAL_CODECS.map((codec) => codec.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.length).toBeGreaterThanOrEqual(2)
  })
})
