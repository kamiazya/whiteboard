import type {
  CanvasEdge,
  CanvasLine,
  CommentThread,
  Proposal,
  ProposedChange,
  SpatialCanvas,
  SpatialNode,
} from '@kamiazya/whiteboard-model'

/**
 * The boards the compose-comments recording lays out with PROPOSALS (ADR-0029
 * decision 1): every arm outlined where it would land (a box for a node, a
 * route for an edge or a line already drawn, a straight line between centres
 * for one that is not), the arms that draw nothing (a decided change, a
 * passage change, an element that is gone, a free end), conflicts counted
 * into the bubble's label, and enough proposals on one spot that their bubbles
 * fan out around each other.
 */

export interface ProposalBoard {
  readonly name: string
  readonly canvas: SpatialCanvas
  readonly threads: readonly CommentThread[]
  readonly proposals: readonly Proposal[]
}

/** The label `parseBody` throws on, so a bubble degrades to its literal text. */
export const THROWING_LABEL = '5 proposed changes'

const box = (id: string, x: number, y: number, width = 140, height = 70): SpatialNode =>
  ({
    id,
    x,
    y,
    width,
    height,
    resource: { mimeType: 'text/markdown', content: id },
  }) as SpatialNode

const link = (id: string, from: string, to: string, extra: Partial<CanvasEdge> = {}) =>
  ({ id, from: { node: from }, to: { node: to, end: 'arrow' }, ...extra }) as CanvasEdge

type Status = ProposedChange['status']

let serial = 0
const change = <T extends object>(body: T, status: Status = 'open'): ProposedChange => {
  serial += 1
  return { id: `ch${serial}`, status, ...body } as unknown as ProposedChange
}

const passage = (status: Status = 'open') =>
  change(
    {
      op: 'body.replace',
      anchor: { kind: 'text', quote: { exact: 'x' }, start: 0, end: 1 },
      text: 'y',
      assumed: 'x',
    },
    status,
  )

const proposal = (id: string, changes: readonly ProposedChange[]): Proposal =>
  ({ id, changes }) as Proposal

const pointEnd = (x: number, y: number) => ({ kind: 'point', point: { x, y } }) as const
const nodeEnd = (node: string) => ({ kind: 'node', node }) as const

/** The proposals over `arms`'s boxes and edges, the edge `e1` the one with a label. */
function boxAndEdgeProposals(b: SpatialNode, e1: CanvasEdge): Proposal[] {
  return [
    proposal('p-add', [change({ op: 'node.add', node: box('new', 300, 500, 90, 50) })]),
    proposal('p-mixed', [
      change({ op: 'node.patch', nodeId: 'a', patch: { x: 10, width: 200 }, assumed: { x: 0 } }),
      change({ op: 'node.remove', nodeId: 'b', assumed: b }),
      passage(),
      change({ op: 'node.patch', nodeId: 'c', patch: { y: 320 }, assumed: { y: 0 } }, 'adopted'),
    ]),
    proposal('p-edge', [
      change({ op: 'edge.patch', edgeId: 'e1', patch: { label: 'x' }, assumed: { label: 'old' } }),
      change({ op: 'edge.remove', edgeId: 'e1', assumed: e1 }),
      change({ op: 'edge.patch', edgeId: 'e2', patch: { color: '3' }, assumed: {} }),
    ]),
    proposal('p-new-edges', [
      change({ op: 'edge.add', edge: link('ghost', 'a', 'gone') }),
      change({ op: 'edge.add', edge: link('fresh', 'c', 'd') }),
      change({ op: 'node.add', node: box('later', -300, 400, 80, 40) }),
    ]),
  ]
}

