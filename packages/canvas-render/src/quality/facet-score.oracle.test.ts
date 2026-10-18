// The sparse partitions `scoreFacets` reads against the dense reading they
// replaced, on small random boards. The oracle below is that dense reading:
// every partition lists every element, and every column is computed from
// those explicit member lists — so it shares no partition machinery with
// the subject, only the per-box reads (treatment, kind, stencil, tag
// grammar) that the change did not touch. It lives here only as an oracle.

import { facetPayloadKey } from '@kamiazya/whiteboard-facet-engine'
import {
  type CanvasEdge,
  compareCodeUnit,
  isFrame,
  nodeKind,
  parseScopedTag,
  type SpatialCanvas,
  type SpatialNode,
} from '@kamiazya/whiteboard-model'
import { groupNode, linkNode, textNode } from '@kamiazya/whiteboard-model/test-utils'
import {
  resolveNodeShape,
  resolveNodeStencil,
  VISUAL_AXES_KEY,
} from '@kamiazya/whiteboard-plugin-visual'
import { describe, expect, it } from 'vitest'
import { fc } from '../test-utils/fast-check.js'
import { scoreFacets } from './facet-score.js'
import { contains, rectOf } from './rect.js'

type Dense = ReadonlyMap<string, string>
type Named = { name: string; partition: Dense }

const keyOfBox = (n: SpatialNode) => `${n.color ?? ''}|${resolveNodeShape(n) ?? ''}`
const DEFAULT_KEY = '|'

function denseTags<T extends { id: string }>(
  els: readonly T[],
  tagsOf: (e: T) => readonly string[] | undefined,
) {
  const values = new Map<string, Map<string, string[]>>()
  for (const e of els) {
    for (const tag of tagsOf(e) ?? []) {
      const s = parseScopedTag(tag)
      if (s === undefined || ['frame', 'kind', 'stencil'].includes(s.key)) continue
      const per = values.get(s.key) ?? new Map<string, string[]>()
      values.set(s.key, per)
      per.set(e.id, [...(per.get(e.id) ?? []), s.value])
    }
  }
  const partitions: Named[] = []
  const multi: { key: string; count: number }[] = []
  for (const [key, per] of [...values].sort(([a], [b]) => compareCodeUnit(a, b))) {
    const count = [...per.values()].filter((l) => l.length >= 2).length
    if (count > 0) multi.push({ key, count })
    else
      partitions.push({
        name: key,
        partition: new Map(els.map((e) => [e.id, per.get(e.id)?.[0] ?? ''])),
      })
  }
  return { partitions, multi }
}

const classesOf = (p: Dense) => {
  const out = new Map<string, string[]>()
  for (const [id, c] of p) out.set(c, [...(out.get(c) ?? []), id])
  return out
}
const atLeastTwo = (p: Named) => new Set(p.partition.values()).size >= 2

function denseChannel(of: (id: string) => string, ids: readonly string[], ps: readonly Named[]) {
  if (new Set(ids.map(of)).size <= 1) return { use: 'unused', carriedBy: [] as string[] }
  const carriedBy = ps
    .filter((p) => [...classesOf(p.partition).values()].every((m) => new Set(m.map(of)).size === 1))
    .map((p) => p.name)
  return carriedBy.length > 0 ? { use: 'carried', carriedBy } : { use: 'contested', carriedBy: [] }
}

function densePartitions(canvas: SpatialCanvas, boxes: readonly SpatialNode[], byTag: Named[]) {
  const frames = canvas.nodes.filter((n) => isFrame(n))
  const ps: Named[] = []
  if (frames.length > 0) {
    const m = boxes.map(
      (b) => [b.id, frames.find((f) => contains(rectOf(f), rectOf(b)))?.id ?? ''] as const,
    )
    ps.push({ name: 'frame', partition: new Map(m) })
  }
  ps.push({ name: 'kind', partition: new Map(boxes.map((b) => [b.id, nodeKind(b) ?? ''])) })
  ps.push({
    name: 'stencil',
    partition: new Map(boxes.map((b) => [b.id, resolveNodeStencil(b) ?? ''])),
  })
  ps.push(...byTag)
  const carried = new Set(boxes.flatMap((b) => Object.keys(b.facets ?? {})))
  const axes = (canvas.facets?.[VISUAL_AXES_KEY] as { axes?: string[] } | undefined)?.axes ?? []
  for (const k of [...new Set(axes)].filter((a) => carried.has(a))) {
    ps.push({
      name: k,
      partition: new Map(boxes.map((b) => [b.id, facetPayloadKey(b.facets?.[k])])),
    })
  }
  return ps.filter(atLeastTwo)
}

