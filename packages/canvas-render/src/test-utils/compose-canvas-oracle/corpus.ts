import type { CanvasEdge, CanvasLine, SpatialCanvas, SpatialNode } from '@kamiazya/whiteboard-model'
import type { TagLibrary } from '@kamiazya/whiteboard-plugin-visual'
import type { EdgeAnchorOverride } from '../../layout/edges/edge-sides.js'

/**
 * The inputs of the compose-canvas recording: whole canvases laid out by
 * `layoutSpatialCanvasWithAnchors`, their edges alone by `layoutSpatialEdges`,
 * and each node's natural size, under the options a caller hands a layout.
 * Nothing is random. No node id is an `Object.prototype` key: the TypeScript's
 * silhouette table is a plain object and would read one as shaped.
 */

export interface Board {
  readonly name: string
  readonly canvas: SpatialCanvas
}

/** How the base appearance is built: the light or dark theme, or the dark one with no mode stamped. */
type Appearance = 'light' | 'dark' | 'unmoded-dark'

/** Which families the surface holds: the bundled one alone, every one, or none. */
type Fonts = 'default' | 'all' | 'none'

/** What a reference or an embed resolves to: a canvas, under the name an embed shows. */
interface Nested {
  readonly title: string
  readonly canvas: SpatialCanvas
}

export interface CaseSpec {
  readonly board: string
  readonly style?: string
  readonly appearance: Appearance
  readonly geometry?: readonly number[]
  readonly fonts: Fonts
  readonly locked?: readonly string[]
  readonly suppressed?: readonly string[]
  readonly library?: boolean
  readonly overrides?: readonly (readonly [string, EdgeAnchorOverride])[]
  readonly embedPath?: readonly string[]
  /** A content cache is handed over, and the keys it is asked are recorded. */
  readonly cache?: boolean
}

const text = (
  id: string,
  x: number,
  y: number,
  body = `body of ${id}`,
  extra: Partial<SpatialNode> = {},
  width = 160,
  height = 80,
): SpatialNode => ({
  id,
  x,
  y,
  width,
  height,
  resource: { mimeType: 'text/markdown', content: body },
  ...extra,
})

const frame = (id: string, x: number, y: number, w: number, h: number, label?: string) =>
  ({ id, x, y, width: w, height: h, ...(label === undefined ? {} : { label }) }) as SpatialNode

const edge = (id: string, from: string, to: string, extra: Partial<CanvasEdge> = {}) =>
  ({ id, from: { node: from }, to: { node: to, end: 'arrow' }, ...extra }) as CanvasEdge

const shaped = (kind: string) => ({ 'visual.shape/v0': { kind } })

/**
 * Frames listed after what they hold, two of equal size, frames holding a node
 * flush with each of their sides, frames holding nothing (one a pixel short of
 * a node on each side), a frame inside a frame, and a link and a file node.
 */
function layered(): Board {
  const nodes: SpatialNode[] = [
    text('m', 40, 60),
    frame('outer', 0, 0, 700, 400, 'Outer'),
    frame('inner', 20, 40, 300, 200, 'Inner'),
    frame('twin-a', 900, 0, 100, 100),
    frame('twin-b', 1100, 0, 100, 100, 'Twin'),
    frame('flush-near', 0, 600, 200, 200),
    text('near', 0, 600, 'near', {}, 50, 50),
    frame('flush-far', 300, 600, 200, 200),
    text('far', 450, 750, 'far', {}, 50, 50),
    frame('short-left', 600, 600, 100, 100),
    text('out-left', 599, 620, 'x', {}, 20, 20),
    frame('short-right', 800, 600, 100, 100),
    text('out-right', 881, 620, 'x', {}, 20, 20),
    frame('short-top', 1000, 600, 100, 100),
    text('out-top', 1020, 599, 'x', {}, 20, 20),
    frame('short-bottom', 1200, 600, 100, 100),
    text('out-bottom', 1220, 681, 'x', {}, 20, 20),
    text('n2', 400, 60, 'Second **bold** body'),
    {
      id: 'link',
      x: 400,
      y: 200,
      width: 200,
      height: 60,
      resource: { mimeType: 'text/uri-list', location: 'https://example.com/a' },
    },
    {
      id: 'file',
      x: 400,
      y: 300,
      width: 200,
      height: 60,
      resource: { mimeType: 'text/markdown', location: 'notes/a.md' },
    },
  ]
  const edges = [edge('m-n2', 'm', 'n2', { label: 'flow' }), edge('n2-link', 'n2', 'link')]
  const lines: CanvasLine[] = [
    {
      id: 'ink',
      from: { kind: 'point', point: { x: 760, y: 40 } },
      to: { kind: 'node', node: 'file' },
    },
  ]
  return { name: 'layered', canvas: { nodes, edges, lines } }
}

