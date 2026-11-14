import type {
  CanvasColor,
  CanvasEdge,
  SpatialCanvas,
  SpatialNode,
} from '@kamiazya/whiteboard-model'
import { fileNode, groupNode, linkNode, textNode } from '@kamiazya/whiteboard-model/test-utils'
import { VISUAL_AXES_KEY } from '@kamiazya/whiteboard-plugin-visual'

/**
 * The boards the legend recording reads: one per reading the colour channel
 * can have — carried by a scoped-tag key, a frame, a kind, a stencil or a
 * declared axis, contested, unused — and a deterministic sweep of small
 * boards whose colour is driven by one of those, so a key is carried often
 * and a near miss (one box off its class's colour) just as often.
 */

export interface Board {
  readonly name: string
  readonly canvas: SpatialCanvas
}

const STENCIL = 'visual.stencil/v0'
const STATUS = 'x.status/v0'
const OWNER = 'x.owner/v0'

const box = (id: string, x: number, more: Partial<SpatialNode> = {}): SpatialNode => ({
  ...textNode({ id, x, y: 0, width: 80, height: 40, text: id }),
  ...more,
})

const edge = (
  id: string,
  from: string,
  to: string,
  more: Partial<CanvasEdge> = {},
): CanvasEdge => ({
  id,
  from: { node: from },
  to: { node: to },
  ...more,
})

const canvas = (
  nodes: readonly SpatialNode[],
  edges: readonly CanvasEdge[] = [],
  facets?: SpatialCanvas['facets'],
): SpatialCanvas => ({
  nodes: [...nodes],
  edges: [...edges],
  ...(facets === undefined ? {} : { facets }),
})

/** Colour carried by a tag key, with an untagged class and two near misses. */
function tagBoards(): Board[] {
  const health = [
    box('a', 0, { color: '1', tags: ['health:ok', 'plain tag'] }),
    box('b', 100, { color: '1', tags: ['health:ok', 'tier:b'] }),
    box('c', 200, { color: '#ff0000', tags: ['health:failing', 'tier:a'] }),
    box('d', 300, { tags: ['tier:a'] }),
  ]
  return [
    { name: 'tag-carried', canvas: canvas(health) },
    // The untagged class wears two colours: nothing carries it.
    {
      name: 'tag-rest-mixed',
      canvas: canvas([...health, box('e', 400, { color: '2' })]),
    },
    // One tagged box off its class's colour.
    {
      name: 'tag-class-mixed',
      canvas: canvas([...health, box('e', 400, { color: '2', tags: ['health:ok'] })]),
    },
    // A box with two values under the key: it partitions nothing.
    {
      name: 'tag-multi',
      canvas: canvas([...health.slice(0, 3), box('d', 300, { tags: ['health:ok', 'health:x'] })]),
    },
    // The same value twice is two values as well.
    {
      name: 'tag-multi-repeat',
      canvas: canvas([...health.slice(0, 3), box('d', 300, { tags: ['health:ok', 'health:ok'] })]),
    },
    // Every box in one class: a one-class key declares nothing.
    {
      name: 'tag-one-class',
      canvas: canvas([
        box('a', 0, { color: '1', tags: ['health:ok'] }),
        box('b', 100, { color: '2', tags: ['health:ok'] }),
      ]),
    },
    // Two keys carry it at once, and a built-in key written as a tag is not one.
    {
      name: 'tag-two-keys',
      canvas: canvas([
        box('a', 0, { color: '1', tags: ['zone:n', 'health:ok', 'kind:x', 'stencil:y'] }),
        box('b', 100, { color: '2', tags: ['zone:s', 'health:bad', 'kind:z'] }),
      ]),
    },
  ]
}

const frameOf = (id: string, x: number, y: number, w: number, h: number) =>
  groupNode({ id, x, y, width: w, height: h, label: id })

