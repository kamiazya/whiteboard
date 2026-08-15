import { describe, expect } from 'vitest'
import {
  coreFacetsSchema,
  extensionFacetsSchema,
  facetsRawSchema,
  RESERVED_ROOT_KEYS,
} from './facets.js'
import { canvasIdSchema } from './ids.js'
import { markdownCanvasSchema } from './markdown.js'
import {
  mdastFlowContentSchema,
  mdastPhrasingContentSchema,
  mdastRootSchema,
} from './mdast/index.js'
import { canvasMetaSchema } from './meta.js'
import {
  canvasEdgeSchema,
  spatialCanvasSchema,
  spatialNodeSchema,
  xWhiteboardSchema,
} from './spatial.js'
import {
  canonicalUlidArbitrary,
  canvasEdgeArbitrary,
  canvasMetaArbitrary,
  coreFacetsArbitrary,
  extensionFacetsArbitrary,
  facetsRawArbitrary,
  markdownCanvasArbitrary,
  mdastFlowContentArbitrary,
  mdastPhrasingContentArbitrary,
  mdastRootArbitrary,
  spatialNodeArbitrary,
  xWhiteboardArbitrary,
} from './test-utils/arbitraries.js'
import { fc, fcTest, withDefaults } from './test-utils/fast-check.js'

describe('arbitrary-conformance: every generator agrees with its schema', () => {
  fcTest.prop([canvasMetaArbitrary], withDefaults())('canvasMetaSchema', (value) => {
    expect(canvasMetaSchema.safeParse(value).success).toBe(true)
  })

  fcTest.prop([coreFacetsArbitrary], withDefaults())('coreFacetsSchema', (value) => {
    expect(coreFacetsSchema.safeParse(value).success).toBe(true)
  })

  fcTest.prop([extensionFacetsArbitrary], withDefaults())('extensionFacetsSchema', (value) => {
    expect(extensionFacetsSchema.safeParse(value).success).toBe(true)
  })

  fcTest.prop([facetsRawArbitrary], withDefaults())('facetsRawSchema', (value) => {
    expect(facetsRawSchema.safeParse(value).success).toBe(true)
  })

  fcTest.prop([spatialNodeArbitrary], withDefaults())('spatialNodeSchema', (value) => {
    expect(spatialNodeSchema.safeParse(value).success).toBe(true)
  })

  fcTest.prop([canvasEdgeArbitrary], withDefaults())('canvasEdgeSchema', (value) => {
    expect(canvasEdgeSchema.safeParse(value).success).toBe(true)
  })

  fcTest.prop([xWhiteboardArbitrary], withDefaults())('xWhiteboardSchema', (value) => {
    expect(xWhiteboardSchema.safeParse(value).success).toBe(true)
  })

  fcTest.prop([markdownCanvasArbitrary], withDefaults())('markdownCanvasSchema', (value) => {
    expect(markdownCanvasSchema.safeParse(value).success).toBe(true)
  })

  fcTest.prop([canonicalUlidArbitrary], withDefaults())('canvasIdSchema', (value) => {
    expect(canvasIdSchema.safeParse(value).success).toBe(true)
  })

  fcTest.prop(
    [fc.integer({ min: 0, max: 3 }).chain((depth) => mdastPhrasingContentArbitrary(depth))],
    withDefaults({ numRuns: 50 }),
  )('mdastPhrasingContentSchema', (value) => {
    expect(mdastPhrasingContentSchema.safeParse(value).success).toBe(true)
  })

  fcTest.prop(
    [fc.integer({ min: 0, max: 3 }).chain((depth) => mdastFlowContentArbitrary(depth))],
    withDefaults({ numRuns: 50 }),
  )('mdastFlowContentSchema', (value) => {
    expect(mdastFlowContentSchema.safeParse(value).success).toBe(true)
  })

  fcTest.prop(
    [fc.integer({ min: 0, max: 3 }).chain((depth) => mdastRootArbitrary(depth))],
    withDefaults({ numRuns: 50 }),
  )('mdastRootSchema', (value) => {
    expect(mdastRootSchema.safeParse(value).success).toBe(true)
  })
})

describe('mdast content-model: disallowed cross-category child always rejects', () => {
  // A misplaced-child pool built from kinds whose content category is
  // genuinely disjoint from a paragraph's allowed content (phrasing only).
  // `html` is deliberately excluded — it is dual-category (both flow and
  // phrasing) so grafting it under a paragraph is actually valid mdast.
  const flowOnlyNodeArbitrary = fc.oneof(
    fc.constant({ type: 'thematicBreak' }),
    fc
      .record({ value: fc.string({ maxLength: 10 }) })
      .map(({ value }) => ({ type: 'code', value })),
    fc
      .record({ identifier: fc.string({ minLength: 1, maxLength: 10 }), url: fc.webUrl() })
      .map(({ identifier, url }) => ({ type: 'definition', identifier, url })),
    fc.constant({ type: 'root', children: [] }),
    fc.constant({ type: 'listItem', children: [] }),
    fc.constant({ type: 'tableRow', children: [] }),
  )

  fcTest.prop([flowOnlyNodeArbitrary], withDefaults())(
    'a flow-only or structural node grafted as a paragraph child fails to parse',
    (misplacedChild) => {
      const grafted = { type: 'paragraph', children: [misplacedChild] }
      expect(mdastFlowContentSchema.safeParse(grafted).success).toBe(false)
    },
  )

  const nonFlowNodeArbitrary = fc.oneof(
    fc
      .record({ value: fc.string({ maxLength: 10 }) })
      .map(({ value }) => ({ type: 'text', value })),
    fc.constant({ type: 'break' }),
    fc.constant({ type: 'root', children: [] }),
    fc.constant({ type: 'tableCell', children: [] }),
  )

  fcTest.prop([nonFlowNodeArbitrary], withDefaults())(
    'a non-flow node grafted as a blockquote child fails to parse',
    (misplacedChild) => {
      const grafted = { type: 'blockquote', children: [misplacedChild] }
      expect(mdastFlowContentSchema.safeParse(grafted).success).toBe(false)
    },
  )
})

