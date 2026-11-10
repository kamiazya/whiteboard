import { type Dice, nastyString, writerValue } from '../frontmatter-oracle/corpus.js'
import { toWellFormed } from '../frontmatter-oracle/oracle.js'
import {
  BAD_COLORS,
  BAD_ENDS,
  BAD_FACET_KEYS,
  BAD_INTS,
  BAD_SIDES,
  BAD_SIZES,
  BAD_STYLES,
  BAD_SUBPATHS,
  BAD_ULIDS,
  COLORS,
  ENDS,
  FACET_KEYS,
  IDS,
  INTS,
  type Obj,
  pick,
  RAW_INTS,
  SIDES,
  SIZES,
  STYLES,
  SUBPATHS,
  ULIDS,
  URLS,
  WRONG,
} from './pools.js'

/** A value every string of which is well-formed, since a Rust `&str` cannot hold a lone surrogate. */
function clean(value: unknown): unknown {
  if (typeof value === 'string') return toWellFormed(value.slice(0, 48))
  if (Array.isArray(value)) return value.map(clean)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [toWellFormed(k), clean(v)]))
  }
  return value
}

export const text = (d: Dice): string => toWellFormed(nastyString(d).slice(0, 48))
const payload = (d: Dice): unknown => clean(writerValue(d, 3))

/** A facet bucket: usually valid, sometimes one bad key (which costs the bucket), sometimes a `__proto__` key (which zod skips). */
export function facets(d: Dice, damage = fault(d, 0.12)): unknown {
  if (damage && d.chance(0.3)) return pick(d, WRONG)
  const entries: [string, unknown][] = Array.from({ length: d.int(4) }, () => [
    pick(d, FACET_KEYS),
    payload(d),
  ])
  if (damage) entries.splice(d.int(entries.length + 1), 0, [pick(d, BAD_FACET_KEYS), payload(d)])
  if (fault(d, 0.06)) entries.splice(d.int(entries.length + 1), 0, ['__proto__', payload(d)])
  return Object.fromEntries(entries)
}

export function tags(d: Dice): unknown {
  if (fault(d, 0.1)) return pick(d, WRONG)
  return Array.from({ length: d.int(4) }, () => (good(d, 0.92) ? text(d) : pick(d, WRONG)))
}

/** Whether a document is built with faults in it; a careful one is built valid, so the corpus reads as many as it refuses. */
export const FAULT = { on: true }
const fault = (d: Dice, p: number): boolean => FAULT.on && d.chance(p)
const good = (d: Dice, p: number): boolean => !FAULT.on || d.chance(p)

const coordinate = (d: Dice): unknown => (d.chance(0.12) ? pick(d, RAW_INTS) : pick(d, INTS))
const size = (d: Dice): unknown => (d.chance(0.1) ? pick(d, RAW_INTS.slice(1)) : pick(d, SIZES))

function embedExtension(d: Dice): Obj {
  const ext: Obj = { kind: 'embed', documentId: pick(d, ULIDS) }
  if (d.chance(0.4)) ext.versionRef = good(d, 0.85) ? pick(d, ['v1', 'abc', 'é']) : pick(d, ['', 5])
  if (d.chance(0.4)) ext.facets = facets(d)
  if (d.chance(0.3)) ext.tags = tags(d)
  if (fault(d, 0.1)) ext.extra = payload(d)
  if (fault(d, 0.12)) ext.documentId = pick(d, BAD_ULIDS)
  return ext
}

/** A node's `x-whiteboard`: the embed arm, the facets-only arm, or something neither accepts. */
function nodeExtension(d: Dice): unknown {
  const r = d.int(10)
  if (r < 4) return embedExtension(d)
  if (r < 8 || !FAULT.on) {
    const ext: Obj = {}
    if (d.chance(0.6)) ext.facets = facets(d)
    if (d.chance(0.5)) ext.tags = tags(d)
    if (fault(d, 0.12)) ext[pick(d, ['kind', 'extra', 'documentId', 'bends'])] = payload(d)
    return ext
  }
  return pick(d, [{ kind: 'embed' }, { kind: 'other' }, 5, 'x', null, [], [{}], true])
}

