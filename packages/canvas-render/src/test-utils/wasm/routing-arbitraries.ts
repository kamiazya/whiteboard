import { edgeSideSchema, type SpatialNode } from '@kamiazya/whiteboard-model'
import type { RoutableElement } from '@kamiazya/whiteboard-scene'
import { rectOf, sidePoint } from '../../layout/edges/edge-geometry.js'
import { fc } from '../fast-check.js'
import { coordinate, point, rect } from './edge-arbitraries.js'

/**
 * Whole canvases for the edge layer's Rust differentials (ADR-0054 step 5):
 * nodes and the edges and lines over them, drawn to collide where the
 * TypeScript's id handling and side rules branch.
 */

const side = fc.constantFrom(...edgeSideSchema.options)

/**
 * A canvas small enough to collide: node ids drawn from a short pool so one
 * id can name two nodes, a second box sometimes placed against the first
 * so the contact rule fires, and edge ids drawn from a short pool too.
 */
const canvas = fc
  .tuple(
    fc.array(fc.tuple(fc.constantFrom('a', 'b', 'c', 'd', 'e'), rect), {
      minLength: 1,
      maxLength: 6,
    }),
    fc.option(fc.tuple(fc.constantFrom('right', 'below'), coordinate), { freq: 2 }),
    fc.option(fc.constantFrom(...edgeSideSchema.options), { freq: 2 }),
  )
  .map(([drawn, touching, occluded]) => {
    const nodes = drawn.map(
      ([id, r]) =>
        ({ id, type: 'text', text: '', x: r.x, y: r.y, width: r.w, height: r.h }) as SpatialNode,
    )
    const first = nodes[0] as SpatialNode
    if (touching !== null) {
      const [where, offset] = touching
      const along = Number.isFinite(offset) ? offset % 30 : 0
      nodes.push({
        ...first,
        id: 'touching',
        x: where === 'right' ? first.x + first.width : first.x + along,
        y: where === 'right' ? first.y + along : first.y + first.height,
      } as SpatialNode)
    }
    if (occluded !== null) {
      // A bystander over the midpoint of one of the first box's sides, so
      // the default side choice has to move off it.
      const p = sidePoint(rectOf(first), occluded)
      nodes.push({
        ...first,
        id: 'occluder',
        x: p.x - 10,
        y: p.y - 10,
        width: 20,
        height: 20,
      } as SpatialNode)
    }
    return nodes
  })

const arrowhead = fc.option(fc.constantFrom('none' as const, 'arrow' as const), { nil: undefined })
/**
 * Bends anywhere, sometimes not finite, and sometimes at a node's CENTRE,
 * where the nearest-border search meets an exact tie between two sides.
 */
function bendsOver(nodes: readonly SpatialNode[]) {
  const centre = fc
    .constantFrom(...nodes)
    .map((n) => ({ x: n.x + n.width / 2, y: n.y + n.height / 2 }))
  return fc.option(
    fc.array(
      fc.oneof(
        { weight: 5, arbitrary: point },
        { weight: 2, arbitrary: centre },
        { weight: 1, arbitrary: fc.constant({ x: Number.NaN, y: 0 }) },
      ),
      { minLength: 1, maxLength: 3 },
    ),
    { nil: undefined, freq: 3 },
  )
}

/**
 * Edges over a canvas, their ends naming its own nodes mostly (and a missing
 * one sometimes), and, when the canvas has a box placed against its first,
 * an unbent edge between the two so the contact rule has something to mark.
 */
function elementsOver(nodes: readonly SpatialNode[]): fc.Arbitrary<RoutableElement[]> {
  const ids = nodes.map((n) => n.id)
  const nodeRef = fc.oneof(
    { weight: 8, arbitrary: fc.constantFrom(...ids) },
    { weight: 1, arbitrary: fc.constant('missing') },
  )
  const edgeEnd = fc.record(
    { node: nodeRef, side: fc.option(side, { nil: undefined, freq: 3 }), end: arrowhead },
    { requiredKeys: ['node'] },
  )
  const lineEnd = fc.oneof(
    { weight: 3, arbitrary: edgeEnd.map((e) => ({ kind: 'node' as const, ...e })) },
    {
      weight: 1,
      arbitrary: fc.record(
        { kind: fc.constant('point' as const), point, end: arrowhead },
        { requiredKeys: ['kind', 'point'] },
      ),
    },
  )
  const element = fc
    .tuple(
      fc.constantFrom('e1', 'e2', 'e3', 'e4', 'e5', 'e6'),
      fc.boolean(),
      edgeEnd,
      edgeEnd,
      lineEnd,
      lineEnd,
      bendsOver(nodes),
    )
    .map(
      ([id, isLine, ef, et, lf, lt, b]) =>
        (isLine
          ? { id, from: lf, to: lt, bends: b }
          : { id, from: ef, to: et, bends: b }) as RoutableElement,
    )
  const touching = ids.includes('touching')
  const contact = fc
    .tuple(fc.constantFrom('c1', 'c2'), fc.boolean())
    .map(([id, reversed]): RoutableElement => {
      const [a, b] = reversed ? ['touching', ids[0] as string] : [ids[0] as string, 'touching']
      return { id, from: { node: a }, to: { node: b } } as RoutableElement
    })
  return fc
    .tuple(
      fc.array(element, { maxLength: 8 }),
      touching ? fc.array(contact, { maxLength: 2 }) : fc.constant([]),
    )
    .map(([es, cs]) => [...es, ...cs])
}

export const scene = canvas.chain((nodes) => fc.tuple(fc.constant(nodes), elementsOver(nodes)))