describe('mdast schemas are pure and idempotent', () => {
  fcTest.prop(
    [fc.integer({ min: 0, max: 3 }).chain((depth) => mdastFlowContentArbitrary(depth))],
    withDefaults(),
  )('safeParse does not mutate its input', (value) => {
    const before = structuredClone(value)
    mdastFlowContentSchema.safeParse(value)
    expect(value).toEqual(before)
  })

  fcTest.prop(
    [fc.integer({ min: 0, max: 3 }).chain((depth) => mdastFlowContentArbitrary(depth))],
    withDefaults(),
  )('parsing the same valid tree twice yields deeply-equal outputs', (value) => {
    const once = mdastFlowContentSchema.parse(value)
    const twice = mdastFlowContentSchema.parse(once)
    expect(twice).toEqual(once)
  })
})

describe('parse idempotence', () => {
  fcTest.prop([coreFacetsArbitrary], withDefaults())('coreFacetsSchema', (value) => {
    const once = coreFacetsSchema.parse(value)
    const twice = coreFacetsSchema.parse(once)
    expect(twice).toEqual(once)
  })

  fcTest.prop([spatialNodeArbitrary], withDefaults())('spatialNodeSchema', (value) => {
    const once = spatialNodeSchema.parse(value)
    const twice = spatialNodeSchema.parse(once)
    expect(twice).toEqual(once)
  })
})

describe('unknown-domain / unknown-root-key preservation', () => {
  fcTest.prop([extensionFacetsArbitrary], withDefaults())(
    'extensionFacetsSchema preserves unknown-domain payloads byte-identical',
    (value) => {
      const parsed = extensionFacetsSchema.parse(value)
      expect(parsed).toEqual(value)
    },
  )

  fcTest.prop([facetsRawArbitrary], withDefaults())(
    'facetsRawSchema preserves non-reserved root keys byte-identical',
    (value) => {
      const parsed = facetsRawSchema.parse(value)
      expect(parsed).toEqual(value)
    },
  )
})

describe('bucket disjointness', () => {
  fcTest.prop([fc.constantFrom(...RESERVED_ROOT_KEYS)], withDefaults())(
    'a reserved root key is never valid as a lone facetsRaw key',
    (key) => {
      expect(facetsRawSchema.safeParse({ [key]: 'x' }).success).toBe(false)
    },
  )
})

describe('JSON Canvas 1.0 conformance invariants', () => {
  fcTest.prop(
    [
      fc.record({
        id: fc.string({ minLength: 1, maxLength: 10 }),
        x: fc.float({ noNaN: true }).filter((n) => !Number.isInteger(n)),
        y: fc.integer(),
        width: fc.integer(),
        height: fc.integer(),
        type: fc.constant('text' as const),
        text: fc.string(),
      }),
    ],
    withDefaults(),
  )('non-integer geometry always rejects', (value) => {
    expect(spatialNodeSchema.safeParse(value).success).toBe(false)
  })

  fcTest.prop([fc.tuple(spatialNodeArbitrary, spatialNodeArbitrary)], withDefaults())(
    'duplicating a node id flips spatialCanvasSchema from accept to reject',
    ([nodeA, nodeB]) => {
      const distinct = {
        nodes: [
          { ...nodeA, id: 'a' },
          { ...nodeB, id: 'b' },
        ],
        edges: [],
      }
      const duplicated = {
        nodes: [
          { ...nodeA, id: 'a' },
          { ...nodeB, id: 'a' },
        ],
        edges: [],
      }
      expect(spatialCanvasSchema.safeParse(distinct).success).toBe(true)
      expect(spatialCanvasSchema.safeParse(duplicated).success).toBe(false)
    },
  )
})

describe('canvasIdSchema ULID mutations always reject', () => {
  fcTest.prop([canonicalUlidArbitrary], withDefaults())(
    'truncating the last character rejects',
    (ulid) => {
      expect(canvasIdSchema.safeParse(ulid.slice(0, -1)).success).toBe(false)
    },
  )

  fcTest.prop([canonicalUlidArbitrary], withDefaults())(
    'appending an extra character rejects',
    (ulid) => {
      expect(canvasIdSchema.safeParse(`${ulid}0`).success).toBe(false)
    },
  )

  fcTest.prop([canonicalUlidArbitrary, fc.constantFrom('I', 'L', 'O', 'U')], withDefaults())(
    'replacing the second character with an excluded Crockford char rejects',
    (ulid, excludedChar) => {
      const mutated = ulid[0] + excludedChar + ulid.slice(2)
      expect(canvasIdSchema.safeParse(mutated).success).toBe(false)
    },
  )

  fcTest.prop([canonicalUlidArbitrary, fc.constantFrom('8', '9', 'A', 'Z')], withDefaults())(
    'replacing the first character with 8-9/A-Z rejects',
    (ulid, firstChar) => {
      const mutated = firstChar + ulid.slice(1)
      expect(canvasIdSchema.safeParse(mutated).success).toBe(false)
    },
  )
})
