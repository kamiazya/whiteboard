import type {
  CanvasEdge,
  CommentThread,
  SpatialCanvas,
  SpatialNode,
} from '@kamiazya/whiteboard-model'

/**
 * The inputs of the compose-comments recording: canvases carrying comment
 * threads, laid out whole by `layoutSpatialCanvasWithAnchors`. Each board
 * reaches every arm a thread projects through (a node, an edge, a point, a
 * node set live, partly live and orphaned, a region, a passage of a node, and
 * the arms with no pin), and the placements a crowd forces onto the ring.
 * Nothing is random. Only the `passages` board quotes text its nodes hold, so
 * only there does the walk draw highlights behind the bodies.
 */

export interface Board {
  readonly name: string
  readonly canvas: SpatialCanvas
  readonly threads: readonly CommentThread[]
}

/** The base appearance: the bundled theme in either mode, or one with no comment chrome. */
type Appearance = 'light' | 'dark' | 'bare'

export interface CaseSpec {
  readonly board: string
  readonly appearance: Appearance
  readonly style?: string
  readonly showResolved?: boolean
  /** What a bubble must keep clear of besides the canvas's own boxes. */
  readonly obstacles?: readonly (readonly [number, number, number, number])[]
}

const text = (id: string, x: number, y: number, body = id, width = 160, height = 80) =>
  ({
    id,
    x,
    y,
    width,
    height,
    resource: { mimeType: 'text/markdown', content: body },
  }) as SpatialNode

const frame = (id: string, x: number, y: number, w: number, h: number, label: string) =>
  ({ id, x, y, width: w, height: h, label }) as SpatialNode

const edge = (id: string, from: string, to: string, extra: Partial<CanvasEdge> = {}) =>
  ({ id, from: { node: from }, to: { node: to, end: 'arrow' }, ...extra }) as CanvasEdge

type Anchor = CommentThread['anchor']

const thread = (
  id: string,
  anchor: Anchor,
  bodies: readonly string[] = [`about ${id}`],
  status: 'open' | 'resolved' = 'open',
): CommentThread => ({
  id,
  anchor,
  status,
  messages: bodies.map((body, i) => ({ id: `${id}-m${i}`, body })),
})

const at = (x: number, y: number, refs: Partial<Extract<Anchor, { kind: 'spatial' }>> = {}) =>
  ({ kind: 'spatial', x, y, ...refs }) as Anchor

const passage = (nodeId?: string): Anchor =>
  ({
    kind: 'text',
    ...(nodeId === undefined ? {} : { nodeId }),
    quote: { exact: 'words nobody wrote' },
    start: 0,
    end: 18,
  }) as Anchor

/**
 * Every arm a thread projects through, on a board with a labelled edge, a
 * frame and a box inside it, so labels and boxes are obstacles a frame is not.
 */
function arms(): Board {
  const nodes = [
    text('n1', 0, 0, 'alpha'),
    text('n2', 400, 0, 'beta'),
    text('n3', 0, 300, 'gamma'),
    frame('group', 600, 200, 300, 220, 'Group'),
    text('n4', 650, 260, 'delta', 120, 60),
  ]
  const edges = [edge('e1', 'n1', 'n2', { label: 'flow' }), edge('e2', 'n1', 'n3')]
  const threads = [
    thread('t-node', at(1, 1, { nodeId: 'n1' }), ['on **alpha**, with `code`']),
    thread('t-many', at(0, 0, { nodeId: 'n2' }), ['first of three', 'second', 'third']),
    thread('t-edge', at(280, 60, { edgeId: 'e1' }), ['rides the edge']),
    thread('t-edge-gone', at(50, 520, { edgeId: 'gone' })),
    thread('t-node-gone', at(-120, -90, { nodeId: 'gone' })),
    thread('t-point', at(300, 420), [
      'a longer remark that has to wrap onto a second line inside the bubble',
    ]),
    thread('t-set', at(0, 0, { nodeIds: ['n1', 'n3'] }), ['- one\n- two']),
    thread('t-set-part', at(0, 0, { nodeIds: ['n2', 'gone'], width: 10, height: 10 })),
    thread('t-set-orphan', at(980, 600, { nodeIds: ['gone', 'gone-2'], width: 100, height: 50 })),
    thread('t-region', { kind: 'spatial', x: 700, y: 480, width: 120, height: 80 } as Anchor),
    thread('t-settled', at(0, 0, { nodeId: 'n3' }), ['settled once', 'and again'], 'resolved'),
    thread(
      't-settled-region',
      { kind: 'spatial', x: -200, y: 200, width: 90, height: 60 } as Anchor,
      ['an old region'],
      'resolved',
    ),
    thread('t-passage', passage('n4')),
    thread('t-note', passage()),
    thread('t-passage-gone', passage('gone')),
    thread('t-doc', { kind: 'document' } as Anchor),
    thread('t-title', at(590, 170), ['beside a frame title']),
  ]
  return { name: 'arms', canvas: { nodes, edges }, threads }
}

