import type {
  CanvasEdge,
  CanvasLine,
  NodePatchFields,
  SpatialCanvas,
  SpatialNode,
  SpatialProposedChange,
} from '@kamiazya/whiteboard-model'
import { canvasChangeConflicts, nodePatchField } from '@kamiazya/whiteboard-model'
import { hex } from '../compose-canvas-oracle/oracle.js'
import { type CanvasWire, canvasWire } from '../compose-canvas-oracle/wire.js'
import { type ChangeWire, changeWire } from './wire.js'

/**
 * The recorded answers of `canvasChangeConflicts` (model's
 * `proposal-apply.ts`, ADR-0029 decision 5): every canvas arm against a board
 * that holds each node kind, edges and ink, with priors that agree, disagree
 * and say nothing, field by field. Every change is a fresh parse of its JSON,
 * as a proposal read from the record is, so no prior shares an object with
 * the board and an end, a bend list or a facet bucket agrees only by value.
 * `structuredClone` rather than a JSON round trip, which would turn a `-0`
 * the board holds into `0`.
 */

interface BoardRecord {
  readonly kind: 'board'
  readonly name: string
  readonly canvas: CanvasWire
}

interface CaseRecord {
  readonly kind: 'case'
  readonly board: string
  readonly change: ChangeWire
  readonly conflicts: boolean
}

export type ProposalConflictsRecord = BoardRecord | CaseRecord

const resource = (mimeType: string, fields: Record<string, string>) => ({ mimeType, ...fields })

const NODES: readonly SpatialNode[] = [
  {
    id: 'text',
    x: 0,
    y: 0,
    width: 120,
    height: 60,
    color: '1',
    tags: ['a', 'b'],
    facets: { 'visual.shape/v0': { kind: 'ellipse' }, 'x.y/v0': { '2': 1, b: [1, 2] } },
    resource: resource('text/markdown', { content: 'hello' }),
  },
  {
    id: 'file',
    x: 200,
    y: 0,
    width: 160,
    height: 90,
    embed: { documentId: '01HZZZZZZZZZZZZZZZZZZZZZZZ', versionRef: 'v1' },
    resource: resource('text/markdown', { location: 'notes/a', subpath: '#h' }),
  },
  {
    id: 'link',
    x: 0,
    y: 200,
    width: 100,
    height: 40,
    color: '#112233',
    resource: resource('text/uri-list', { location: 'https://example.com/' }),
  },
  {
    id: 'frame',
    x: -40,
    y: -40,
    width: 500,
    height: 400,
    label: 'Group',
    background: 'asset:bg',
    backgroundStyle: 'cover',
  },
  { id: 'bare', x: 600, y: 0, width: 80, height: 80 },
  {
    id: 'unclaimed',
    x: 600,
    y: 200,
    width: 50,
    height: 50,
    resource: resource('image/png', {}),
  },
  { id: 'zero', x: -0, y: 0.5, width: 10.25, height: 0 },
]

const EDGES: readonly CanvasEdge[] = [
  {
    id: 'rich',
    from: { node: 'text', side: 'right', end: 'none' },
    to: { node: 'file', side: 'left', end: 'arrow' },
    color: '#445566',
    label: 'calls',
    bends: [
      { x: 150, y: 10 },
      { x: 150, y: 40 },
    ],
    facets: { 'visual.edges/v0': { style: 'curved' } },
    tags: ['flow'],
  },
  { id: 'plain', from: { node: 'link' }, to: { node: 'bare' } },
]

const LINES: readonly CanvasLine[] = [
  {
    id: 'ink',
    from: { kind: 'point', point: { x: 1, y: 2 } },
    to: { kind: 'node', node: 'text', side: 'top', end: 'arrow' },
    color: '3',
    label: 'note',
    bends: [{ x: 5, y: 6 }],
    facets: { 'visual.stroke/v0': { width: 2 } },
  },
  {
    id: 'stroke',
    from: { kind: 'node', node: 'bare' },
    to: { kind: 'point', point: { x: -3, y: 4 } },
  },
]

const BOARDS: readonly { readonly name: string; readonly canvas: SpatialCanvas }[] = [
  { name: 'full', canvas: { nodes: [...NODES], edges: [...EDGES], lines: [...LINES] } },
  { name: 'inkless', canvas: { nodes: [...NODES], edges: [...EDGES] } },
  { name: 'empty', canvas: { nodes: [], edges: [] } },
]

type NodeKey = keyof NodePatchFields