function bends(d: Dice): unknown {
  const r = FAULT.on ? d.int(12) : 6 + d.int(6)
  if (r === 0) return []
  if (r === 1) return Array.from({ length: 65 }, (_, i) => ({ x: i, y: -i }))
  if (r === 2) return Array.from({ length: 64 }, (_, i) => ({ x: i, y: i }))
  if (r === 3) return [{ x: pick(d, BAD_INTS), y: 0 }]
  if (r === 4) return [{ x: 1, y: 2, z: 3 }]
  if (r === 5) return pick(d, WRONG)
  return Array.from({ length: 1 + d.int(3) }, () => ({ x: coordinate(d), y: coordinate(d) }))
}

function edgeExtension(d: Dice): unknown {
  if (fault(d, 0.12)) return pick(d, [5, 'x', null, [], [{}], true])
  const ext: Obj = {}
  if (d.chance(0.5)) ext.facets = facets(d)
  if (d.chance(0.4)) ext.tags = tags(d)
  if (d.chance(0.5)) ext.bends = bends(d)
  if (fault(d, 0.1)) ext[pick(d, ['kind', 'extra'])] = payload(d)
  return ext
}

const url = (d: Dice): unknown =>
  FAULT.on ? (good(d, 0.9) ? pick(d, URLS) : pick(d, WRONG)) : pick(d, URLS.slice(0, 10))
const color = (d: Dice): unknown => (good(d, 0.9) ? pick(d, COLORS) : pick(d, BAD_COLORS))

/** One JSON Canvas node, valid unless `damage` says otherwise. */
function wireNode(d: Dice, id: string): Obj {
  const type = pick(d, ['text', 'file', 'link', 'group', 'text', 'link'])
  const node: Obj = { id, x: coordinate(d), y: coordinate(d), width: size(d), height: size(d) }
  if (d.chance(0.3)) node.color = color(d)
  if (d.chance(0.35)) node['x-whiteboard'] = nodeExtension(d)
  node.type = type
  if (type === 'text') node.text = good(d, 0.95) ? text(d) : pick(d, WRONG)
  if (type === 'file') {
    node.file = good(d, 0.95) ? pick(d, ['a.md', 'dir/b.png', '', 'é.txt']) : pick(d, WRONG)
    if (d.chance(0.4)) node.subpath = good(d, 0.8) ? pick(d, SUBPATHS) : pick(d, BAD_SUBPATHS)
  }
  if (type === 'link') node.url = url(d)
  if (type === 'group') {
    if (d.chance(0.5)) node.label = good(d, 0.9) ? text(d) : pick(d, WRONG)
    if (d.chance(0.3)) node.background = good(d, 0.9) ? 'bg.png' : pick(d, WRONG)
    if (d.chance(0.3)) node.backgroundStyle = good(d, 0.8) ? pick(d, STYLES) : pick(d, BAD_STYLES)
  }
  return node
}

function wireEdge(d: Dice, id: string, from: string, to: string): Obj {
  const edge: Obj = { id, fromNode: from, toNode: to }
  if (d.chance(0.5)) edge.fromSide = good(d, 0.9) ? pick(d, SIDES) : pick(d, BAD_SIDES)
  if (d.chance(0.5)) edge.toSide = good(d, 0.9) ? pick(d, SIDES) : pick(d, BAD_SIDES)
  if (d.chance(0.4)) edge.fromEnd = good(d, 0.9) ? pick(d, ENDS) : pick(d, BAD_ENDS)
  if (d.chance(0.4)) edge.toEnd = good(d, 0.9) ? pick(d, ENDS) : pick(d, BAD_ENDS)
  if (d.chance(0.3)) edge.color = color(d)
  if (d.chance(0.3)) edge.label = good(d, 0.92) ? text(d) : pick(d, WRONG)
  if (d.chance(0.35)) edge['x-whiteboard'] = edgeExtension(d)
  return edge
}

const strictPoint = (d: Dice): unknown =>
  good(d, 0.9)
    ? { x: pick(d, [0, 1.5, -2.25, 100, 1e21]), y: pick(d, [0, 0.1, -7, 3.5]) }
    : { x: 1 }

