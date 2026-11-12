import type { BoundingBox, Scene, SceneNode } from '@kamiazya/whiteboard-scene'

/**
 * A scene written as a spec: a node's kind, id, box and flags, which is everything
 * `sceneDigest` reads of one, so a recorded scene stays a few dozen bytes a node.
 */

/** A coordinate: a number, or the name of one JSON cannot hold. */
export type Num = number | 'nan' | 'inf' | '-inf' | '-0'

export interface SpecNode {
  /** `s` shape, `g` glyph (any non-edge node), `e` edge. */
  readonly t: 's' | 'g' | 'e'
  readonly i?: string
  readonly b?: readonly [Num, Num, Num, Num]
  /** `c` comment chrome, `p` proposal chrome, `t` truncated, `o` overflows. */
  readonly f?: string
  /** Copies of the node, each moved by `d` more than the last. */
  readonly r?: number
  readonly d?: readonly [number, number]
}

export type Spec = readonly SpecNode[]

const numberOf = (n: Num): number =>
  n === 'nan' ? Number.NaN : n === 'inf' ? Infinity : n === '-inf' ? -Infinity : n === '-0' ? -0 : n

function nodeOf(node: SpecNode, copy: number): SceneNode {
  const [x, y, w, h] = (node.b ?? [0, 0, 0, 0]).map(numberOf) as [number, number, number, number]
  const bbox: BoundingBox = {
    x: x + copy * (node.d?.[0] ?? 0),
    y: y + copy * (node.d?.[1] ?? 0),
    w,
    h,
  }
  const flags = node.f ?? ''
  if (node.t === 'e') {
    return {
      kind: 'edge',
      id: node.i ?? 'edge',
      path: [],
      fromSide: 'right',
      toSide: 'left',
      fromEnd: 'none',
      toEnd: 'arrow',
    }
  }
  if (node.t === 'g') return { kind: 'glyph', bbox, glyph: 'g' }
  return {
    kind: 'shape',
    bbox,
    ...(node.i === undefined ? {} : { id: node.i }),
    ...(flags.includes('c') ? { commentChrome: true as const } : {}),
    ...(flags.includes('p') ? { proposalChrome: { proposalId: 'p1' } } : {}),
    ...(flags.includes('t') ? { truncated: true as const } : {}),
    ...(flags.includes('o') ? { overflows: true as const } : {}),
  }
}

export function sceneOfSpec(spec: Spec): Scene {
  return {
    nodes: spec.flatMap((node) =>
      Array.from({ length: node.r ?? 1 }, (_, copy) => nodeOf(node, copy)),
    ),
  }
}

/** mulberry32: `next()` is the next u32. */
export function mulberry32(seed: number): () => number {
  let a = seed | 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return (t ^ (t >>> 14)) >>> 0
  }
}

/**
 * Ids chosen to collide and to order differently by code unit than by byte:
 * U+1F600 is a surrogate pair (0xD83D first) and so sorts before U+E000 and
 * U+FFFF, which UTF-8 bytes reverse.
 */
const ID_POOL: readonly string[] = [
  'a',
  'b',
  'c',
  'B',
  '10',
  '9',
  'é',
  '',
  '￿',
  '\u{1f600}',
  '\u{10000}',
  'q"\\',
]

/** One seeded board: a handful of nodes at one of three scales, ids drawn from a small pool. */
export function seededSpec(next: () => number): Spec {
  const scale = next() % 3
  const unit = scale === 0 ? 5 : scale === 1 ? 20 : 50
  const count = 1 + (next() % 16)
  const nodes: SpecNode[] = []
  for (let n = 0; n < count; n += 1) {
    const roll = next() % 13
    const b = [
      (next() % 30) * unit,
      (next() % 30) * unit,
      (next() % 24) * (scale === 2 ? 4 : unit),
      (next() % 24) * (scale === 2 ? 4 : unit),
    ] as const
    const id = ID_POOL[next() % ID_POOL.length] as string
    const flag = next() % 7
    const f = flag === 0 ? 't' : flag === 1 ? 'o' : flag === 2 ? 'to' : ''
    if (roll === 12) nodes.push({ t: 'e', i: id })
    else if (roll === 11) nodes.push({ t: 'g', b })
    else if (roll === 10) nodes.push({ t: 's', i: id, b, f: 'p' })
    else if (roll === 9) nodes.push({ t: 's', i: id, b, f: 'c' })
    else if (roll === 8) nodes.push({ t: 's', b, ...(f ? { f } : {}) })
    else nodes.push({ t: 's', i: id, b, ...(f ? { f } : {}) })
  }
  return nodes
}