/** Colour carried by frame membership, the first frame holding a box winning. */
function frameBoards(): Board[] {
  const frames = [frameOf('f1', 0, 0, 200, 100), frameOf('f2', 0, 0, 400, 100)]
  const inside = (id: string, x: number, color?: CanvasColor, tags?: string[]) =>
    box(id, x, { y: 10, ...(color === undefined ? {} : { color }), ...(tags ? { tags } : {}) })
  return [
    {
      name: 'frame-carried',
      canvas: canvas([
        ...frames,
        inside('a', 10, '1'),
        // Touching f1's right border: inside, edge-inclusive.
        inside('b', 120, '1'),
        inside('c', 210, '2', ['frame:west']),
        inside('d', 320, '2', ['frame:east']),
        box('e', 500, { y: 10, color: '3' }),
      ]),
    },
    {
      name: 'frame-poking-out',
      canvas: canvas([
        ...frames,
        inside('a', 10, '1'),
        // One pixel past f1's right border: f2's.
        inside('b', 121, '1'),
        inside('c', 210, '2'),
      ]),
    },
    {
      name: 'frame-each-side',
      canvas: canvas([
        frameOf('f', 0, 0, 100, 100),
        box('in', 0, { y: 0, width: 100, height: 100, color: '1' }),
        box('left', -1, { y: 0, width: 100, height: 100, color: '2' }),
        box('up', 0, { y: -1, width: 100, height: 100, color: '2' }),
        box('wide', 0, { y: 0, width: 101, height: 100, color: '2' }),
        box('tall', 0, { y: 0, width: 100, height: 101, color: '2' }),
      ]),
    },
  ]
}

/** Colour carried by what a box shows, and by the stencil it wears. */
function kindBoards(): Board[] {
  const unclaimed: SpatialNode = {
    ...box('u', 400, { color: '4' }),
    resource: { mimeType: 'text/markdown' },
  }
  const stencil = (id: string) => ({ [STENCIL]: { stencil: id } })
  return [
    {
      name: 'kind-carried',
      canvas: canvas([
        box('t', 0, { color: '1' }),
        fileNode({ id: 'f', x: 100, y: 0, width: 80, height: 40, file: 'a.md', color: '2' }),
        linkNode({ id: 'l', x: 200, y: 0, width: 80, height: 40, url: 'https://x/', color: '3' }),
        unclaimed,
      ]),
    },
    {
      name: 'stencil-carried',
      canvas: canvas([
        box('a', 0, { color: '5', facets: stencil('aws.ec2') }),
        box('b', 100, { color: '5', facets: stencil('aws.ec2') }),
        box('c', 200, { color: '6', facets: stencil('aws.rds') }),
        box('d', 300),
      ]),
    },
    {
      name: 'stencil-unreadable',
      canvas: canvas([
        box('a', 0, { color: '5', facets: { [STENCIL]: { stencil: 3 } } }),
        box('b', 100, { color: '6', facets: stencil('aws.rds') }),
        box('c', 200, { color: '5' }),
      ]),
    },
  ]
}

/** Colour carried by a declared axis, read off each box's payload. */
function axisBoards(): Board[] {
  const axes = (...keys: unknown[]) => ({ [VISUAL_AXES_KEY]: { axes: keys } })
  const marked = (id: string, x: number, color: CanvasColor | undefined, payload: unknown) =>
    box(id, x, {
      ...(color === undefined ? {} : { color }),
      ...(payload === undefined ? {} : { facets: { [STATUS]: payload } }),
    })
  const nodes = [
    marked('a', 0, '1', { level: 1, tone: 'up' }),
    marked('b', 100, '1', { tone: 'up', level: 1 }),
    marked('c', 200, '2', { level: 2, tone: 'up' }),
    // Unmarked and null are one class.
    marked('d', 300, '3', undefined),
    marked('e', 400, '3', null),
  ]
  return [
    // Declared twice, beside a key nobody carries and junk.
    { name: 'axis-carried', canvas: canvas(nodes, [], axes(STATUS, OWNER, STATUS, 7)) },
    { name: 'axis-undeclared', canvas: canvas(nodes) },
    { name: 'axis-not-a-list', canvas: canvas(nodes, [], { [VISUAL_AXES_KEY]: { axes: STATUS } }) },
    { name: 'axis-not-an-object', canvas: canvas(nodes, [], { [VISUAL_AXES_KEY]: 'x' }) },
    {
      name: 'axis-off-by-one',
      canvas: canvas([...nodes, marked('f', 500, '2', { level: 1, tone: 'up' })], [], axes(STATUS)),
    },
    {
      name: 'axis-number-forms',
      canvas: canvas(
        [
          marked('a', 0, '1', [0, 'x']),
          marked('b', 100, '1', [-0, 'x']),
          marked('c', 200, '2', [1]),
        ],
        [],
        axes(STATUS),
      ),
    },
  ]
}

