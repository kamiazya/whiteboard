import type { CanvasEdge, SpatialCanvas, SpatialNode } from '@kamiazya/whiteboard-model'
import { nodeEndpoint } from '@kamiazya/whiteboard-model'
import { tidyNodes } from '../tidy.js'

/**
 * Boards for the drawing scoreboard: the two diagrams the tool-surface
 * lane asks a model to draw (an architecture in layers, a sequence), each
 * as a REFERENCE a person would accept, and as a DRAFT with the mistakes a
 * first attempt makes — a box a few pixels off its row, gaps that differ,
 * a member jammed against its frame, a box across a frame's edge, a name
 * hidden under the frame above it. The draft's tidied form is what
 * `tidyNodes` buys on it and, as importantly, what it leaves.
 *
 * The lane's own fixture board is here too, verbatim, because it is what a
 * write task starts from and a change to its score is a change to the
 * baseline every lane run is read against.
 *
 * Nothing here is generated: a drawing is judged against what a reader
 * would accept, and that is a design, not a sample.
 */
export interface DrawingCase {
  readonly name: string
  readonly canvas: SpatialCanvas
}

const BOX_W = 200
const BOX_H = 80

const box = (
  id: string,
  text: string,
  x: number,
  y: number,
  width = BOX_W,
  height = BOX_H,
): SpatialNode => ({
  id,
  type: 'text',
  x,
  y,
  width,
  height,
  text,
})
const group = (
  id: string,
  label: string,
  x: number,
  y: number,
  width: number,
  height: number,
): SpatialNode => ({
  id,
  type: 'group',
  label,
  x,
  y,
  width,
  height,
})
const edge = (id: string, fromNode: string, toNode: string, label?: string): CanvasEdge => ({
  id,
  from: nodeEndpoint(fromNode),
  to: nodeEndpoint(toNode),
  ...(label === undefined ? {} : { label }),
})

const ARCHITECTURE_EDGES: CanvasEdge[] = [
  edge('e1', 'cli', 'api'),
  edge('e2', 'web', 'api'),
  edge('e3', 'mobile', 'api'),
  edge('e4', 'api', 'auth'),
  edge('e5', 'api', 'search'),
  edge('e6', 'auth', 'sqlite'),
  edge('e7', 'search', 'sqlite'),
  edge('e8', 'search', 'blob'),
]

/** Three layers, 40px of padding, 60px between boxes, 120px between layers. */
const architectureReference: SpatialCanvas = {
  nodes: [
    group('clients', 'Clients', 0, 0, 800, 200),
    box('cli', 'CLI', 40, 60),
    box('web', 'Web app', 300, 60),
    box('mobile', 'Mobile app', 560, 60),
    group('services', 'Services', 0, 320, 800, 200),
    box('api', 'API gateway', 40, 380),
    box('auth', 'Auth', 300, 380),
    box('search', 'Search', 560, 380),
    group('storage', 'Storage', 0, 640, 800, 200),
    box('sqlite', 'SQLite', 40, 700),
    box('blob', 'Blob store', 300, 700),
  ],
  edges: ARCHITECTURE_EDGES,
}

/**
 * The same diagram as a first attempt draws it: `web` two pixels off the
 * row and a few to the right, `mobile` with a wider gap, `cli` jammed
 * against its frame, `search` across the Services frame's right edge,
 * `auth` over `api`, and the Storage frame drawn so close under Services
 * that its name sits inside the frame above.
 */
const architectureDrafted: SpatialCanvas = {
  nodes: [
    group('clients', 'Clients', 0, 0, 800, 200),
    box('cli', 'CLI', 8, 60),
    box('web', 'Web app', 306, 62),
    box('mobile', 'Mobile app', 590, 60),
    group('services', 'Services', 0, 320, 800, 200),
    box('api', 'API gateway', 40, 380),
    box('auth', 'Auth', 200, 380),
    box('search', 'Search', 640, 380),
    group('storage', 'Storage', 0, 530, 800, 200),
    box('sqlite', 'SQLite', 40, 590),
    box('blob', 'Blob store', 300, 590),
  ],
  edges: ARCHITECTURE_EDGES,
}

