/**
 * Property-based coverage for the scene parse/serialize boundary.
 *
 * serializeSceneAsExcalidrawJson / parseViewerScene are NOT a strict
 * round-trip pair: serialize drops isDeleted elements, keeps only the
 * gridSize/viewBackgroundColor appState fields, and fills in defaults for
 * fields the caller omitted. The three properties fixed here are the actual
 * contract, not a naive round-trip:
 *
 *  (a) Normalization round-trip — parse(serialize(x)) equals an explicitly
 *      computed normalize(x) (live elements only, supported appState fields
 *      only, defaults applied) for any input built from the supported shape.
 *  (b) Stability — for a scene already in the *normalized* shape (live
 *      elements only, appState limited to gridSize/viewBackgroundColor —
 *      i.e. anything produced by serializeSceneAsExcalidrawJson, which is
 *      what this suite's generators build), serializing it again and
 *      re-parsing is a no-op: parse(serialize(parse(s))) equals parse(s).
 *      This does NOT hold for arbitrary parser-accepted input — parseViewerScene
 *      itself accepts deleted elements and extra appState fields (it does not
 *      normalize on the way in), so a raw scene carrying either loses that
 *      information the moment it is serialized. See the dedicated
 *      "lossy input" test below for that documented, non-round-tripping case.
 *  (c) Totality — for JSON-like input, parseViewerScene either throws or
 *      returns a value that satisfies viewerSceneSchema. There is no third
 *      outcome (a silently coerced/partial value). The input arbitrary mixes
 *      fully generic JSON with scene-shaped values so the successful-parse
 *      branch is actually exercised, not just the catch branch.
 */
import { describe, expect, it } from 'vitest'
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types'
import { parseViewerScene, serializeSceneAsExcalidrawJson, viewerSceneSchema } from './scene.js'
import { fc, fcTest, withDefaults } from './test-utils/fast-check.js'

// Opaque pass-through fields (id/type/x/y) plus one extra unknown-content
// field (`tag`) so the arbitrary exercises the "unknown keys survive"
// pass-through contract, not just the fields this package happens to read.
const elementArb = fc.record(
  {
    id: fc.string({ minLength: 1, maxLength: 8 }),
    type: fc.constantFrom('rectangle', 'ellipse', 'text', 'image'),
    x: fc.integer({ min: -1000, max: 1000 }),
    y: fc.integer({ min: -1000, max: 1000 }),
    isDeleted: fc.boolean(),
    tag: fc.string({ maxLength: 5 }),
  },
  { requiredKeys: ['id', 'type', 'x', 'y'] },
) as fc.Arbitrary<ExcalidrawElement>

// Only the fields serializeSceneAsExcalidrawJson actually reads — any other
// appState field is dropped by design, so it is deliberately excluded here.
const appStateArb = fc.record(
  {
    gridSize: fc.oneof(fc.constant(null), fc.integer({ min: 0, max: 200 })),
    viewBackgroundColor: fc.string({ minLength: 1, maxLength: 7 }),
  },
  { requiredKeys: [] },
)

const filesArb = fc.dictionary(
  fc.string({ minLength: 1, maxLength: 6 }),
  fc.record({ id: fc.string(), mimeType: fc.constant('image/png') }),
) as fc.Arbitrary<Record<string, unknown>>

// Scene-shaped arbitraries for the totality property below. Reusing
// elementArb/appStateArb/filesArb keeps them consistent with the schemas
// those helpers are meant to satisfy, so a meaningful share of generated
// totality inputs actually reach the successful-parse branch instead of
// every sample dead-ending in the catch clause.
const validExcalidrawDocArb = fc.record({
  type: fc.constant('excalidraw' as const),
  version: fc.constant(2 as const),
  source: fc.string(),
  elements: fc.array(elementArb, { maxLength: 4 }),
  appState: appStateArb,
  files: filesArb,
})

const validStructuredContentArb = fc.record(
  {
    elements: fc.array(elementArb, { maxLength: 4 }),
    appState: appStateArb,
    files: filesArb,
  },
  { requiredKeys: ['elements'] },
)