/** The edges' own reading, beside the boxes'. */
function edgeBoards(): Board[] {
  const nodes = [box('a', 0), box('b', 100), box('c', 200)]
  const tagged = (id: string, color: CanvasColor | undefined, tags?: string[]) =>
    edge(id, 'a', 'b', { ...(color === undefined ? {} : { color }), ...(tags ? { tags } : {}) })
  return [
    {
      name: 'edges-carried',
      canvas: canvas(nodes, [
        tagged('e1', '1', ['flow:sync']),
        tagged('e2', '#00ff00', ['flow:async']),
        tagged('e3', '1', ['flow:sync', 'frame:x']),
        tagged('e4', undefined),
      ]),
    },
    {
      name: 'edges-contested',
      canvas: canvas(nodes, [tagged('e1', '1', ['flow:sync']), tagged('e2', '2', ['flow:sync'])]),
    },
    {
      name: 'edges-multi',
      canvas: canvas(nodes, [
        tagged('e1', '1', ['flow:sync', 'flow:async']),
        tagged('e2', '2', ['flow:async']),
      ]),
    },
    {
      name: 'edges-and-boxes',
      canvas: canvas(
        [
          box('a', 0, { color: '1', tags: ['tier:a'] }),
          box('b', 100, { color: '2', tags: ['tier:b'] }),
        ],
        [tagged('e1', '3', ['tier:a']), tagged('e2', '3'), tagged('e3', '4', ['tier:b'])],
      ),
    },
    { name: 'empty', canvas: canvas([]) },
    {
      name: 'one-colour',
      canvas: canvas([box('a', 0, { color: '1' }), box('b', 100, { color: '1' })]),
    },
  ]
}

/** A deterministic stream of draws (mulberry32), so the sweep records the same boards. */
function draws(seed: number): (n: number) => number {
  let state = seed >>> 0
  return (n) => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n)
  }
}

const COLOURS: readonly (CanvasColor | undefined)[] = [undefined, '1', '2', '#ff0000']
const KEYS = ['health', 'tier', 'frame', 'kind'] as const
const VALUES = ['a', 'b', 'c'] as const

function sweepTags(pick: (n: number) => number): string[] {
  const tags: string[] = []
  for (const key of KEYS) {
    if (pick(3) === 0) continue
    tags.push(`${key}:${VALUES[pick(3)]}`)
    if (pick(8) === 0) tags.push(`${key}:${VALUES[pick(3)]}`)
  }
  return tags
}

/** One swept board: a driver key's value picks most boxes' colour, a few go astray. */
function sweepBoard(index: number): Board {
  const pick = draws(index + 1)
  const driver = KEYS[pick(KEYS.length)] ?? 'health'
  const colourOf = (tags: readonly string[]) => {
    if (pick(6) === 0) return COLOURS[pick(COLOURS.length)]
    const value = tags.find((t) => t.startsWith(`${driver}:`))?.split(':')[1]
    return COLOURS[value === undefined ? 0 : VALUES.indexOf(value as never) + 1]
  }
  const frames = pick(3) === 0 ? [frameOf('f', 0, 0, 250, 100)] : []
  const nodes = Array.from({ length: pick(7) }, (_, i) => {
    const tags = sweepTags(pick)
    const color = colourOf(tags)
    return box(`n${i}`, i * 100, { ...(color ? { color } : {}), ...(tags.length ? { tags } : {}) })
  })
  const edges = Array.from({ length: nodes.length > 1 ? pick(4) : 0 }, (_, i) => {
    const tags = sweepTags(pick)
    const color = colourOf(tags)
    return edge(`e${i}`, 'n0', 'n1', {
      ...(color ? { color } : {}),
      ...(tags.length ? { tags } : {}),
    })
  })
  return { name: `sweep-${index}`, canvas: canvas([...frames, ...nodes], edges) }
}

const SWEEP = 160

export function boards(): Board[] {
  return [
    ...tagBoards(),
    ...frameBoards(),
    ...kindBoards(),
    ...axisBoards(),
    ...edgeBoards(),
    ...Array.from({ length: SWEEP }, (_, i) => sweepBoard(i)),
  ]
}