/** A canvas naming the sketch theme and its own routing, with shaped nodes and a frame. */
function themed(): Board {
  return {
    name: 'themed',
    canvas: {
      facets: {
        'visual.theme/v0': { theme: 'visual.sketch' },
        'visual.edges/v0': { routing: 'orthogonal', lineJumps: 'arc' },
      },
      nodes: [
        frame('group', 0, 0, 600, 300, 'Group'),
        text('a', 20, 40, 'alpha', { facets: shaped('ellipse') }),
        text('b', 300, 40, 'beta'),
        text('c', 20, 400, 'gamma', { color: '3' }),
      ],
      edges: [
        edge('a-b', 'a', 'b', { label: 'ab' }),
        edge('b-c', 'b', 'c'),
        edge('a-c', 'a', 'c', { facets: { 'visual.edges/v0': { routing: 'rounded' } } }),
      ],
    },
  }
}

/** Under a theme whose default silhouette fills in where a node's own facet is silent. */
function boxy(): Board {
  return {
    name: 'boxy',
    canvas: {
      nodes: [
        frame('holder', 0, 0, 500, 300, 'Holder'),
        text('plain', 20, 40, 'plain'),
        text('own', 240, 40, 'own', { facets: shaped('hexagon') }),
      ],
      edges: [edge('plain-own', 'plain', 'own')],
    },
  }
}

/** A canvas naming a theme no contribution registered. */
function unknown(): Board {
  return {
    name: 'unknown',
    canvas: {
      facets: { 'visual.theme/v0': { theme: 'visual.nope' } },
      nodes: [text('a', 0, 0, 'a'), text('b', 300, 0, 'b')],
      edges: [edge('a-b', 'a', 'b')],
    },
  }
}

/** Boxes and edges carrying scoped tags the library colours, contests or leaves alone. */
function tagged(): Board {
  const tags = (...list: string[]) => ({ tags: list })
  return {
    name: 'tagged',
    canvas: {
      tags: ['health:failing'],
      nodes: [
        text('failing', 0, 0, 'f', tags('health:failing')),
        text('contested', 200, 0, 'c', tags('health:ok', 'team:core')),
        text('twice', 400, 0, 't', tags('health:failing', 'health:failing')),
        text('own', 600, 0, 'o', { ...tags('health:failing'), color: '2' }),
        text('silent', 0, 200, 's', tags('plain', 'health:unknown', 'Health:failing')),
        text('later', 200, 200, 'l', tags('health:failing:x', 'team:core')),
        text('none', 400, 200, 'n'),
        text('hex', 600, 200, 'h', tags('team:hex')),
      ],
      edges: [
        edge('e-ok', 'failing', 'contested', tags('health:ok')),
        edge('e-own', 'twice', 'own', { ...tags('health:ok'), color: '6' }),
        edge('e-none', 'silent', 'later', tags('health:unknown')),
      ],
      lines: [
        {
          id: 'ink',
          from: { kind: 'node', node: 'none' },
          to: { kind: 'node', node: 'hex' },
        },
      ],
    },
  }
}

const file = (id: string, x: number, y: number, location: string, w = 300, h = 200) =>
  ({
    id,
    x,
    y,
    width: w,
    height: h,
    resource: { mimeType: 'application/octet-stream', location },
  }) as SpatialNode

/**
 * The canvases a reference resolves to. `child` names its own theme, holds a
 * frame and an empty one, a tagged box, a node under ids the top-level options
 * lock and suppress, a file node back to itself (the path-local cycle) and one
 * further down. `plain` names none, so it inherits the theme it is drawn in.
 * `deep-1` to `deep-4` nest past the depth cap.
 */
export const REFERENCES: Readonly<Record<string, Nested>> = {
  'boards/child.canvas': {
    title: 'Child',
    canvas: {
      facets: { 'visual.theme/v0': { theme: 'visual.neon' } },
      nodes: [
        frame('cf', 0, 0, 400, 260, 'Held'),
        text('m', 20, 40, 'locked above', { tags: ['health:failing'] }),
        text('n2', 200, 40, 'suppressed above'),
        frame('cempty', 500, 0, 120, 120),
        file('loop', 500, 200, 'boards/child.canvas', 160, 100),
        file('deeper', 700, 0, 'boards/deep-1.canvas', 200, 140),
      ],
      edges: [edge('m-n2', 'm', 'n2')],
    },
  },
  'boards/plain.canvas': {
    title: 'Plain',
    canvas: {
      nodes: [
        text('p1', 0, 0, 'first', { facets: shaped('ellipse') }),
        text('p2', 240, 0, 'second'),
      ],
      edges: [edge('p1-p2', 'p1', 'p2', { label: 'on' })],
    },
  },
  ...Object.fromEntries(
    [1, 2, 3, 4].map((level) => [
      `boards/deep-${level}.canvas`,
      {
        title: `Deep ${level}`,
        canvas: {
          nodes: [
            text(`d${level}`, 0, 0, `level ${level}`),
            file(`down${level}`, 200, 0, `boards/deep-${level + 1}.canvas`),
          ],
          edges: [],
        },
      },
    ]),
  ),
}

