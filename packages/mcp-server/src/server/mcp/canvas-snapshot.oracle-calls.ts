/**
 * The calls `canvas-snapshot.oracle.test.ts` records, by what each one is
 * about: the boards the tool reads, the refusals it owns, the arguments the
 * SDK refuses, and the calls the Rust core leaves pending, last: a layout
 * pass, which needs a measurer and a code tokeniser no port carries yet, and
 * facets whose key order only npm loro's hash map knows.
 */

type Message = Record<string, unknown>

const W = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
const SEGMENT = 'notes'
const NOTHING = '01BX5ZZKBKACTAV9WEVGEMMVRZ'

type Ids = Record<string, string>
type Asked = [string, Message | undefined]

/** The documents the record holds, created in one batch. */
export const DOCUMENTS: Message[] = [
  { op: 'document.create', path: 'note', kind: 'markdown', markdown: '---\ntype: note\n---\nb\n' },
  { op: 'document.create', path: 'board', kind: 'spatial' },
  { op: 'document.create', path: 'empty', kind: 'spatial' },
  { op: 'document.create', path: 'crowded', kind: 'spatial' },
  { op: 'document.create', path: 'elderly', kind: 'spatial' },
  { op: 'document.create', path: 'wide', kind: 'spatial' },
  { op: 'document.create', path: 'wide-ink', kind: 'spatial' },
]

/** Exactly as many UTF-16 units as the snapshot keeps of a text. */
const AT_THE_CUT = 'k'.repeat(400)

/**
 * Past the cut in UTF-16 units and short of it in code points: 150 astral
 * characters are 300 units, so the cut falls 100 units into the tail.
 */
const ASTRAL = `${'\u{1F600}'.repeat(150)}${'a'.repeat(150)}`

/** Every kind of node, dressed and not, and edges and lines in every shape. */
export const BOARD_OPS: Message[] = [
  {
    op: 'node.add',
    node: {
      id: 'pad',
      type: 'text',
      text: 'Launch pad',
      x: 0.1,
      y: -12.5,
      width: 240.25,
      height: 60,
      color: '1',
      facets: { 'other.note/v1': { z: [0.30000000000000004, true, null, -0] } },
    },
  },
  {
    op: 'node.add',
    node: { id: 'long', type: 'text', text: `${'word '.repeat(90)}end`, x: 300, y: 0 },
  },
  { op: 'node.add', node: { id: 'exact', type: 'text', text: AT_THE_CUT, x: 600, y: 0 } },
  { op: 'node.add', node: { id: 'astral', type: 'text', text: ASTRAL, x: 900, y: 0 } },
  { op: 'node.add', node: { id: 'blank', type: 'text', text: '', x: 1200, y: 0 } },
  {
    op: 'node.add',
    node: { id: 'zone', type: 'group', label: 'Zone', background: 'bg.png', x: -400, y: -400 },
  },
  { op: 'node.add', node: { id: 'bare', type: 'group', x: -800, y: 1e21, width: 1e-7 } },
  {
    op: 'node.add',
    node: {
      id: 'doc',
      type: 'file',
      file: 'notes/a.md',
      subpath: '#Top',
      x: 0,
      y: 300,
      color: '#ff0000',
    },
  },
  {
    op: 'node.add',
    node: { id: 'site', type: 'link', url: 'https://example.com/a?b=1', x: 300, y: 300 },
  },
  {
    op: 'edge.add',
    edge: {
      id: 'fuels',
      from: { node: 'pad', side: 'right', end: 'none' },
      to: { node: 'site', end: 'arrow' },
      label: 'fuels',
      color: '2',
      bends: [
        { x: 1.5, y: 2 },
        { x: -0, y: 7.000000000000001 },
      ],
      facets: { 'other.wire/v0': { b: { a: 1 } } },
    },
  },
  {
    op: 'edge.add',
    edge: { id: 'plain', from: { node: 'zone', side: 'top' }, to: { node: 'bare' } },
  },
  {
    op: 'line.add',
    line: {
      id: 'ink',
      from: { kind: 'point', point: { x: -1, y: 0.5 } },
      to: { kind: 'node', node: 'pad', side: 'left', end: 'arrow' },
      label: 'look',
      color: '#00ff00',
      bends: [{ x: 3, y: 4 }],
      facets: { 'other.ink/v0': { w: 1 } },
    },
  },
  {
    op: 'line.add',
    line: {
      id: 'stroke',
      from: { kind: 'point', point: { x: 0, y: 0 } },
      to: { kind: 'point', point: { x: 10, y: 10 } },
    },
  },
]

/**
 * Facets whose keys reach the TypeScript in the order of npm loro's hash map:
 * a payload object of two keys on a node, and a bucket of two facets on a
 * line.
 */