/** The proposals over ink, gone elements, decided and prose changes, and a throwing label. */
function otherProposals(k2: CanvasLine): Proposal[] {
  return [
    proposal('p-ink', [
      change({
        op: 'line.add',
        line: { id: 'k3', from: pointEnd(-100, 500), to: nodeEnd('d') },
      }),
      change({ op: 'line.add', line: { id: 'k4', from: nodeEnd('gone'), to: pointEnd(0, 0) } }),
      change({ op: 'line.add', line: { id: 'k5', from: nodeEnd('a'), to: nodeEnd('gone') } }),
      change({ op: 'line.patch', lineId: 'k1', patch: { label: 'ink' }, assumed: {} }),
      change({ op: 'line.remove', lineId: 'k2', assumed: k2 }),
    ]),
    proposal('p-gone', [
      change({ op: 'node.patch', nodeId: 'gone', patch: { x: 1 }, assumed: { x: 1 } }),
      change({ op: 'node.remove', nodeId: 'gone', assumed: box('gone', 0, 0) }),
      change({ op: 'edge.patch', edgeId: 'gone', patch: { label: 'x' }, assumed: {} }),
      change({ op: 'line.remove', lineId: 'gone', assumed: k2 }),
    ]),
    proposal('p-decided', [
      change({ op: 'node.add', node: box('no', 900, 0) }, 'adopted'),
      change({ op: 'node.add', node: box('nope', 900, 100) }, 'dismissed'),
    ]),
    proposal('p-prose', [passage(), passage('dismissed')]),
    proposal('p-throws', [
      change({ op: 'node.patch', nodeId: 'd', patch: { height: 90 }, assumed: { height: 60 } }),
      passage(),
      passage(),
      passage(),
      passage(),
    ]),
  ]
}

function arms(): ProposalBoard {
  const nodes = [
    box('a', 0, 0),
    box('b', 400, 0),
    box('c', 0, 300),
    { id: 'g', x: 600, y: 200, width: 300, height: 220, label: 'Group' } as SpatialNode,
    box('d', 650, 260, 120, 60),
  ]
  const edges = [
    link('e1', 'a', 'b', { label: 'flow' }),
    link('e2', 'a', 'c', { facets: { 'visual.edges/v0': { routing: 'curved' } } }),
  ]
  const lines: CanvasLine[] = [
    { id: 'k1', from: pointEnd(-200, 100), to: nodeEnd('c') },
    { id: 'k2', from: nodeEnd('b'), to: pointEnd(700, -150) },
  ]
  const proposals = [
    ...boxAndEdgeProposals(nodes[1] as SpatialNode, edges[0] as CanvasEdge),
    ...otherProposals(lines[1] as CanvasLine),
  ]
  return { name: 'proposals', canvas: { nodes, edges, lines }, threads: [], proposals }
}

/** Twelve proposals about one boxed-in node, so their bubbles take the ring. */
function crowd(): ProposalBoard {
  const nodes = [
    box('hub', 0, 0, 200, 100),
    box('north', 0, -160, 200, 100),
    box('east', 260, 0, 200, 100),
    box('south', 0, 160, 200, 100),
    box('west', -260, 0, 200, 100),
  ]
  const proposals = Array.from({ length: 12 }, (_, i) =>
    proposal(`crowd-${i}`, [
      change({
        op: 'node.patch',
        nodeId: 'hub',
        patch: { x: i * 3, color: '2' },
        assumed: i % 3 === 0 ? { x: 0 } : { x: 5, color: '1' },
      }),
      ...Array.from({ length: i % 4 }, () => passage()),
    ]),
  )
  return { name: 'proposals-crowd', canvas: { nodes, edges: [] }, threads: [], proposals }
}

/** A thread and a proposal on one node: the comment layer is drawn first. */
function mixed(): ProposalBoard {
  const thread: CommentThread = {
    id: 'mixed-t',
    anchor: { kind: 'spatial', nodeId: 'm', x: 0, y: 0 },
    status: 'open',
    messages: [{ id: 'mixed-t-m0', body: 'about m' }],
  } as CommentThread
  return {
    name: 'proposals-mixed',
    canvas: { nodes: [box('m', 0, 0)], edges: [] },
    threads: [thread],
    proposals: [
      proposal('mixed-p', [
        change({ op: 'node.patch', nodeId: 'm', patch: { y: 40 }, assumed: { y: 0 } }),
      ]),
    ],
  }
}

export function proposalBoards(): readonly ProposalBoard[] {
  serial = 0
  return [arms(), crowd(), mixed()]
}

/** Every label a bubble on these boards can carry, as the layer words it. */
export function proposalLabels(): readonly string[] {
  return Array.from({ length: 12 }, (_, i) => i + 1).flatMap((n) => {
    const changed = `${n} proposed change${n === 1 ? '' : 's'}`
    return [changed, ...Array.from({ length: n }, (_, c) => `${changed}, ${c + 1} needs a look`)]
  })
}
