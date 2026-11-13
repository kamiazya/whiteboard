import type {
  CanvasEdge,
  CanvasLine,
  EdgeEnd,
  EdgeSide,
  NodeResource,
  SpatialCanvas,
  SpatialNode,
} from '@kamiazya/whiteboard-model'
import type { EdgeAnchorOverride } from '../../layout/edges/edge-sides.js'

/**
 * The inputs of the compose-edges recording: canvases whose edges and lines
 * the edge pass routes, weighs, pulls onto silhouettes and labels. Each board is
 * drawn under every theme the recording carries; nothing is random.
 */

/** A board, the silhouette each of its shaped nodes resolves to, and the editor's frozen sides. */
export interface Board {
  readonly name: string
  readonly canvas: SpatialCanvas
  readonly shapes: Readonly<Record<string, string>>
  readonly overrides?: readonly (readonly [string, EdgeAnchorOverride])[]
}

const TEXT: NodeResource = { mimeType: 'text/markdown', content: 'body' }

const box = (id: string, x: number, y: number, width = 160, height = 80): SpatialNode => ({
  id,
  x,
  y,
  width,
  height,
  resource: TEXT,
})

const frame = (id: string, x: number, y: number, w: number, h: number, label?: string) =>
  ({ id, x, y, width: w, height: h, ...(label === undefined ? {} : { label }) }) as SpatialNode

const end = (node: string, side?: EdgeSide, arrow?: boolean): EdgeEnd => ({
  node,
  ...(side === undefined ? {} : { side }),
  ...(arrow === undefined ? {} : { end: arrow ? 'arrow' : 'none' }),
})

const edge = (id: string, from: EdgeEnd, to: EdgeEnd, extra: Partial<CanvasEdge> = {}) =>
  ({ id, from, to, ...extra }) as CanvasEdge

const edgesFacet = (routing?: string, lineJumps?: string) => ({
  'visual.edges/v0': {
    ...(routing === undefined ? {} : { routing }),
    ...(lineJumps === undefined ? {} : { lineJumps }),
  },
})

const strokeFacet = (width: unknown) => ({ 'visual.stroke/v0': { width } })

const SILHOUETTES = [
  'visual.ellipse',
  'visual.diamond',
  'visual.hexagon',
  'visual.parallelogram',
  'visual.octagon',
  'visual.cylinder',
  'visual.nothing',
] as const

/** A rect and a shaped node, joined both ways and once from a named side. */
function shapedBoard(shape: string, index: number): Board {
  const nodes = [box('a', 0, 0), box('s', 300 + index * 7, 150, 160, 100), box('t', 40, 320)]
  const edges = [
    edge('a-s', end('a'), end('s', undefined, true), { label: 'in' }),
    edge('s-a', end('s', 'top'), end('a', undefined, true)),
    edge('s-t', end('s', 'left', false), end('t', 'right', true)),
  ]
  // Ink onto the shaped node's right side, whose midpoint a slanted silhouette
  // (the parallelogram's) leaves outside, so a line's node end is pulled as an edge's is.
  const lines = [
    line(
      'ink',
      { kind: 'point', point: { x: 760, y: 120 } },
      { kind: 'node', node: 's', side: 'right' },
    ),
  ]
  // Both ends shaped on the last edge, so each is pulled along its own approach.
  return {
    name: `shape-${shape}`,
    canvas: { nodes, edges, lines },
    shapes: { s: shape, t: shape },
  }
}

/** Labels that fit at the midpoint, that slide along or off their line, and that find nowhere. */
function labelBoards(): Board[] {
  const row = {
    name: 'labels-row',
    canvas: {
      nodes: [
        box('a', 0, 0),
        box('b', 200, 0),
        box('c', 400, 0, 160, 80),
        box('up', 160, -70, 80, 40),
      ],
      edges: [
        edge('a-b', end('a', 'right'), end('b', 'left'), { label: 'a label wider than the gap' }),
        edge('b-c', end('b', 'right'), end('c', 'left'), { label: 'mid' }),
        edge('a-c', end('a', 'bottom'), end('c', 'bottom'), { label: '   ' }),
        edge('c-a', end('c', 'top'), end('a', 'top'), { label: '' }),
      ],
    },
    shapes: {},
  }
  const column = {
    name: 'labels-column',
    canvas: {
      nodes: [box('top', 0, 0), box('bottom', 0, 140), box('side', 170, 60, 100, 40)],
      edges: [
        edge('down', end('top', 'bottom'), end('bottom', 'top'), {
          label: 'a long vertical label',
        }),
        edge('up', end('bottom', 'left'), end('top', 'left'), { label: 'back' }),
      ],
    },
    shapes: {},
  }
  const buried = {
    name: 'labels-buried',
    canvas: {
      nodes: [
        box('a', 100, 100, 40, 40),
        box('b', 260, 100, 40, 40),
        box('wall', -200, -200, 800, 600),
      ],
      edges: [edge('a-b', end('a'), end('b'), { label: 'nowhere clear' })],
    },
    shapes: {},
  }
  return [row, column, buried]
}

/** A frame whose title routes and labels avoid, holding two of the three boxes. */
function frameBoard(): Board {
  return {
    name: 'frames',
    canvas: {
      nodes: [
        frame('f', 0, 0, 520, 220, 'A frame title long enough to matter'),
        box('a', 40, 60),
        box('b', 320, 60),
        box('out', 160, -200),
        frame('bare', 700, 0, 200, 200),
      ],
      edges: [
        edge('a-b', end('a'), end('b'), { label: 'inside' }),
        edge('out-a', end('out', 'bottom'), end('a', 'top'), { label: 'over the title' }),
        edge('b-bare', end('b'), end('bare'), { label: 'to a frame' }),
      ],
    },
    shapes: { a: 'visual.ellipse' },
  }
}