/** The document `![[child]]` resolves to, and the canvas it draws. */
export const CHILD_ID = '01HZX3Q8K9V2M4N5P6R7S8T9WC'
export const resolveAlias = (alias: string): string | null => (alias === 'child' ? CHILD_ID : null)

/** A canvas drawing others: two by reference, one through a body's embed, and a chain past the cap. */
function nesting(): Board {
  return {
    name: 'nesting',
    canvas: {
      facets: { 'visual.theme/v0': { theme: 'visual.sketch' } },
      nodes: [
        file('f-child', 0, 0, 'boards/child.canvas', 400, 260),
        file('f-plain', 450, 0, 'boards/plain.canvas'),
        text('embedder', 0, 320, '![[child]]', {}, 400, 300),
        file('f-deep', 450, 320, 'boards/deep-1.canvas'),
        text('m', 800, 0, 'locked here'),
      ],
      edges: [edge('plain-deep', 'f-plain', 'f-deep')],
    },
  }
}

export const boards = (): readonly Board[] => [
  layered(),
  themed(),
  boxy(),
  unknown(),
  tagged(),
  nesting(),
]

export const TAG_LIBRARY: TagLibrary = {
  health: {
    values: { failing: { color: '1' }, ok: { color: '4' }, unknown: { description: 'unsure' } },
  },
  team: { values: { core: { color: '5' }, hex: { color: '#12ab34' } } },
}

/** A theme of a test contribution: the sketch tokens with a default silhouette. */
export const BOXY_THEME_ID = 'test.boxy'

const OVERRIDE: EdgeAnchorOverride = { fromSide: 'bottom', toSide: 'top' }

export const caseSpecs = (): readonly CaseSpec[] => [
  { board: 'layered', appearance: 'light', fonts: 'default' },
  {
    board: 'layered',
    appearance: 'dark',
    fonts: 'default',
    geometry: [12, 14, 40],
    locked: ['m', 'outer'],
    suppressed: ['n2'],
  },
  { board: 'layered', appearance: 'light', fonts: 'default', geometry: [Number.NaN, -1, -1] },
  { board: 'layered', appearance: 'light', fonts: 'default', geometry: [-1, 0, Infinity] },
  { board: 'layered', appearance: 'light', fonts: 'default', geometry: [0, 0.5, 0] },
  { board: 'layered', appearance: 'light', fonts: 'default', geometry: [12, -1, 40] },
  {
    board: 'layered',
    appearance: 'light',
    fonts: 'default',
    locked: ['m'],
    embedPath: ['doc-a'],
    overrides: [['m-n2', OVERRIDE]],
  },
  { board: 'themed', style: 'document', appearance: 'light', fonts: 'default' },
  { board: 'themed', style: 'document', appearance: 'light', fonts: 'all', cache: true },
  { board: 'themed', style: 'document', appearance: 'unmoded-dark', fonts: 'none' },
  { board: 'themed', appearance: 'light', fonts: 'all' },
  { board: 'themed', style: 'clean', appearance: 'dark', fonts: 'all' },
  { board: 'themed', style: 'visual.neon', appearance: 'dark', fonts: 'default' },
  { board: 'boxy', style: BOXY_THEME_ID, appearance: 'light', fonts: 'all' },
  { board: 'boxy', style: 'document', appearance: 'light', fonts: 'all' },
  { board: 'unknown', style: 'document', appearance: 'light', fonts: 'default' },
  { board: 'unknown', style: 'visual.gone', appearance: 'dark', fonts: 'default' },
  { board: 'tagged', appearance: 'light', fonts: 'default', library: true },
  { board: 'tagged', appearance: 'light', fonts: 'default' },
  { board: 'nesting', style: 'document', appearance: 'light', fonts: 'all' },
  {
    board: 'nesting',
    style: 'document',
    appearance: 'dark',
    fonts: 'default',
    locked: ['m'],
    suppressed: ['n2'],
    library: true,
  },
  { board: 'nesting', appearance: 'light', fonts: 'default', embedPath: ['boards/plain.canvas'] },
  { board: 'nesting', style: 'visual.neon', appearance: 'light', fonts: 'default' },
  // A cached walk under a path of two documents: the content cache's key
  // carries the path, so its every entry is spelled the same on both sides.
  {
    board: 'nesting',
    appearance: 'light',
    fonts: 'default',
    embedPath: ['doc-a', 'doc-b'],
    cache: true,
  },
]
