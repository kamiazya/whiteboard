import type { CanvasEdge, CanvasLine, SpatialCanvas, SpatialNode } from '@kamiazya/whiteboard-model'
import { groupNode, textNode } from '@kamiazya/whiteboard-model/test-utils'
import { selectCanvasFragment } from '../canvas-fragment.js'

/**
 * Inputs and answers of `selectCanvasFragment`, the part of a canvas a
 * `#fragment` names. An answer is the ids of the nodes, edges and lines the
 * selected canvas keeps, in order, or null when the fragment names nothing,
 * so the replay compares which elements and not a copy of them.
 */
export interface CanvasFragmentRecord {
  readonly id: string
  readonly canvas: SpatialCanvas
  readonly fragment: string
  readonly selected: {
    readonly nodes: readonly string[]
    readonly edges: readonly string[]
    readonly lines: readonly string[] | null
  } | null
}

type Input = Omit<CanvasFragmentRecord, 'selected'>

const frame = (id: string, x: number, y: number, w: number, h: number, label?: string) =>
  groupNode({ id, x, y, width: w, height: h, ...(label === undefined ? {} : { label }) })
const card = (id: string, x: number, y: number, w = 20, h = 20) =>
  textNode({ id, x, y, width: w, height: h, text: id })
const edge = (id: string, from: string, to: string): CanvasEdge => ({
  id,
  from: { node: from },
  to: { node: to },
})
const onNode = (node: string) => ({ kind: 'node' as const, node })
const atPoint = (x: number, y: number) => ({ kind: 'point' as const, point: { x, y } })
const line = (id: string, from: CanvasLine['from'], to: CanvasLine['to']): CanvasLine => ({
  id,
  from,
  to,
})

/**
 * Two groups labelled alike in different case, a group nested in another, a
 * node outside every group, edges inside, across and out of a group, and lines
 * on a node and free at both ends.
 */
const LAUNCH: SpatialCanvas = {
  nodes: [
    // A non-group carrying a label is no group: a label is a frame's alone.
    { ...card('labelled-card', 900, 900), label: 'Launch' } as SpatialNode,
    frame('g-launch', 0, 0, 400, 300, 'Launch'),
    card('a', 10, 10),
    card('b', 200, 100),
    frame('g-inner', 150, 50, 200, 200, 'Inner'),
    // Flush with the outer group's far corner: held, edges inclusive.
    card('flush', 380, 280),
    card('straddle', 390, 10),
    frame('g-launch-2', 500, 0, 300, 300, 'launch'),
    card('c', 510, 10),
    card('outside', 1000, 0),
  ],
  edges: [
    edge('ab', 'a', 'b'),
    edge('a-out', 'a', 'outside'),
    edge('bc', 'b', 'c'),
    edge('cc', 'c', 'c'),
    edge('a-flush', 'a', 'flush'),
    edge('to-group', 'a', 'g-launch'),
  ],
  lines: [
    line('free', atPoint(0, 0), atPoint(5, 5)),
    line('on-out', onNode('outside'), atPoint(1, 1)),
    line('on-a', onNode('a'), onNode('b')),
  ],
}

/** Labels that differ by whitespace, case only, case mapping, or not at all. */
const LABELS: SpatialCanvas = {
  nodes: [
    frame('padded', 0, 0, 100, 100, '  Padded  '),
    card('p1', 10, 10),
    frame('empty', 200, 0, 100, 100, ''),
    frame('blank', 400, 0, 100, 100, ' \t '),
    frame('unlabelled', 600, 0, 100, 100),
    frame('dup-1', 0, 200, 100, 100, 'Same'),
    card('d1', 10, 210),
    frame('dup-2', 200, 200, 100, 100, 'Same'),
    card('d2', 210, 210),
    frame('istanbul', 0, 400, 100, 100, 'İstanbul'),
    frame('odos', 200, 400, 100, 100, 'ΟΔΟΣ'),
    frame('strasse', 400, 400, 100, 100, 'Straße'),
    frame('lower-first', 600, 400, 100, 100, 'mixed'),
    frame('exact-later', 800, 400, 100, 100, 'Mixed'),
    frame('nbsp', 0, 600, 100, 100, ' Wide　'),
    // An empty id, which `^` alone names.
    card('', 1000, 1000),
    card('twin', 210, 610),
    card('twin', 1200, 1200),
  ],
  edges: [edge('twins', 'twin', 'twin'), edge('dup', 'd1', 'd2')],
}

/** A canvas with no lines field at all: the selection keeps it absent. */
const NO_LINES: SpatialCanvas = {
  nodes: [frame('g', 0, 0, 50, 50, 'G'), card('in', 5, 5), card('out', 100, 100)],
  edges: [edge('io', 'in', 'out')],
}