/** A value each patch key may take that no node on the board holds there. */
const OTHER: { readonly [K in NodeKey]-?: NodePatchFields[K] } = {
  x: 7,
  y: -0,
  width: 33,
  height: 44,
  color: '6',
  text: 'other',
  file: 'notes/b',
  subpath: '#z',
  url: 'https://other.example/',
  label: 'Other',
  background: 'asset:other',
  backgroundStyle: 'repeat',
}

const NODE_KEYS = Object.keys(OTHER) as NodeKey[]

let serial = 0
const nextId = (): string => {
  serial += 1
  return `c${serial}`
}

const open = <T extends object>(change: T) =>
  structuredClone({ id: nextId(), status: 'open', ...change }) as unknown as SpatialProposedChange

/** One patch key against one node: the prior agreeing, absent, and wrong. */
function nodePatches(node: SpatialNode): SpatialProposedChange[] {
  return NODE_KEYS.flatMap((key) => {
    const held = nodePatchField(node, key)
    const patch = { [key]: OTHER[key] }
    const priors = [{}, { [key]: OTHER[key] }, ...(held === undefined ? [] : [{ [key]: held }])]
    if (key === 'x' && Object.is(held, -0)) priors.push({ x: 0 })
    if (key === 'y' && held === 0) priors.push({ y: -0 })
    return priors.map((assumed) => open({ op: 'node.patch', nodeId: node.id, patch, assumed }))
  })
}

/** Two keys at once, one prior right and the other wrong, in both orders. */
function nodePatchPairs(node: SpatialNode): SpatialProposedChange[] {
  const right = { x: node.x, color: node.color }
  return [
    open({ op: 'node.patch', nodeId: node.id, patch: { x: 1, color: '2' }, assumed: right }),
    open({ op: 'node.patch', nodeId: node.id, patch: { x: 1, color: '2' }, assumed: { x: 1 } }),
    open({
      op: 'node.patch',
      nodeId: node.id,
      patch: { width: 1, height: 2 },
      assumed: { width: node.width, height: node.height + 1 },
    }),
  ]
}

const REQUIRED = new Set(['id', 'x', 'y', 'width', 'height', 'from', 'to'])

/** Every way a removal's whole-element prior can differ from what is there. */
function variantsOf<T extends object>(element: T, changes: readonly Partial<T>[]): T[] {
  const optional = Object.keys(element).filter((key) => !REQUIRED.has(key))
  const drop = optional.map((key) => {
    const { [key as keyof T]: _gone, ...rest } = element
    return rest as T
  })
  return [element, ...changes.map((change) => ({ ...element, ...change })), ...drop]
}

const NODE_VARIANTS: readonly Partial<SpatialNode>[] = [
  { x: 1 },
  { y: 1 },
  { width: 1 },
  { height: 1 },
  { color: '6' },
  { tags: ['a'] },
  { tags: ['b', 'a'] },
  { facets: { 'visual.shape/v0': { kind: 'ellipse' } } },
  { embed: { documentId: '01HZZZZZZZZZZZZZZZZZZZZZZZ' } },
  { label: 'x' },
  { background: 'asset:x' },
  { backgroundStyle: 'ratio' },
  { resource: resource('text/markdown', { content: 'hello!' }) },
  { resource: resource('text/plain', { content: 'hello' }) },
  { resource: resource('text/markdown', { location: 'notes/a' }) },
  { resource: resource('text/markdown', { location: 'notes/a', subpath: '#i' }) },
]

const ELEMENT_VARIANTS: readonly Partial<CanvasEdge & CanvasLine>[] = [
  { color: '6' },
  { label: 'other' },
  { bends: [{ x: 1, y: 1 }] },
  { facets: { 'visual.edges/v0': { style: 'straight' } } },
  { tags: ['other'] },
]

const EDGE_ENDS: readonly Partial<CanvasEdge>[] = [
  { from: { node: 'bare' } },
  { to: { node: 'text', side: 'left', end: 'arrow' } },
  { to: { node: 'file', side: 'top', end: 'arrow' } },
]

const LINE_ENDS: readonly Partial<CanvasLine>[] = [
  { from: { kind: 'point', point: { x: 1, y: 3 } } },
  { from: { kind: 'node', node: 'text' } },
  { to: { kind: 'node', node: 'text', side: 'top' } },
  { to: { kind: 'point', point: { x: -3, y: 4 }, end: 'arrow' } },
]

type ElementField = 'from' | 'to' | 'color' | 'label' | 'bends' | 'facets'
const ELEMENT_FIELDS: readonly ElementField[] = ['from', 'to', 'color', 'label', 'bends', 'facets']