/**
 * Participants as column heads, each message a box between the two
 * columns it travels between, lower than the one before, joined to the
 * participant it goes to.
 */
const sequenceReference: SpatialCanvas = {
  nodes: [
    box('browser', 'Browser', 0, 0),
    box('daemon', 'Daemon', 400, 0),
    box('sqlite', 'SQLite', 800, 0),
    box('m1', 'open document', 200, 160, 200, 60),
    box('m2', 'load snapshot', 600, 280, 200, 60),
    box('m3', 'rows', 600, 400, 200, 60),
    box('m4', 'render', 200, 520, 200, 60),
  ],
  edges: [
    edge('e1', 'm1', 'daemon'),
    edge('e2', 'm2', 'sqlite'),
    edge('e3', 'm3', 'daemon'),
    edge('e4', 'm4', 'browser'),
  ],
}

/**
 * The first attempt: heads not quite on one row, the first message drawn
 * over a head, two messages stacked with different gaps, and the last one
 * off the column it belongs to.
 */
const sequenceDrafted: SpatialCanvas = {
  nodes: [
    box('browser', 'Browser', 0, 0),
    box('daemon', 'Daemon', 400, 6),
    box('sqlite', 'SQLite', 810, 0),
    box('m1', 'open document', 150, 40, 200, 60),
    box('m2', 'load snapshot', 600, 200, 200, 60),
    box('m3', 'rows', 600, 300, 200, 60),
    box('m4', 'render', 220, 460, 200, 60),
  ],
  edges: [
    edge('e1', 'm1', 'daemon'),
    edge('e2', 'm2', 'sqlite'),
    edge('e3', 'm3', 'daemon'),
    edge('e4', 'm4', 'browser'),
  ],
}

/** `scripts/eval/fixture.mjs`'s `boards/architecture`, as the lane seeds it. */
const fixtureArchitecture: SpatialCanvas = {
  nodes: [
    box('browser', 'Browser', 0, 0),
    box('daemon', 'Daemon', 400, 0),
    box('sqlite', 'SQLite', 800, 0),
    box('worker', 'Layout worker', 0, 300),
    group('clients', 'Clients', 0, 600, 700, 300),
    box('cli', 'CLI', 40, 700),
    box('webapp', 'Web app', 300, 700),
  ],
  edges: [
    edge('ws', 'browser', 'daemon', 'WebSocket'),
    edge('db', 'daemon', 'sqlite', 'libsql'),
    edge('pm', 'browser', 'worker', 'postMessage'),
  ],
}

/**
 * The architecture board a model drew through the tool surface on the
 * lane's first drawing-column run (2026-09-09), verbatim. Every box is in
 * place, and every edge carries `fromSide: 'bottom', toSide: 'top'` — the
 * model wrote the sides that suit a layer-to-layer edge onto ALL eight,
 * including API gateway's two to the boxes beside it on the same row. The
 * router honours a pinned side, so those two leave from the bottom, loop
 * under and back over, tunnel through API gateway itself and cross the
 * Web app edge. Without the sides the board owes no debt, at the router's
 * own price of two crossings. A finding about what `edge.add` lets a model
 * pin, kept here so whichever fix lands — a description that leaves sides
 * to the router, or a router that treats a side as a preference — is
 * measured against it.
 */
const laneArchitecture: SpatialCanvas = {
  nodes: [
    group('g-clients', 'Clients', 0, 0, 820, 200),
    group('g-services', 'Services', 0, 300, 820, 200),
    group('g-storage', 'Storage', 0, 580, 820, 200),
    box('cli', 'CLI', 40, 50, 220, 100),
    box('web', 'Web app', 300, 50, 220, 100),
    box('mobile', 'Mobile app', 560, 50, 220, 100),
    box('apigw', 'API gateway', 40, 350, 220, 100),
    box('auth', 'Auth', 300, 350, 220, 100),
    box('search', 'Search', 560, 350, 220, 100),
    box('sqlite', 'SQLite', 40, 630, 220, 100),
    box('blob', 'Blob store', 300, 630, 220, 100),
  ],
  edges: (
    [
      ['e1', 'cli', 'apigw'],
      ['e2', 'web', 'apigw'],
      ['e3', 'mobile', 'apigw'],
      ['e4', 'apigw', 'auth'],
      ['e5', 'apigw', 'search'],
      ['e6', 'auth', 'sqlite'],
      ['e7', 'search', 'sqlite'],
      ['e8', 'search', 'blob'],
    ] as const
  ).map(([id, fromNode, toNode]) => ({
    id,
    from: { kind: 'node' as const, node: fromNode, side: 'bottom' as const },
    to: { kind: 'node' as const, node: toNode, side: 'top' as const, end: 'arrow' as const },
  })),
}