function denseMisuse(
  boxes: readonly SpatialNode[],
  partitions: readonly Named[],
  key: (id: string) => string,
) {
  const allClasses = partitions.flatMap((p) => [...classesOf(p.partition).values()])
  const wearers = new Map<string, Set<string>>()
  for (const b of boxes) {
    if (key(b.id) !== DEFAULT_KEY)
      wearers.set(key(b.id), (wearers.get(key(b.id)) ?? new Set()).add(b.id))
  }
  const counts = { overload: 0, excess: 0, undeclared: 0 }
  for (const worn of wearers.values()) {
    if (partitions.length === 0) counts.undeclared++
    else if (allClasses.some((m) => [...worn].every((id) => m.includes(id)))) continue
    else if (
      partitions.some((p) =>
        [...classesOf(p.partition).values()].every((m) => {
          const held = m.filter((id) => worn.has(id)).length
          return held === 0 || held === m.length
        }),
      )
    )
      counts.overload++
    else counts.excess++
  }
  return counts
}

function denseCoverage(partitions: readonly Named[], key: (id: string) => string) {
  const allClasses = partitions.flatMap((p) => [...classesOf(p.partition).values()])
  let deficit = 0
  let redundancy = 0
  for (const m of allClasses) {
    const ks = new Set(m.map(key))
    if (ks.size === 1 && ks.has(DEFAULT_KEY)) deficit++
    if (ks.size >= 2) redundancy++
  }
  return { constructs: allClasses.length, deficit, redundancy }
}

function denseScore(canvas: SpatialCanvas) {
  const boxes = canvas.nodes.filter((n) => !isFrame(n))
  const byId = new Map(boxes.map((b) => [b.id, b]))
  const key = (id: string) => keyOfBox(byId.get(id) as SpatialNode)
  const boxTags = denseTags(boxes, (b) => b.tags)
  const partitions = densePartitions(canvas, boxes, boxTags.partitions)
  const ids = boxes.map((b) => b.id)
  const colourOf = (id: string) => byId.get(id)?.color ?? ''
  const shapeOf = (id: string) => resolveNodeShape(byId.get(id) as SpatialNode) ?? ''
  const edgeTags = denseTags(canvas.edges, (e: CanvasEdge) => e.tags)
  const edgeColour = new Map(canvas.edges.map((e) => [e.id, e.color ?? '']))
  return {
    partitions: partitions.length,
    ...denseCoverage(partitions, key),
    ...denseMisuse(boxes, partitions, key),
    treatments: new Set(ids.map(key)).size,
    channels: {
      colour: denseChannel(colourOf, ids, partitions),
      shape: denseChannel(shapeOf, ids, partitions),
    },
    multi: boxTags.multi,
    edges: {
      colour: denseChannel(
        (id) => edgeColour.get(id) ?? '',
        canvas.edges.map((e) => e.id),
        edgeTags.partitions.filter(atLeastTwo),
      ),
      multi: edgeTags.multi,
    },
  }
}

