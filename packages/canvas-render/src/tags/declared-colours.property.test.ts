// The declared layer's colouring over random boards and libraries: what it
// may never do (repaint a colour the author set), what it must be (a
// function of the board alone, applied once or twice alike), and the one
// rule that says when a colour lands — exactly one declared colour among
// the thing's tags, stated here from the declaration and not from the code.
import type { CanvasColor, SpatialCanvas } from '@kamiazya/whiteboard-model'
import { parseScopedTag } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import type { TagLibrary } from '@kamiazya/whiteboard-plugin-visual'
import { describe, expect } from 'vitest'
import { fc, fcTest, withDefaults } from '../test-utils/fast-check.js'
import { withDeclaredColours } from './declared-colours.js'

const KEYS = ['health', 'tier', 'region'] as const
const VALUES = ['ok', 'failing', 'web', 'db'] as const
const colour = fc.constantFrom<CanvasColor>('1', '2', '3', '4', '5', '6', '#ff0000')
const tag = fc.oneof(
  fc.tuple(fc.constantFrom(...KEYS), fc.constantFrom(...VALUES)).map(([k, v]) => `${k}:${v}`),
  fc.constantFrom('draft', 'reviewed', 'Not:Scoped'),
)
const library: fc.Arbitrary<TagLibrary> = fc
  .dictionary(
    fc.constantFrom(...KEYS),
    fc.record({
      exclusive: fc.option(fc.boolean(), { nil: undefined }),
      values: fc.option(
        fc.dictionary(
          fc.constantFrom(...VALUES),
          fc.record({ color: fc.option(colour, { nil: undefined }) }),
        ),
        { nil: undefined },
      ),
    }),
  )
  .map((keys) => keys as TagLibrary)
const canvas: fc.Arbitrary<SpatialCanvas> = fc
  .array(
    fc.record({
      tags: fc.option(fc.uniqueArray(tag, { maxLength: 3 }), { nil: undefined }),
      color: fc.option(colour, { nil: undefined }),
    }),
    { maxLength: 6 },
  )
  .map((rows) => ({
    nodes: rows.map((row, i) =>
      textNode({
        id: `n${i}`,
        text: `n${i}`,
        x: i * 200,
        y: 0,
        width: 100,
        height: 50,
        ...(row.tags === undefined ? {} : { tags: row.tags }),
        ...(row.color === undefined ? {} : { color: row.color }),
      }),
    ),
    edges:
      rows.length < 2
        ? []
        : [
            {
              id: 'e',
              from: { node: 'n0' },
              to: { node: 'n1' },
              ...(rows[0]?.tags === undefined ? {} : { tags: rows[0].tags }),
            },
          ],
  }))

/** The rule, from the declaration: the distinct colours the library gives this thing's tags. */
function declaredColours(tags: readonly string[] | undefined, lib: TagLibrary): Set<string> {
  const out = new Set<string>()
  for (const t of tags ?? []) {
    const scoped = parseScopedTag(t)
    const c = scoped === undefined ? undefined : lib[scoped.key]?.values?.[scoped.value]?.color
    if (c !== undefined) out.add(c)
  }
  return out
}

describe('withDeclaredColours', () => {
  fcTest.prop([canvas, library], withDefaults())(
    'never repaints a colour the thing carries itself',
    (c, lib) => {
      const out = withDeclaredColours(c, lib)
      for (const [i, node] of c.nodes.entries()) {
        if (node.color !== undefined) expect(out.nodes[i]?.color).toBe(node.color)
      }
      for (const [i, edge] of c.edges.entries()) {
        if (edge.color !== undefined) expect(out.edges[i]?.color).toBe(edge.color)
      }
    },
  )

  fcTest.prop([canvas, library], withDefaults())(
    'colours a thing iff exactly one colour is declared for its tags',
    (c, lib) => {
      const out = withDeclaredColours(c, lib)
      for (const [i, node] of c.nodes.entries()) {
        if (node.color !== undefined) continue
        const declared = declaredColours(node.tags, lib)
        expect(out.nodes[i]?.color).toBe(declared.size === 1 ? [...declared][0] : undefined)
      }
    },
  )

  fcTest.prop([canvas, library], withDefaults())(
    'is idempotent, and changes nothing but colour',
    (c, lib) => {
      const once = withDeclaredColours(c, lib)
      expect(withDeclaredColours(once, lib)).toEqual(once)
      const strip = (x: SpatialCanvas) => ({
        nodes: x.nodes.map(({ color: _c, ...rest }) => rest),
        edges: x.edges.map(({ color: _c, ...rest }) => rest),
      })
      expect(strip(once)).toEqual(strip(c))
    },
  )
})