export const WIDE_OPS: Record<string, Message[]> = {
  wide: [
    {
      op: 'node.add',
      node: {
        id: 'w',
        type: 'text',
        text: 'W',
        x: 0,
        y: 0,
        facets: { 'other.note/v1': { b: 1, a: 2 } },
      },
    },
  ],
  'wide-ink': [
    {
      op: 'line.add',
      line: {
        id: 'l',
        from: { kind: 'point', point: { x: 0, y: 0 } },
        to: { kind: 'point', point: { x: 1, y: 1 } },
        facets: { 'other.b/v0': 1, 'other.a/v0': 2 },
      },
    },
  ],
}

/** The tags the board's elements carry, written through `wb_facet_set`. */
export const BOARD_TAGS: Message[] = [
  { nodeId: 'pad', tags: { add: ['health:ok', 'plain'] } },
  { edgeId: 'plain', tags: { add: ['wire'] } },
  { nodeId: 'zone', tags: { add: ['gone'] } },
  { nodeId: 'zone', tags: { remove: ['gone'] } },
]

export const BOARD_LOCKS: Message[] = [
  { op: 'node.lock', id: 'pad', locked: true },
  { op: 'node.lock', id: 'zone', locked: true },
  { op: 'edge.lock', id: 'fuels', locked: true },
]

/** One past each cap: 301 nodes, 601 edges and 601 lines, in batches the edit tool takes. */
export function crowdedBatches(): Message[][] {
  const ops: Message[] = []
  for (let at = 0; at <= 300; at += 1) {
    ops.push({
      op: 'node.add',
      node: { id: `n${at}`, type: 'text', text: `${at}`, x: at * 10, y: 0 },
    })
  }
  for (let at = 0; at <= 600; at += 1) {
    ops.push({
      op: 'edge.add',
      edge: { id: `e${at}`, from: { node: `n${at % 301}` }, to: { node: `n${(at + 1) % 301}` } },
    })
  }
  for (let at = 0; at <= 600; at += 1) {
    ops.push({
      op: 'line.add',
      line: {
        id: `l${at}`,
        from: { kind: 'point', point: { x: at, y: 0 } },
        to: { kind: 'point', point: { x: at, y: 1 } },
      },
    })
  }
  const batches: Message[][] = []
  for (let at = 0; at < ops.length; at += 200) batches.push(ops.slice(at, at + 200))
  return batches
}

/** Reads the tool answers. */
function reads(ids: Ids): Asked[] {
  const of = (path: string, more: Message = {}): Message => ({
    workspaceId: W,
    documentId: ids[path],
    ...more,
  })
  return [
    ['the board', of('board')],
    ['the board with its layout declined', of('board', { layout: false })],
    ['the board by the workspace segment', { ...of('board'), workspaceId: SEGMENT }],
    ['an empty board', of('empty')],
    ['a board past every cap', of('crowded')],
  ]
}

/** Refusals the tool owns, with and without a layout asked for. */
function refusals(ids: Ids): Asked[] {
  const of = (path: string, more: Message = {}): Message => ({
    workspaceId: W,
    documentId: ids[path],
    ...more,
  })
  return [
    ['a note', of('note')],
    ['a note asked for its layout', of('note', { layout: true })],
    ['a document the workspace does not hold', { workspaceId: W, documentId: NOTHING }],
    [
      'a document the workspace does not hold, its layout asked for',
      { workspaceId: W, documentId: NOTHING, layout: true },
    ],
    ['an unknown workspace', { workspaceId: 'nowhere', documentId: ids.board }],
    [
      'an unknown workspace, a layout asked for',
      { workspaceId: 'nowhere', documentId: ids.board, layout: true },
    ],
    ['a board in a retired shape', of('elderly')],
    ['a board in a retired shape, its layout asked for', of('elderly', { layout: true })],
  ]
}

/** Arguments the SDK refuses before the tool runs. */
function malformed(ids: Ids): Asked[] {
  return [
    ['no arguments', undefined],
    ['no document', { workspaceId: W }],
    ['a document id that is not a ULID', { workspaceId: W, documentId: 'board' }],
    ['a layout that is not a flag', { workspaceId: W, documentId: ids.board, layout: 'yes' }],
    ['an unknown key', { workspaceId: W, documentId: ids.board, extra: 1 }],
    ['a workspace address of three parts', { workspaceId: 'a/b/c', documentId: ids.board }],
    ['a workspace that is not text', { workspaceId: 7, documentId: ids.board }],
  ]
}

/**
 * What the Rust core leaves pending: a layout pass over a board it holds, and
 * facets whose order only npm loro's hash map knows.
 */
function pending(ids: Ids): Asked[] {
  const of = (path: string, more: Message = {}): Message => ({
    workspaceId: W,
    documentId: ids[path],
    ...more,
  })
  return [
    ['the board laid out', of('board', { layout: true })],
    ['an empty board laid out', of('empty', { layout: true })],
    ['a board past every cap laid out', of('crowded', { layout: true })],
    ['a facet payload of two keys', of('wide')],
    ['a facet bucket of two facets on a line', of('wide-ink')],
  ]
}

export function calls(ids: Ids): Asked[] {
  return [...reads(ids), ...refusals(ids), ...malformed(ids), ...pending(ids)]
}
