import type {
  CanvasEdge,
  CommentThread,
  Proposal,
  ProposedChange,
  SpatialCanvas,
  SpatialNode,
} from '@kamiazya/whiteboard-model'
import { fileNode, textNode } from '@kamiazya/whiteboard-model/test-utils'

/**
 * Boards shaped like what the editor lays out — plain labels, CJK, a
 * Markdown body, a code fence, comments, proposals, file nodes, and one
 * board at an ordinary working size — for the browser tests that hold the
 * Rust core's whole layout to the TypeScript's under the browser measurer,
 * and for pricing what that measurer costs the core per layout.
 */
export interface WebLayoutBoard {
  readonly name: string
  readonly canvas: SpatialCanvas
  readonly threads?: readonly CommentThread[]
  readonly proposals?: readonly Proposal[]
}

const text = (id: string, x: number, y: number, body: string, width = 220, height = 120) =>
  textNode({ id, x, y, width, height, text: body })

const edge = (id: string, from: string, to: string, label?: string): CanvasEdge => ({
  id,
  from: { node: from },
  to: { node: to, end: 'arrow' },
  ...(label === undefined ? {} : { label }),
})

const canvas = (nodes: SpatialNode[], edges: CanvasEdge[] = []): SpatialCanvas =>
  ({ nodes, edges }) as SpatialCanvas

const MARKDOWN = [
  '# Release plan',
  '',
  'Ship the **layout core** behind a switch, then _measure_ it.',
  '',
  '- one request per layout',
  '- a memo per layout, keyed by text and font',
  '  - nested item with `inline code`',
  '1. ordered',
  '2. list',
  '',
  '> A quoted line that is long enough to wrap inside a node of this width.',
  '',
  '| column | value |',
  '| --- | --- |',
  '| alpha | 1 |',
  '| beta | 22 |',
  '',
  'See [the ADR](https://example.com/adr) for the reasoning.',
].join('\n')

const CODE = [
  'A fence the default highlighter colours:',
  '',
  '```ts',
  'export function add(a: number, b: number): number {',
  '  return a + b // the sum',
  '}',
  '```',
].join('\n')

const plain = (): WebLayoutBoard => ({
  name: 'plain labels',
  canvas: canvas(
    [
      text('a', 0, 0, 'Hello'),
      text('b', 320, 0, 'A label long enough to wrap onto a second line in this box'),
      text('c', 0, 240, 'Done'),
      { id: 'g', x: 300, y: 200, width: 400, height: 260, label: 'Group' } as SpatialNode,
      text('d', 340, 260, 'Inside the group', 160, 80),
    ],
    [edge('e1', 'a', 'b', 'next'), edge('e2', 'a', 'c'), edge('e3', 'b', 'd', 'contains')],
  ),
})

const cjk = (): WebLayoutBoard => ({
  name: 'CJK',
  canvas: canvas(
    [
      text('j1', 0, 0, '日本語のテキストは全角で折り返されます。句読点、括弧（例）も含みます。'),
      text('j2', 320, 0, '中文文本也会换行，混合 English words 一起。'),
      text('j3', 0, 240, '한국어 문장도 포함합니다.'),
    ],
    [edge('je', 'j1', 'j2', '次へ')],
  ),
})

const markdown = (): WebLayoutBoard => ({
  name: 'markdown body',
  canvas: canvas([text('m', 0, 0, MARKDOWN, 360, 420), text('n', 460, 0, '## Heading\n\nbody')]),
})

const code = (): WebLayoutBoard => ({
  name: 'code fence',
  canvas: canvas([text('c', 0, 0, CODE, 420, 200)]),
})

const thread = (id: string, nodeId: string, bodies: readonly string[]): CommentThread => ({
  id,
  anchor: { kind: 'spatial', x: 4, y: 4, nodeId },
  status: 'open',
  messages: bodies.map((body, i) => ({ id: `${id}-m${i}`, body })),
})

const comments = (): WebLayoutBoard => ({
  name: 'comments',
  canvas: plain().canvas,
  threads: [
    thread('t1', 'a', ['on **Hello**, with `code`']),
    thread('t2', 'b', ['first of three', 'second', 'third']),
  ],
})

let serial = 0
const change = (body: object): ProposedChange => {
  serial += 1
  return { id: `ch${serial}`, status: 'open', ...body } as unknown as ProposedChange
}

const proposals = (): WebLayoutBoard => ({
  name: 'proposals',
  canvas: plain().canvas,
  proposals: [
    { id: 'p1', changes: [change({ op: 'node.add', node: text('new', 0, 520, 'Proposed') })] },
    {
      id: 'p2',
      changes: [
        change({ op: 'node.patch', nodeId: 'a', patch: { width: 260 }, assumed: { width: 220 } }),
        change({ op: 'edge.add', edge: edge('fresh', 'c', 'd') }),
      ],
    },
  ] as Proposal[],
})

const files = (): WebLayoutBoard => ({
  name: 'file nodes',
  canvas: canvas(
    [
      fileNode({ id: 'f1', x: 0, y: 0, width: 240, height: 160, file: 'notes/plan.md' }),
      fileNode({ id: 'f2', x: 320, y: 0, width: 240, height: 160, file: 'boards/arch.canvas' }),
      text('t', 0, 240, 'Points at [[notes/plan]]'),
    ],
    [edge('fe', 'f1', 'f2')],
  ),
})

/** A 6×5 grid of short Markdown notes, wired to their right and lower neighbours. */
const working = (): WebLayoutBoard => {
  const nodes: SpatialNode[] = []
  const edges: CanvasEdge[] = []
  for (let row = 0; row < 5; row += 1) {
    for (let col = 0; col < 6; col += 1) {
      const id = `w${row}-${col}`
      const body = `**Step ${row * 6 + col + 1}**\n\nCheck the *${col % 2 === 0 ? 'input' : 'output'}* of stage ${row} before moving on.`
      nodes.push(text(id, col * 300, row * 220, body, 220, 140))
      if (col > 0) edges.push(edge(`h${row}-${col}`, `w${row}-${col - 1}`, id))
      if (row > 0) edges.push(edge(`v${row}-${col}`, `w${row - 1}-${col}`, id, 'then'))
    }
  }
  return { name: 'working board (30 notes)', canvas: canvas(nodes, edges) }
}

export const webLayoutBoards = (): readonly WebLayoutBoard[] => [
  plain(),
  cjk(),
  markdown(),
  code(),
  comments(),
  proposals(),
  files(),
  working(),
]