function normalize(
  elements: readonly ExcalidrawElement[],
  appState: { gridSize?: number | null; viewBackgroundColor?: string },
  files: Record<string, unknown>,
) {
  return {
    elements: elements.filter((el) => !(el as { isDeleted?: boolean }).isDeleted),
    appState: {
      gridSize: appState.gridSize ?? null,
      viewBackgroundColor: appState.viewBackgroundColor ?? '#ffffff',
    },
    files,
  }
}

describe('scene parse/serialize properties', () => {
  fcTest.prop([fc.array(elementArb, { maxLength: 6 }), appStateArb, filesArb], withDefaults())(
    'parse(serialize(x)) equals the explicitly computed normalize(x)',
    (elements, appState, files) => {
      const doc = serializeSceneAsExcalidrawJson(elements, appState, files as never)
      const parsed = parseViewerScene(doc)
      expect(parsed).toEqual(normalize(elements, appState, files))
    },
  )

  fcTest.prop([fc.array(elementArb, { maxLength: 6 }), appStateArb, filesArb], withDefaults())(
    'parse(serialize(parse(s))) equals parse(s) for any serializable scene s',
    (elements, appState, files) => {
      const s = serializeSceneAsExcalidrawJson(elements, appState, files as never)
      const first = parseViewerScene(s)
      const second = serializeSceneAsExcalidrawJson(
        first.elements as readonly ExcalidrawElement[],
        first.appState,
        first.files as never,
      )
      const finalParsed = parseViewerScene(second)
      expect(finalParsed).toEqual(first)
    },
  )

  it('parseViewerScene either throws or returns a value satisfying viewerSceneSchema', () => {
    // fc.jsonValue() alone almost never produces the specific object shape
    // parseViewerScene accepts, which would make the property vacuously true
    // (every sample takes the catch branch). Mixing in scene-shaped
    // arbitraries guarantees a real share of successful parses, so the
    // schema assertion below is actually exercised.
    const totalityInputArb = fc.oneof(
      { arbitrary: fc.jsonValue(), weight: 3 },
      { arbitrary: validExcalidrawDocArb, weight: 1 },
      { arbitrary: validStructuredContentArb, weight: 1 },
    )
    let successCount = 0
    fc.assert(
      fc.property(totalityInputArb, (input) => {
        let result: unknown
        try {
          result = parseViewerScene(input)
        } catch {
          return
        }
        successCount += 1
        expect(viewerSceneSchema.safeParse(result).success).toBe(true)
      }),
      { numRuns: 200 },
    )
    expect(successCount).toBeGreaterThan(0)
  })

  it('parsing a raw scene with deleted elements and extra appState fields loses that data on re-serialization', () => {
    // parseViewerScene itself does not normalize its input — it accepts
    // deleted elements and arbitrary extra appState fields (appStateShape's
    // .catchall). serializeSceneAsExcalidrawJson does normalize, dropping
    // both. So a raw, parser-accepted scene is not stable across a
    // serialize/parse round trip the way an already-normalized scene is
    // (see property (b) above) — this test documents that real, current
    // behavior instead of asserting the false round-trip invariant.
    const raw = {
      elements: [{ id: 'gone', type: 'rectangle', isDeleted: true }],
      appState: { gridStep: 5, theme: 'dark' },
      files: {},
    }

    const first = parseViewerScene(raw)
    expect(first.elements).toEqual(raw.elements)
    expect(first.appState).toMatchObject({ gridStep: 5, theme: 'dark' })

    const reserialized = serializeSceneAsExcalidrawJson(
      first.elements as readonly ExcalidrawElement[],
      first.appState,
      first.files as never,
    )
    const second = parseViewerScene(reserialized)

    expect(second.elements).toEqual([])
    expect(second.appState).toEqual({ gridSize: null, viewBackgroundColor: '#ffffff' })
    expect(second).not.toEqual(first)
  })
})