const BOARDS: readonly (readonly [string, SpatialCanvas])[] = [
  ['launch', LAUNCH],
  ['labels', LABELS],
  ['no-lines', NO_LINES],
  ['empty', { nodes: [], edges: [] }],
]

const FRAGMENTS = [
  'Launch',
  'launch',
  'LAUNCH',
  ' Launch ',
  'Inner',
  'inner',
  '^g-launch',
  '^g-inner',
  '^a',
  '^outside',
  '^labelled-card',
  '^',
  ' ^a ',
  '^ a',
  '^missing',
  'Nope',
  '',
  '   ',
  'Padded',
  '  Padded',
  'padded',
  'Same',
  'same',
  'mixed',
  'Mixed',
  'MIXED',
  'istanbul',
  'İSTANBUL',
  'i̇stanbul',
  'οδος',
  'ΟΔΟΣ',
  'οδοσ',
  'straße',
  'STRASSE',
  'Wide',
  'wide',
  'G',
  'g',
  '^twin',
  '^p1',
]

/** mulberry32, so the generated half of the recording is a pure function of this file. */
const FRAGMENT_SEED = 0xf4a6_3e01
const FRAGMENT_GENERATED = 400

function* rng(seed: number): Generator<number> {
  let a = seed
  for (;;) {
    a = (a + 0x6d2b_79f5) | 0
    let x = Math.imul(a ^ (a >>> 15), 1 | a)
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x
    yield ((x ^ (x >>> 14)) >>> 0) / 4_294_967_296
  }
}

const TITLES = ['Alpha', 'alpha', 'ALPHA', 'Beta', ' Beta', 'Gamma ', 'ΟΔΟΣ', 'Straße', '', 'a b']

/** A board of groups and cards on a coarse grid, so containment and nesting come often. */
function generated(next: () => number, n: number): Input {
  const at = () => Math.floor(next() * 8) * 25
  const nodes: SpatialNode[] = []
  for (let i = 0, count = 1 + Math.floor(next() * 10); i < count; i += 1) {
    const [x, y] = [at(), at()]
    if (next() < 0.4) {
      const title = TITLES[Math.floor(next() * TITLES.length)] as string
      const [w, h] = [75 + at(), 75 + at()]
      nodes.push(frame(`n${i}`, x, y, w, h, next() < 0.9 ? title : undefined))
    } else {
      const [w, h] = [5 + Math.floor(next() * 3) * 10, 5 + Math.floor(next() * 3) * 10]
      nodes.push(card(`n${i}`, x, y, w, h))
    }
  }
  const pick = () => `n${Math.floor(next() * (nodes.length + 1))}`
  const edges = Array.from({ length: Math.floor(next() * 9) }, (_, i) => edge(`e${i}`, pick(), pick()))
  const end = () => (next() < 0.5 ? onNode(pick()) : atPoint(at(), at()))
  const lines = Array.from({ length: Math.floor(next() * 3) }, (_, i) => line(`l${i}`, end(), end()))
  const roll = next()
  // Half the labels asked for are ones the board holds, so groups are found often.
  const held = nodes.flatMap((node) => (node.label === undefined ? [] : [node.label]))
  const title =
    held.length > 0 && next() < 0.5
      ? (held[Math.floor(next() * held.length)] as string)
      : (TITLES[Math.floor(next() * TITLES.length)] as string)
  const fragment =
    roll < 0.35 ? `^${pick()}` : roll < 0.7 ? title : roll < 0.85 ? title.toUpperCase() : ` ${title.toLowerCase()} `
  return {
    id: `gen/${n}`,
    canvas: { nodes, edges, ...(lines.length === 0 ? {} : { lines }) },
    fragment,
  }
}

export function canvasFragmentInputs(): readonly Input[] {
  const out: Input[] = []
  for (const [name, canvas] of BOARDS) {
    for (const [n, fragment] of FRAGMENTS.entries()) {
      out.push({ id: `hand/${name}/${n}`, canvas, fragment })
    }
  }
  const stream = rng(FRAGMENT_SEED)
  const next = () => stream.next().value as number
  for (let n = 0; n < FRAGMENT_GENERATED; n += 1) out.push(generated(next, n))
  return out
}

export function canvasFragmentAnswer(input: Input): CanvasFragmentRecord {
  const part = selectCanvasFragment(input.canvas, input.fragment)
  const selected =
    part === undefined
      ? null
      : {
          nodes: part.nodes.map((node) => node.id),
          edges: part.edges.map((e) => e.id),
          lines: part.lines === undefined ? null : part.lines.map((l) => l.id),
        }
  return { ...input, selected }
}
