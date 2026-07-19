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
 *  (b) Stability — once a scene has been through parse once, serializing and
 *      re-parsing it again is a no-op: parse(serialize(parse(s))) equals
 *      parse(s).
 *  (c) Totality — for arbitrary JSON-like input, parseViewerScene either
 *      throws or returns a value that satisfies viewerSceneSchema. There is
 *      no third outcome (a silently coerced/partial value).
 */
import { describe, expect } from 'vitest'
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

  fcTest.prop([fc.jsonValue()], withDefaults())(
    'parseViewerScene either throws or returns a value satisfying viewerSceneSchema',
    (input) => {
      let result: unknown
      try {
        result = parseViewerScene(input)
      } catch {
        return
      }
      expect(viewerSceneSchema.safeParse(result).success).toBe(true)
    },
  )
})