const AXIS = 'x.k/v0'
const tagArb = fc.subarray(['a:x', 'a:y', 'b:x', 'b:y', 'c:x', 'kind:x', 'plain'], { maxLength: 3 })
// A PLAIN board varies only where a box sits, and colours each box by that
// place from a board palette, so frames are its one partition and a colour
// shared by two places is worn by whole frames. Without it, overload — a
// colour worn by whole classes of EVERY partition — is reached on a few
// boards in a hundred.
type Colour = '1' | '2' | undefined
const boxArb = (i: number, rich: boolean, palette: readonly Colour[]) => {
  const or = <T>(arb: fc.Arbitrary<T>, plain: T) => (rich ? arb : fc.constant(plain))
  return fc
    .record({
      slot: fc.integer({ min: 0, max: 3 }),
      link: or(fc.boolean(), false),
      color: or(fc.constantFrom<Colour>(undefined, '1', '2'), 'by place' as const),
      shape: or(fc.constantFrom(undefined, 'ellipse', 'diamond'), undefined),
      stencil: or(fc.constantFrom(undefined, 'visual.datastore', 'visual.gateway'), undefined),
      axis: or(fc.constantFrom(undefined, 0, 1), undefined),
      tags: or(tagArb, []),
    })
    .map(({ slot, link, color: drawn, shape, stencil, axis, tags }): SpatialNode => {
      const color = drawn === 'by place' ? palette[slot] : drawn
      const at = { id: `n${i}`, x: slot * 300 + 20, y: 20, width: 200, height: 80 }
      const node = link
        ? linkNode({ ...at, url: 'https://example.com' })
        : textNode({ ...at, text: at.id })
      const facets = {
        ...(shape === undefined ? {} : { 'visual.shape/v0': { kind: shape } }),
        ...(stencil === undefined ? {} : { 'visual.stencil/v0': { stencil } }),
        ...(axis === undefined ? {} : { [AXIS]: { v: axis } }),
      }
      return {
        ...node,
        ...(color === undefined ? {} : { color }),
        ...(Object.keys(facets).length > 0 ? { facets } : {}),
        tags,
      }
    })
}

const boardArb = fc
  .record({
    boxCount: fc.integer({ min: 2, max: 10 }),
    frames: fc.integer({ min: 0, max: 3 }),
    declare: fc.boolean(),
    rich: fc.boolean(),
    palette: fc.array(fc.constantFrom<Colour>(undefined, '1', '2'), { minLength: 4, maxLength: 4 }),
    edges: fc.array(fc.record({ color: fc.constantFrom(undefined, '3', '4'), tags: tagArb }), {
      maxLength: 5,
    }),
  })
  .chain(({ boxCount, frames, declare, rich, palette, edges }) =>
    fc
      .tuple(...Array.from({ length: boxCount }, (_, i) => boxArb(i, rich, palette)))
      .map((boxes): SpatialCanvas => {
        const frameNodes = Array.from({ length: frames }, (_, f) =>
          groupNode({ id: `f${f}`, x: f * 300, y: 0, width: 260, height: 140, label: `f${f}` }),
        )
        return {
          nodes: [...frameNodes, ...boxes],
          edges: edges.map((e, i) => ({
            id: `e${i}`,
            from: { node: 'n0' },
            to: { node: 'n1' },
            ...(e.color === undefined ? {} : { color: e.color }),
            tags: e.tags,
          })),
          ...(declare ? { facets: { [VISUAL_AXES_KEY]: { axes: [AXIS] } } } : {}),
        } as SpatialCanvas
      }),
  )

describe('facet scoring against the dense partitions it replaced', () => {
  it('answers every column the dense reading does', () => {
    const reached = { overload: 0, excess: 0, deficit: 0, redundancy: 0, carried: 0 }
    fc.assert(
      fc.property(boardArb, (canvas) => {
        const s = scoreFacets(canvas)
        const { distance: _distance, contested: _contested, ...compared } = s
        expect(compared).toEqual(denseScore(canvas))
        if (s.overload > 0) reached.overload++
        if (s.excess > 0) reached.excess++
        if (s.deficit > 0) reached.deficit++
        if (s.redundancy > 0) reached.redundancy++
        if (s.channels.colour.use === 'carried' || s.edges.colour.use === 'carried')
          reached.carried++
      }),
      { numRuns: 300 },
    )
    // The subject is present: each column the sparse reading rebuilds from
    // counts rather than member lists was non-zero on some boards.
    for (const n of Object.values(reached)) expect(n).toBeGreaterThan(10)
  })
})