/** Crossing edges, hopping by the canvas's facet or their own. */
function jumpBoards(): Board[] {
  const nodes = [
    box('l', 0, 120),
    box('r', 400, 120),
    box('t', 200, 0, 80, 40),
    box('b', 200, 300, 80, 40),
  ]
  const cross = (own?: Partial<CanvasEdge>) => [
    edge('h', end('l', 'right'), end('r', 'left'), own),
    edge('v', end('t', 'bottom'), end('b', 'top'), { label: 'crosses' }),
    edge('d', end('l', 'bottom'), end('r', 'top')),
  ]
  return [
    {
      name: 'jumps-canvas',
      canvas: { nodes, edges: cross(), facets: edgesFacet('orthogonal', 'arc') },
      shapes: {},
    },
    {
      name: 'jumps-own-off',
      canvas: {
        nodes,
        edges: cross({ facets: edgesFacet(undefined, 'none') }),
        facets: edgesFacet('straight', 'arc'),
      },
      shapes: {},
    },
    {
      name: 'jumps-own-on',
      canvas: { nodes, edges: cross({ facets: edgesFacet('curved', 'arc') }) },
      shapes: {},
    },
  ]
}

const line = (id: string, from: unknown, to: unknown, extra: Partial<CanvasLine> = {}) =>
  ({ id, from, to, ...extra }) as CanvasLine

/** Ink: free ends, an end on a node, bends, a label, a weight and its own routing. */
function lineBoard(): Board {
  const point = (x: number, y: number, arrow?: boolean) => ({
    kind: 'point',
    point: { x, y },
    ...(arrow === undefined ? {} : { end: arrow ? 'arrow' : 'none' }),
  })
  return {
    name: 'lines',
    canvas: {
      nodes: [box('a', 0, 0), box('b', 300, 200, 120, 120)],
      edges: [edge('a-b', end('a'), end('b'), { color: '4', facets: strokeFacet('thick') })],
      lines: [
        line('free', point(-100, 300), point(200, 400, true), { label: 'free ink' }),
        line('onto', { kind: 'node', node: 'b', side: 'left' }, point(600, 50)),
        line(
          'bent',
          point(0, 500),
          { kind: 'node', node: 'a' },
          {
            bends: [
              { x: 100, y: 450 },
              { x: 150, y: 200 },
            ],
            facets: { ...strokeFacet('medium'), ...edgesFacet('orthogonal') },
            label: 'bent',
          },
        ),
      ],
    },
    shapes: { b: 'visual.diamond' },
  }
}

/** What degrades: a missing end, a loop, a NaN box, a zero box, a duplicate id, a bad weight. */
function oddBoard(): Board {
  return {
    name: 'odd',
    canvas: {
      nodes: [
        box('a', 0, 0),
        box('nan', 300, Number.NaN),
        box('zero', 300, 300, 0, 0),
        box('c', 600, 0),
      ],
      edges: [
        edge('dangling', end('a'), end('ghost'), { label: 'never drawn' }),
        edge('loop', end('a', 'right'), end('a', 'bottom'), { label: 'loop' }),
        edge('to-nan', end('a'), end('nan'), { label: 'nan' }),
        edge('to-zero', end('c'), end('zero'), { facets: strokeFacet('enormous') }),
        edge('twice', end('a'), end('c'), {
          facets: { ...edgesFacet('orthogonal'), ...strokeFacet('medium') },
        }),
        edge('bent', end('c', 'bottom'), end('a', 'bottom'), {
          bends: [{ x: 400, y: 200 }],
          color: '#ff0000',
        }),
      ],
      lines: [
        line('twice', { kind: 'node', node: 'c' }, { kind: 'point', point: { x: 900, y: 300 } }),
      ],
    },
    shapes: { zero: 'visual.ellipse', nan: 'visual.hexagon' },
  }
}

/** Sides the editor froze, one naming no edge. */
function overrideBoard(): Board {
  return {
    name: 'overrides',
    canvas: {
      nodes: [box('a', 0, 0), box('b', 400, 200)],
      edges: [edge('ab', end('a'), end('b'), { label: 'frozen' }), edge('ba', end('b'), end('a'))],
    },
    shapes: {},
    overrides: [
      ['ghost', { fromSide: 'top', toSide: 'top' }],
      ['ab', { fromSide: 'bottom', toSide: 'left', from: { x: 80, y: 80 }, fromLaneDepth: 12 }],
      [
        'ba',
        { fromSide: 'right', toSide: 'right', around: true, to: { x: 160, y: 40 }, toLaneDepth: 4 },
      ],
    ],
  }
}

export function boards(): readonly Board[] {
  return [
    ...SILHOUETTES.map(shapedBoard),
    ...labelBoards(),
    frameBoard(),
    ...jumpBoards(),
    lineBoard(),
    oddBoard(),
    overrideBoard(),
  ]
}

/** The themes each board is drawn under: a theme's ink and routing default reach edges. */
export const THEMES = ['light', 'dark', 'sketch', 'neon'] as const
export type ThemeName = (typeof THEMES)[number]

/** Padding, label size and minimum width: the defaults, then a larger label. */
export const GEOMETRIES: readonly (readonly [number, number, number])[] = [
  [8, 16, 0],
  [12, 22, 40],
]