/** The draft after `tidyNodes`, every move applied. */
function tidied(canvas: SpatialCanvas): SpatialCanvas {
  const moves = new Map(
    tidyNodes(canvas.nodes, { edges: canvas.edges }).map((m) => [m.id, m] as const),
  )
  return {
    ...canvas,
    nodes: canvas.nodes.map((n) => {
      const move = moves.get(n.id)
      return move === undefined
        ? n
        : {
            ...n,
            x: move.x,
            y: move.y,
            width: move.width ?? n.width,
            height: move.height ?? n.height,
          }
    }),
  }
}

/**
 * The fixture board after a model inserted a box between two connected
 * boxes on the lane's first run of that task (2026-09-10), verbatim: the
 * row's gap was 200px, the box 200 wide, and the model narrowed the box to
 * 150 and centred it, leaving 25px on each side with an edge label to fit
 * in one of them. Nothing overlaps and the row is kept, which is all the
 * verifier asks; what a reader sees is a row jammed shut. The board that
 * made `tightGaps` a column, kept so a fix — room made for the box, or a
 * surface that offers it — is measured against it.
 */
const laneInsert: SpatialCanvas = {
  nodes: [...fixtureArchitecture.nodes, box('cache', 'Cache', 625, 0, 150, 80)],
  edges: [
    ...fixtureArchitecture.edges.filter((e) => e.id !== 'db'),
    {
      id: 'daemon-cache',
      from: { kind: 'node' as const, node: 'daemon' },
      to: { kind: 'node' as const, node: 'cache', end: 'arrow' as const },
      label: '',
    },
    {
      id: 'cache-sqlite',
      from: { kind: 'node' as const, node: 'cache' },
      to: { kind: 'node' as const, node: 'sqlite', end: 'arrow' as const },
      label: 'libsql',
    },
  ],
}

/**
 * The same errand after the server instructions said to move the
 * neighbours over rather than squeeze the box (2026-09-10), verbatim from
 * the lane's first trial: SQLite moved right by 100, Cache kept its full
 * width, and the row's two new gaps are 50px — room for a box but not for
 * the "libsql" label its 50px edge carries, which is what
 * `edgeLabelPlacement` then answers.
 */
const laneInsertRoomy: SpatialCanvas = {
  nodes: [
    ...fixtureArchitecture.nodes.map((n) => (n.id === 'sqlite' ? { ...n, x: 900 } : n)),
    box('cache', 'Cache', 650, 0),
  ],
  edges: laneInsert.edges,
}

export const DRAWING_CORPUS: readonly DrawingCase[] = [
  { name: 'architecture/reference', canvas: architectureReference },
  { name: 'architecture/drafted', canvas: architectureDrafted },
  { name: 'architecture/tidied', canvas: tidied(architectureDrafted) },
  { name: 'sequence/reference', canvas: sequenceReference },
  { name: 'sequence/drafted', canvas: sequenceDrafted },
  { name: 'sequence/tidied', canvas: tidied(sequenceDrafted) },
  { name: 'fixture/architecture', canvas: fixtureArchitecture },
  { name: 'lane/architecture', canvas: laneArchitecture },
  { name: 'lane/architecture-tidied', canvas: tidied(laneArchitecture) },
  { name: 'lane/insert', canvas: laneInsert },
  { name: 'lane/insert-roomy', canvas: laneInsertRoomy },
]
