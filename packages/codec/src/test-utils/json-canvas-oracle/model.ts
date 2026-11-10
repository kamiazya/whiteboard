import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import type { Dice } from '../frontmatter-oracle/corpus.js'
import {
  COLORS,
  ENDS,
  FRACTIONS,
  IDS,
  INTS,
  type Obj,
  pick,
  SIDES,
  STYLES,
  SUBPATHS,
  ULIDS,
  URLS,
} from './pools.js'
import { facets, tags, text } from './wire.js'

const NUMBERS = [
  ...INTS,
  ...FRACTIONS,
  -0,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
  123.456,
  1e300,
]
const num = (d: Dice): number => (d.chance(0.55) ? pick(d, INTS) : pick(d, NUMBERS))
const size = (d: Dice): number => Math.abs(num(d)) || (d.chance(0.5) ? 0 : 100)
const color = (d: Dice): string => pick(d, COLORS)

function resource(d: Dice): Obj | undefined {
  const r = d.int(10)
  if (r < 3) return { mimeType: pick(d, ['text/markdown', 'text/plain']), content: text(d) }
  if (r < 5) {
    const file: Obj = { mimeType: pick(d, ['application/octet-stream', 'image/png']) }
    file.location = pick(d, ['a.md', 'dir/b.png', '', 'é.txt'])
    if (d.chance(0.4)) file.subpath = pick(d, SUBPATHS)
    return file
  }
  if (r < 7) return { mimeType: 'text/uri-list', location: pick(d, URLS) }
  if (r === 7) return { mimeType: 'x/unclaimed' }
  if (r === 8) return { mimeType: 'text/markdown', content: text(d), location: 'both.md' }
  return undefined
}

function node(d: Dice, id: string): Obj {
  const n: Obj = { id, x: num(d), y: num(d), width: size(d), height: size(d) }
  if (d.chance(0.3)) n.color = color(d)
  if (d.chance(0.2)) {
    n.embed = { documentId: pick(d, ULIDS), ...(d.chance(0.4) && { versionRef: 'v1' }) }
  }
  if (d.chance(0.3)) n.facets = facets(d, false)
  if (d.chance(0.25)) n.tags = tags(d)
  const shown = resource(d)
  if (shown !== undefined) n.resource = shown
  const frame = shown === undefined || d.chance(0.1)
  if (frame && d.chance(0.5)) n.label = text(d)
  if (frame && d.chance(0.3)) n.background = 'bg.png'
  if (frame && d.chance(0.3)) n.backgroundStyle = pick(d, STYLES)
  return n
}

const edgeEnd = (d: Dice, ids: readonly string[]): Obj => ({
  node: pick(d, ids),
  ...(d.chance(0.5) && { side: pick(d, SIDES) }),
  ...(d.chance(0.4) && { end: pick(d, ENDS) }),
})

const bends = (d: Dice): Obj[] =>
  Array.from({ length: 1 + d.int(3) }, () => ({ x: num(d), y: num(d) }))

function edge(d: Dice, id: string, ids: readonly string[]): Obj {
  const e: Obj = { id, from: edgeEnd(d, ids), to: edgeEnd(d, ids) }
  if (d.chance(0.3)) e.color = color(d)
  if (d.chance(0.3)) e.label = text(d)
  if (d.chance(0.3)) e.bends = bends(d)
  if (d.chance(0.3)) e.facets = facets(d, false)
  if (d.chance(0.25)) e.tags = tags(d)
  return e
}

function lineEnd(d: Dice, ids: readonly string[]): Obj {
  if (d.chance(0.5)) {
    return {
      kind: 'node',
      node: pick(d, ids),
      ...(d.chance(0.4) && { side: pick(d, SIDES) }),
      ...(d.chance(0.3) && { end: pick(d, ENDS) }),
    }
  }
  return {
    kind: 'point',
    point: { x: num(d), y: num(d) },
    ...(d.chance(0.3) && { end: pick(d, ENDS) }),
  }
}

function line(d: Dice, id: string, ids: readonly string[]): Obj {
  const l: Obj = { id, from: lineEnd(d, ids), to: lineEnd(d, ids) }
  if (d.chance(0.3)) l.color = color(d)
  if (d.chance(0.3)) l.label = text(d)
  if (d.chance(0.3)) l.bends = bends(d)
  if (d.chance(0.3)) l.facets = facets(d, false)
  return l
}

/**
 * A model canvas as a writer is handed one. Mostly well formed; now and then an
 * id repeats or an end names a node that is not there, which the strict mode's
 * wire re-validation refuses and the extended mode does not look at.
 */
export function modelCanvas(d: Dice): SpatialCanvas {
  const count = d.int(5)
  const ids = Array.from({ length: count }, (_, i) => (d.chance(0.7) ? `n${i}` : pick(d, IDS)))
  const unique = [...new Set(ids)]
  const known = unique.length > 0 ? unique : ['n0']
  const canvas: Obj = {
    nodes: unique.map((id) => node(d, id)),
    edges:
      unique.length === 0
        ? []
        : Array.from({ length: d.int(4) }, (_, i) => edge(d, `e${i}`, known)),
  }
  if (d.chance(0.4))
    canvas.lines = Array.from({ length: d.int(3) }, (_, i) => line(d, `l${i}`, known))
  if (d.chance(0.3)) canvas.facets = facets(d, false)
  if (d.chance(0.3)) canvas.tags = tags(d)
  if (d.chance(0.06) && Array.isArray(canvas.nodes) && canvas.nodes.length > 0) {
    canvas.nodes.push(canvas.nodes[0])
  }
  if (d.chance(0.06) && Array.isArray(canvas.edges))
    canvas.edges.push(edge(d, 'dangling', ['ghost']))
  if (d.chance(0.04) && Array.isArray(canvas.edges) && canvas.edges.length > 0) {
    canvas.edges.push(canvas.edges[0])
  }
  return canvas as unknown as SpatialCanvas
}