/** One element patch key: the prior a copy of what is there, absent, and other. */
function elementPatches<T extends CanvasEdge | CanvasLine>(
  op: 'edge.patch' | 'line.patch',
  element: T,
  other: Partial<T>,
): SpatialProposedChange[] {
  const idKey = op === 'edge.patch' ? 'edgeId' : 'lineId'
  return ELEMENT_FIELDS.flatMap((field) => {
    const set = other[field] ?? (EDGES[0] as CanvasEdge)[field]
    const held = element[field as keyof T]
    const patch = { [field]: set }
    const priors = [{}, { [field]: set }, ...(held === undefined ? [] : [{ [field]: held }])]
    return priors.map((assumed) => open({ op, [idKey]: element.id, patch, assumed }))
  })
}

function nodeChanges(): SpatialProposedChange[] {
  return [
    ...NODES.map((node) => open({ op: 'node.add', node })),
    open({ op: 'node.add', node: { ...(NODES[0] as SpatialNode), id: 'new' } }),
    ...NODES.flatMap(nodePatches),
    ...NODES.flatMap(nodePatchPairs),
    open({ op: 'node.patch', nodeId: 'gone', patch: { x: 1 }, assumed: { x: 1 } }),
    ...NODES.flatMap((node) =>
      variantsOf(node, NODE_VARIANTS).map((assumed) =>
        open({ op: 'node.remove', nodeId: node.id, assumed }),
      ),
    ),
    open({ op: 'node.remove', nodeId: 'gone', assumed: { ...(NODES[4] as SpatialNode) } }),
  ]
}

function edgeChanges(): SpatialProposedChange[] {
  const other: Partial<CanvasEdge> = {
    ...EDGE_ENDS[0],
    ...EDGE_ENDS[1],
    color: '2',
    label: 'l',
    bends: [],
  }
  return [
    ...EDGES.map((edge) => open({ op: 'edge.add', edge })),
    open({ op: 'edge.add', edge: { ...(EDGES[1] as CanvasEdge), id: 'fresh' } }),
    ...EDGES.flatMap((edge) => elementPatches('edge.patch', edge, other)),
    open({ op: 'edge.patch', edgeId: 'gone', patch: { label: 'x' }, assumed: {} }),
    ...EDGES.flatMap((edge) =>
      variantsOf(edge, [...ELEMENT_VARIANTS, ...EDGE_ENDS]).map((assumed) =>
        open({ op: 'edge.remove', edgeId: edge.id, assumed }),
      ),
    ),
    open({ op: 'edge.remove', edgeId: 'gone', assumed: { ...(EDGES[1] as CanvasEdge) } }),
  ]
}

function lineChanges(): SpatialProposedChange[] {
  const lineVariants = ELEMENT_VARIANTS.filter((v) => v.tags === undefined)
  const other: Partial<CanvasLine> = {
    ...LINE_ENDS[0],
    ...LINE_ENDS[3],
    color: '2',
    label: 'l',
    bends: [],
  }
  return [
    ...LINES.map((line) => open({ op: 'line.add', line })),
    open({ op: 'line.add', line: { ...(LINES[1] as CanvasLine), id: 'fresh' } }),
    ...LINES.flatMap((line) => elementPatches('line.patch', line, other)),
    open({ op: 'line.patch', lineId: 'gone', patch: { label: 'x' }, assumed: {} }),
    ...LINES.flatMap((line) =>
      variantsOf(line, [...lineVariants, ...LINE_ENDS]).map((assumed) =>
        open({ op: 'line.remove', lineId: line.id, assumed }),
      ),
    ),
    open({ op: 'line.remove', lineId: 'gone', assumed: { ...(LINES[1] as CanvasLine) } }),
  ]
}

/** Every record, in file order: each board, then each change against each board. */
export function proposalConflictsRecords(): readonly ProposalConflictsRecord[] {
  serial = 0
  const changes = [...nodeChanges(), ...edgeChanges(), ...lineChanges()]
  const boards: ProposalConflictsRecord[] = BOARDS.map(({ name, canvas }) => ({
    kind: 'board',
    name,
    canvas: canvasWire(canvas, hex),
  }))
  const cases = BOARDS.flatMap(({ name, canvas }) =>
    changes.map(
      (change): CaseRecord => ({
        kind: 'case',
        board: name,
        change: changeWire(change),
        conflicts: canvasChangeConflicts(change, structuredClone(canvas)),
      }),
    ),
  )
  return [...boards, ...cases]
}