function lineEnd(d: Dice, ids: readonly string[]): unknown {
  const r = FAULT.on ? d.int(12) : d.int(10)
  if (r < 5) {
    const end: Obj = { kind: 'node', node: pick(d, ids) }
    if (d.chance(0.4)) end.side = pick(d, SIDES)
    if (d.chance(0.3)) end.end = pick(d, ENDS)
    return end
  }
  if (r < 10) {
    const end: Obj = { kind: 'point', point: strictPoint(d) }
    if (d.chance(0.3)) end.end = pick(d, ENDS)
    return end
  }
  return pick(d, [
    { kind: 'other' },
    { kind: 'node' },
    { kind: 'node', node: 'a', extra: 1 },
    { kind: 'point', point: { x: 1, y: 2, z: 3 } },
    { kind: 'node', node: 'a', side: 'Top' },
    5,
    null,
  ])
}

function wireLine(d: Dice, id: string, ids: readonly string[]): Obj {
  const line: Obj = { id, from: lineEnd(d, ids), to: lineEnd(d, ids) }
  if (d.chance(0.3)) line.color = color(d)
  if (d.chance(0.3)) line.label = text(d)
  if (d.chance(0.3)) {
    line.bends = Array.from({ length: 1 + d.int(3) }, () => ({
      x: pick(d, [0, 0.5, -3.25, 1e21]),
      y: pick(d, [1, 2.5, -0.0]),
    }))
  }
  if (d.chance(0.3)) line.facets = facets(d)
  if (fault(d, 0.06)) line.tags = tags(d)
  return line
}

/** The document-level `x-whiteboard`. */
function rootExtension(d: Dice, ids: readonly string[]): unknown {
  if (fault(d, 0.08)) return pick(d, [5, 'x', null, [], true, { comments: {} }, { comments: [] }])
  const ext: Obj = {}
  if (d.chance(0.6)) {
    ext.lines = Array.from({ length: d.int(4) }, (_, i) => wireLine(d, `l${i}`, ids))
  }
  if (d.chance(0.4)) ext.facets = facets(d)
  if (d.chance(0.3)) ext.tags = tags(d)
  if (fault(d, 0.03)) ext.comments = d.chance(0.5) ? [{ id: 'c' }] : [1]
  if (fault(d, 0.08)) ext.extra = payload(d)
  return ext
}

/** A JSON Canvas document with the faults a producer or a hand edit leaves in one. */
export function wireDocument(d: Dice): Obj {
  const count = d.int(6)
  const ids = Array.from({ length: count }, (_, i) => (good(d, 0.5) ? `n${i}` : pick(d, IDS)))
  const nodes = ids.map((id) => wireNode(d, id))
  const edgeCount = count === 0 ? 0 : d.int(5)
  const edges = Array.from({ length: edgeCount }, (_, i) =>
    wireEdge(d, good(d, 0.5) ? `e${i}` : pick(d, IDS), pick(d, ids), pick(d, ids)),
  )
  const doc: Obj = {}
  if (d.chance(0.9) || nodes.length > 0) doc.nodes = nodes
  if (d.chance(0.9) || edges.length > 0) doc.edges = edges
  if (d.chance(0.5)) doc['x-whiteboard'] = rootExtension(d, ids)
  return doc
}

/** One place in `value` replaced, removed or added to, so a valid document breaks in exactly one way. */
export function damage(d: Dice, doc: Obj): Obj {
  const targets: Obj[] = [doc]
  for (const key of ['nodes', 'edges']) {
    const list = doc[key]
    if (Array.isArray(list)) for (const item of list) targets.push(item as Obj)
  }
  const target = pick(d, targets)
  const keys = Object.keys(target)
  const key = keys.length > 0 ? pick(d, keys) : 'id'
  const r = d.int(6)
  if (r === 0) delete target[key]
  else if (r === 1) target[`extra${d.int(3)}`] = payload(d)
  else if (r === 2) target[key] = pick(d, [...WRONG, ...BAD_INTS, ...BAD_SIZES, ...BAD_COLORS])
  else if (r === 3) target[key] = null
  else if (r === 4 && Array.isArray(doc.nodes) && doc.nodes.length > 0) doc.nodes.push(doc.nodes[0])
  else if (Array.isArray(doc.edges) && doc.edges.length > 0) doc.edges.push(doc.edges[0])
  return doc
}