/**
 * Many comments on one boxed-in node, so the quadrants fill and the ring is
 * reached, beside crossing edges drawn with hops and a curved one, each carrying
 * a comment pinned onto its drawn line.
 */
function crowded(): Board {
  const ring = [
    text('hub', 0, 0, 'hub', 200, 100),
    text('north', 0, -160, 'north', 200, 100),
    text('east', 260, 0, 'east', 200, 100),
    text('south', 0, 160, 'south', 200, 100),
    text('west', -260, 0, 'west', 200, 100),
  ]
  const crossing = [
    text('a', 700, -200, 'a', 100, 60),
    text('b', 1100, -200, 'b', 100, 60),
    text('c', 700, 200, 'c', 100, 60),
    text('d', 1100, 200, 'd', 100, 60),
  ]
  const edges = [
    edge('ad', 'a', 'd'),
    edge('bc', 'b', 'c'),
    edge('ab', 'a', 'b', { facets: { 'visual.edges/v0': { routing: 'curved' } } }),
  ]
  const many = Array.from({ length: 12 }, (_, i) =>
    thread(`hub-${i}`, at(0, 0, { nodeId: 'hub' }), [`note ${i}`]),
  )
  const threads = [
    ...many,
    thread('on-ad', at(900, 0, { edgeId: 'ad' }), ['near the hop']),
    thread('on-ab', at(900, -260, { edgeId: 'ab' }), ['on the curve']),
    thread('past-end', at(1300, 400, { edgeId: 'ad' }), ['past the end']),
  ]
  return {
    name: 'crowded',
    canvas: {
      facets: { 'visual.edges/v0': { routing: 'orthogonal', lineJumps: 'arc' } },
      nodes: [...ring, ...crossing],
      edges,
    },
    threads,
  }
}

/** A board that names a theme, so the comment chrome is the themed appearance's. */
function themed(): Board {
  return {
    name: 'themed',
    canvas: {
      facets: { 'visual.theme/v0': { theme: 'visual.sketch' } },
      nodes: [text('only', 0, 0, 'only')],
      edges: [],
    },
    threads: [
      thread('open', at(0, 0, { nodeId: 'only' }), ['open', 'reply']),
      thread('closed', at(-60, 200), ['closed', 'reply'], 'resolved'),
      thread('area', { kind: 'spatial', x: 200, y: 150, width: 60, height: 40 } as Anchor),
    ],
  }
}

/**
 * A link too short for its label, so the label is a run hanging below its box
 * with no `annotates`: words inside a box are no obstacle of their own, the box
 * is. A point comment sits off the box's left end, so its first candidate lies
 * over the label and nothing else.
 */
function inside(): Board {
  const link = {
    id: 'link',
    x: 0,
    y: 0,
    width: 300,
    height: 4,
    resource: { mimeType: 'text/uri-list', location: 'https://example.com/a' },
  } as SpatialNode
  return {
    name: 'inside',
    canvas: { nodes: [link], edges: [] },
    threads: [thread('corner', at(-14, -6), ['x'])],
  }
}

const quoting = (
  nodeId: string,
  exact: string,
  start: number,
  context: { prefix?: string; suffix?: string } = {},
): Anchor =>
  ({
    kind: 'text',
    nodeId,
    quote: { exact, ...context },
    start,
    end: start + exact.length,
  }) as Anchor

/**
 * Passages of text nodes that the walk highlights: a repeated quote told apart
 * by its context, one across a wrap, one in emphasis, one in a centred
 * node, a settled one, one the text no longer holds and one on a node that is
 * gone.
 */
function passages(): Board {
  const plan = 'the plan is the plan, and **the plan** holds when the plan is kept'
  const diagram = 'see *a diagram* here'
  const nodes = [
    text('p1', 0, 0, plan, 160, 120),
    text('p2', 300, 0, diagram, 200, 80),
    {
      ...text('p3', 0, 260, 'centred words here', 200, 120),
      facets: { 'visual.shape/v0': { kind: 'ellipse' } },
    } as SpatialNode,
  ]
  const threads = [
    thread('q-repeat', quoting('p1', 'the plan', 12, { prefix: 'is ' })),
    thread('q-moved', quoting('p1', 'the plan', 3, { suffix: ' holds' })),
    thread('q-wrap', quoting('p1', 'plan, and', 16)),
    thread('q-bold', quoting('p2', 'a diagram', 5)),
    thread('q-settled', quoting('p2', 'see', 0), ['settled'], 'resolved'),
    thread('q-centred', quoting('p3', 'words', 8)),
    thread('q-missing', quoting('p1', 'nowhere', 0)),
    thread('q-gone', quoting('gone', 'the plan', 0)),
  ]
  return { name: 'passages', canvas: { nodes, edges: [] }, threads }
}

/** The text the recording's body parser throws on. */
export const THROWING_BODY = '<<throw>>'

/**
 * Settled threads whose bodies open with every block a first line is cut from
 * (a wrapped paragraph, a heading, a list, a quote, a fence, a table, a rule,
 * nothing at all, a body that will not parse), beside open ones holding the
 * same shapes whole. Spread far apart, so each bubble lands down-right of its
 * pin and the layer's only variable is the body.
 */
function settled(): Board {
  const bodies: readonly (readonly [string, string])[] = [
    ['para', 'a settled remark *long enough* that it **wraps** onto a second line and a third'],
    ['heading', '## Decided\n\nwith a reason under it'],
    ['list', '- one\n- two\n  - nested\n- three'],
    ['quote', '> quoted words that run on past the width of one bubble line\n> and more'],
    ['code', '```\nfirst line\nsecond line\n```'],
    ['table', '| a | b |\n| --- | --- |\n| 1 | 2 |'],
    ['rule', '***\n\nafter the rule'],
    ['empty', ''],
    ['broken', THROWING_BODY],
  ]
  const threads = bodies.flatMap(([name, body], i) => [
    thread(`s-${name}`, at(i * 400, 0), [body, 'reply'], 'resolved'),
    thread(`o-${name}`, at(i * 400, 600), [body]),
  ])
  return { name: 'settled', canvas: { nodes: [], edges: [] }, threads }
}

export const boards = (): readonly Board[] => [
  arms(),
  crowded(),
  themed(),
  inside(),
  settled(),
  passages(),
]

export const caseSpecs = (): readonly CaseSpec[] => [
  { board: 'arms', appearance: 'light' },
  { board: 'arms', appearance: 'dark', showResolved: true },
  { board: 'arms', appearance: 'bare', showResolved: true },
  {
    board: 'arms',
    appearance: 'light',
    obstacles: [
      [170, -40, 300, 300],
      [-400, -400, 380, 900],
    ],
  },
  { board: 'crowded', appearance: 'light' },
  { board: 'crowded', appearance: 'dark', obstacles: [[-600, -600, 1200, 1200]] },
  { board: 'themed', appearance: 'light', style: 'document', showResolved: true },
  { board: 'themed', appearance: 'dark', style: 'document' },
  { board: 'themed', appearance: 'bare' },
  { board: 'inside', appearance: 'light' },
  { board: 'settled', appearance: 'light', showResolved: true },
  { board: 'settled', appearance: 'dark', style: 'visual.sketch', showResolved: true },
  { board: 'settled', appearance: 'bare', showResolved: true },
  { board: 'passages', appearance: 'light' },
  { board: 'passages', appearance: 'dark', showResolved: true },
  { board: 'passages', appearance: 'bare', showResolved: true },
]
