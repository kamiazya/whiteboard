// @vitest-environment node

/**
 * An editor command's writes, produced as engine wire writes, leave the
 * document exactly where the loro-adapter writers called directly do.
 *
 * The oracle is a frozen restatement of the direct writers (`oracle` below),
 * not `planCommand` run twice: the planner is the subject, so the reference
 * calls the adapter's own writers and shares nothing with it but the pure
 * `applyAdoptedPassages` that decides what a body adoption rewrites.
 */
import {
  type DocumentContainers,
  deleteSpatialNode,
  markThreadPassages,
  moveCommentThread,
  readCoreFacets,
  readMarkdownBody,
  readSpatialCanvas,
  reconcileCoreFacets,
  reconcileSpatialCanvas,
  setCommentThreadStatus,
  sharedCrdtEngine,
  type WriteTarget,
  withDocumentBatch,
  withSpatialBatch,
  writeCommentThread,
  writeDocumentKind,
  writeMarkdownBody,
  writeProposal,
  writeSpatialCanvas,
  writeSpatialEdge,
  writeSpatialNode,
  writeThreadMessage,
} from '@kamiazya/whiteboard-loro-adapter'
import {
  base64ToBytes,
  bytesToBase64,
  type CanvasEdge,
  type ProposedChange,
  type SpatialCanvas,
  type StoredCoreFacets,
} from '@kamiazya/whiteboard-model'
import { afterAllFloor, textNode } from '@kamiazya/whiteboard-model/test-utils'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, it, vi } from 'vitest'

// The fallback to a whole-canvas reconcile logs first; the property drives it on purpose.
vi.mock('./app-logger.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./app-logger.js')>()
  return {
    ...actual,
    getAppLogger: (name: string) => ({ ...actual.getAppLogger(name), warn: () => undefined }),
  }
})

import { assertLedger, emptyTally, type SurfaceCoverage } from '../test-utils/coverage-ledger.js'
import { fc, withDefaults } from '../test-utils/fast-check.js'
import { applyAdoptedPassages } from './apply-adopted-passages.js'
import { commitToDoc } from './command-writes.js'
import type { EditorCommand, EditorLeafCommand } from './spatial/commands.js'
import { applyCommand } from './spatial/commands.js'

// ---- the reference: today's direct writers, restated ----

type Fine = 'written' | 'target-missing' | 'unmapped'

function oracleLeaf(
  doc: DocumentContainers,
  next: SpatialCanvas,
  command: EditorLeafCommand,
): Fine {
  switch (command.kind) {
    case 'move-node':
    case 'resize-node':
    case 'set-text':
    case 'create-node': {
      const id = command.kind === 'create-node' ? command.node.id : command.id
      const node = next.nodes.find((n) => n.id === id)
      if (!node) return 'target-missing'
      writeSpatialNode(doc, node)
      return 'written'
    }
    case 'connect-nodes':
    case 'create-edge': {
      const id = command.kind === 'create-edge' ? command.edge.id : command.edgeId
      const edge = next.edges.find((e) => e.id === id)
      if (!edge) return 'target-missing'
      writeSpatialEdge(doc, edge)
      return 'written'
    }
    case 'delete-node':
      deleteSpatialNode(doc, command.id)
      return 'written'
    default:
      return 'unmapped'
  }
}

function oracleDecision(
  doc: DocumentContainers,
  command: Extract<EditorCommand, { kind: 'decide-proposal' }>,
  prev: SpatialCanvas,
  next: SpatialCanvas,
): void {
  withDocumentBatch(doc, (writer) => {
    if (command.decision === 'adopted') {
      const refused = applyAdoptedPassages(readMarkdownBody(doc), command.changes, (body) =>
        writer.writeMarkdownBody(body),
      )
      if (refused !== undefined) return
      writer.reconcileSpatialCanvas(prev, next)
    }
    for (const change of command.changes) {
      writer.setProposedChangeStatus(command.proposalId, change.id, command.decision)
    }
  })
}

function oracleBatch(
  doc: DocumentContainers,
  next: SpatialCanvas,
  commands: readonly EditorLeafCommand[],
): Fine {
  const writable = (c: EditorLeafCommand): Fine =>
    c.kind === 'delete-node' || c.kind === 'delete-edge' ? 'written' : oracleLeafProbe(next, c)
  const bad = commands.map(writable).find((o) => o !== 'written')
  if (bad !== undefined) return bad
  withSpatialBatch(doc, (writer) => {
    for (const c of commands) {
      if (c.kind === 'delete-node') writer.deleteNode(c.id)
      else if (c.kind === 'delete-edge') writer.deleteEdge(c.id)
      else if (c.kind === 'create-edge' || c.kind === 'connect-nodes') {
        const id = c.kind === 'create-edge' ? c.edge.id : c.edgeId
        const edge = next.edges.find((e) => e.id === id)
        if (edge) writer.writeEdge(edge)
      } else {
        const id = c.kind === 'create-node' ? c.node.id : (c as { id: string }).id
        const node = next.nodes.find((n) => n.id === id)
        if (node) writer.writeNode(node)
      }
    }
  })
  return 'written'
}

/** Whether a batch member could be written: the leaf kinds the batch writer offers, target present. */
function oracleLeafProbe(next: SpatialCanvas, c: EditorLeafCommand): Fine {
  switch (c.kind) {
    case 'move-node':
    case 'resize-node':
    case 'set-text':
      return next.nodes.some((n) => n.id === c.id) ? 'written' : 'target-missing'
    case 'create-node':
      return next.nodes.some((n) => n.id === c.node.id) ? 'written' : 'target-missing'
    case 'connect-nodes':
      return next.edges.some((e) => e.id === c.edgeId) ? 'written' : 'target-missing'
    case 'create-edge':
      return next.edges.some((e) => e.id === c.edge.id) ? 'written' : 'target-missing'
    default:
      return 'unmapped'
  }
}

function oracleFine(
  host: LoroDoc,
  prev: SpatialCanvas,
  next: SpatialCanvas,
  command: EditorCommand,
): Fine {
  switch (command.kind) {
    case 'move-thread':
      moveCommentThread(host, command.threadId, command)
      return 'written'
    case 'reply-to-thread':
    case 'edit-thread-message':
      writeThreadMessage(host, command.threadId, command.message)
      return 'written'
    case 'set-thread-status':
      setCommentThreadStatus(host, command.threadId, command.status)
      return 'written'
    case 'decide-proposal':
      oracleDecision(host, command, prev, next)
      return 'written'
    case 'create-thread':
      writeCommentThread(host, command.thread)
      if (command.thread.anchor.kind === 'text') {
        const { start, end } = command.thread.anchor
        markThreadPassages(host, host, new Map([[command.thread.id, { start, end }]]))
      }
      return 'written'
    case 'set-body':
      writeMarkdownBody(host, command.text)
      return 'written'
    case 'set-facets':
      reconcileCoreFacets(host, readCoreFacets(host), command.facets)
      return 'written'
    case 'batch':
      return oracleBatch(host, next, command.commands)
    case 'delete-edge':
    case 'create-line':
    case 'set-node-color':
    case 'reorder-nodes':
      return 'unmapped'
    default:
      return oracleLeaf(host, next, command)
  }
}

/** Answers whether the command took the whole-canvas fallback. */
function oracle(
  host: LoroDoc,
  prev: SpatialCanvas,
  next: SpatialCanvas,
  command: EditorCommand,
): boolean {
  try {
    if (oracleFine(host, prev, next, command) === 'written') return false
  } catch {
    // the fine-grained write failed: reconcile below, as the session does
  }
  reconcileSpatialCanvas(host, prev, next)
  return true
}

// ---- the fixture ----

const BODY = 'Ship it on Thursday.\n'
const PASSAGE: ProposedChange = {
  id: 'passage',
  op: 'body.replace',
  status: 'open',
  anchor: { kind: 'text', quote: { exact: 'Thursday' }, start: 11, end: 19 },
  text: 'Friday',
  assumed: 'Thursday',
}
const MOVE_N0: ProposedChange = {
  id: 'node:n0',
  op: 'node.patch',
  status: 'open',
  nodeId: 'n0',
  patch: { x: 240 },
  assumed: { x: 0 },
}
const NODE_IDS = ['n0', 'n1', 'n2', 'ghost'] as const
const EDGE_IDS = ['e0', 'e1', 'ghost'] as const
const THREAD_IDS = ['t0', 't1', 'tx'] as const

const node = (id: string, x: number) => textNode({ id, x, y: 0, width: 100, height: 50, text: id })

function seedDoc(): LoroDoc {
  const doc = new LoroDoc()
  const nodes = [node('n0', 0), node('n1', 200), node('n2', 400)]
  const e0: CanvasEdge = { id: 'e0', from: { node: 'n0' }, to: { node: 'n1' } }
  writeDocumentKind(doc, 'markdown')
  writeSpatialCanvas(doc, { nodes, edges: [e0] })
  writeMarkdownBody(doc, BODY)
  writeCommentThread(doc, {
    id: 't0',
    anchor: { kind: 'document' },
    status: 'open',
    messages: [{ id: 'm0', body: 'opening' }],
  })
  writeCommentThread(doc, {
    id: 't1',
    anchor: { kind: 'spatial', x: 5, y: 5 },
    status: 'open',
    messages: [{ id: 'm1', body: 'pin' }],
  })
  writeProposal(doc, {
    id: 'p1',
    createdAt: '2026-09-06T00:00:00.000Z',
    changes: [MOVE_N0, PASSAGE],
  })
  return doc
}

// ---- the generator ----

const pick = <T>(values: readonly T[]) => fc.constantFrom(...values)
const coord = fc.integer({ min: -50, max: 500 })
const text = fc.constantFrom('', 'a', 'alpha beta', 'Ship it on Friday.\n', BODY)
const messageArb = fc.record({
  id: fc.constantFrom('m0', 'm1', 'm2', 'm3'),
  body: text,
})
const edgeArb: fc.Arbitrary<CanvasEdge> = fc
  .tuple(pick(EDGE_IDS), pick(NODE_IDS), pick(NODE_IDS))
  .map(([id, from, to]) => ({ id, from: { node: from }, to: { node: to } }))

const leafArb: fc.Arbitrary<EditorLeafCommand> = fc.oneof(
  fc.record({ kind: fc.constant('move-node' as const), id: pick(NODE_IDS), x: coord, y: coord }),
  fc.record({
    kind: fc.constant('resize-node' as const),
    id: pick(NODE_IDS),
    x: coord,
    y: coord,
    width: fc.integer({ min: 1, max: 300 }),
    height: fc.integer({ min: 1, max: 300 }),
  }),
  fc.record({ kind: fc.constant('set-text' as const), id: pick(NODE_IDS), text }),
  fc.record({
    kind: fc.constant('connect-nodes' as const),
    edgeId: pick(EDGE_IDS),
    fromNode: pick(NODE_IDS),
    toNode: pick(NODE_IDS),
  }),
  fc.record({
    kind: fc.constant('create-node' as const),
    node: fc.tuple(fc.constantFrom('n0', 'n3', 'n4', 'n5'), coord).map(([id, x]) => node(id, x)),
  }),
  fc.record({ kind: fc.constant('delete-node' as const), id: pick(NODE_IDS) }),
  fc.record({ kind: fc.constant('create-edge' as const), edge: edgeArb }),
  fc.record({ kind: fc.constant('delete-edge' as const), id: pick(EDGE_IDS) }),
  fc.record({
    kind: fc.constant('set-node-color' as const),
    id: pick(NODE_IDS),
    color: fc.constantFrom('1', '2', undefined),
  }),
  fc.record({
    kind: fc.constant('reorder-nodes' as const),
    ids: fc.subarray([...NODE_IDS], { minLength: 1 }),
    placement: fc.constantFrom('forward' as const, 'backward' as const, 'front' as const),
  }),
  fc.record({
    kind: fc.constant('create-line' as const),
    line: fc.record({
      id: fc.constantFrom('l0', 'l1'),
      from: fc.constant({ kind: 'point' as const, point: { x: 0, y: 0 } }),
      to: fc.constant({ kind: 'point' as const, point: { x: 9, y: 9 } }),
    }),
  }),
)

/** Leaf kinds whose effect needs an unclaimed id and live endpoints: drawn more often than the pool alone would. */
const edgeLeafArb: fc.Arbitrary<EditorLeafCommand> = fc.oneof(
  fc.record({
    kind: fc.constant('connect-nodes' as const),
    edgeId: fc.constantFrom('e1', 'e2', 'e0'),
    fromNode: fc.constantFrom('n0', 'n1', 'n2'),
    toNode: fc.constantFrom('n0', 'n1', 'n2'),
  }),
  fc.record({
    kind: fc.constant('create-edge' as const),
    edge: fc
      .tuple(
        fc.constantFrom('e1', 'e2'),
        fc.constantFrom('n0', 'n1', 'n2'),
        fc.constantFrom('n0', 'n1', 'n2'),
      )
      .map(([id, from, to]) => ({ id, from: { node: from }, to: { node: to } })),
  }),
  fc.record({ kind: fc.constant('delete-edge' as const), id: fc.constantFrom('e0', 'e1', 'e2') }),
)

const threadAnchorArb = fc.oneof(
  fc.constant({ kind: 'document' as const }),
  fc.record({ kind: fc.constant('spatial' as const), x: coord, y: coord }),
  fc.tuple(fc.integer({ min: 0, max: 15 }), fc.integer({ min: 1, max: 5 })).map(([start, len]) => ({
    kind: 'text' as const,
    quote: { exact: BODY.slice(start, start + len) },
    start,
    end: start + len,
  })),
)

const threadCommandArb: fc.Arbitrary<EditorCommand> = fc.oneof(
  fc.record({
    kind: fc.constant('move-thread' as const),
    threadId: fc.constantFrom('t1', 't1', 't0', 'tx'),
    x: coord,
    y: coord,
    nodeId: fc.constantFrom('n0', undefined),
  }),
  fc.record({
    kind: fc.constant('reply-to-thread' as const),
    threadId: pick(THREAD_IDS),
    message: messageArb,
  }),
  fc.record({
    kind: fc.constant('edit-thread-message' as const),
    threadId: pick(THREAD_IDS),
    message: messageArb,
    opening: fc.boolean(),
  }),
  fc.record({
    kind: fc.constant('set-thread-status' as const),
    threadId: pick(THREAD_IDS),
    status: fc.constantFrom('open' as const, 'resolved' as const),
  }),
  fc.record({
    kind: fc.constant('create-thread' as const),
    thread: fc.record({
      id: fc.constantFrom('t0', 't2', 't3'),
      anchor: threadAnchorArb,
      status: fc.constant('open' as const),
      messages: fc.array(messageArb, { minLength: 1, maxLength: 2 }),
    }),
  }),
)

const FACETS: StoredCoreFacets[] = [
  { type: 'note' },
  { type: 'note', tags: ['a'] },
  { type: 'note', view: 'example.board' },
]

const documentCommandArb: fc.Arbitrary<EditorCommand> = fc.oneof(
  fc.record({ kind: fc.constant('set-body' as const), text }),
  fc.record({
    kind: fc.constant('set-facets' as const),
    facets: fc.constantFrom(...FACETS),
  }),
  fc.record({
    kind: fc.constant('decide-proposal' as const),
    proposalId: fc.constantFrom('p1', 'p-ghost'),
    decision: fc.constantFrom('adopted' as const, 'dismissed' as const),
    changes: fc.subarray([MOVE_N0, PASSAGE]),
  }),
)

const batchArb: fc.Arbitrary<EditorCommand> = fc.record({
  kind: fc.constant('batch' as const),
  commands: fc.array(leafArb, { minLength: 1, maxLength: 4 }),
})

const commandArb: fc.Arbitrary<EditorCommand> = fc.oneof(
  { weight: 5, arbitrary: leafArb },
  { weight: 2, arbitrary: edgeLeafArb },
  { weight: 3, arbitrary: threadCommandArb },
  { weight: 2, arbitrary: documentCommandArb },
  { weight: 2, arbitrary: batchArb },
)

// ---- the ledger ----

const NOT_REACHED =
  'not modelled: an unmapped kind takes the whole-canvas reconcile exactly as set-node-color does, which this property drives; the kind itself is applied by commands.test.ts' as const

const COMMAND_COVERAGE = {
  'move-node': 'covered',
  'resize-node': 'covered',
  'set-text': 'covered',
  'connect-nodes': 'covered',
  'create-node': 'covered',
  'delete-node': 'covered',
  'create-edge': 'covered',
  'delete-edge': 'covered',
  'set-node-color': 'covered',
  'reorder-nodes':
    'not modelled: the whole-canvas reconcile it takes writes nothing for a pure permutation of the nodes (measured: the stored document is unchanged), so there is no effect to compare; the generator still drives it down the fallback',
  'create-line': 'covered',
  'move-thread': 'covered',
  'reply-to-thread': 'covered',
  'edit-thread-message': 'covered',
  'set-thread-status': 'covered',
  'create-thread': 'covered',
  'set-body': 'covered',
  'set-facets': 'covered',
  'decide-proposal': 'covered',
  batch: 'covered',
  'delete-line': NOT_REACHED,
  'move-line': NOT_REACHED,
  'set-line-label': NOT_REACHED,
  'set-line-ends': NOT_REACHED,
  'set-line-side': NOT_REACHED,
  'set-line-facet': NOT_REACHED,
  'set-line-bends': NOT_REACHED,
  'set-line-color': NOT_REACHED,
  'set-edge-label': NOT_REACHED,
  'set-edge-ends': NOT_REACHED,
  'set-edge-color': NOT_REACHED,
  'set-edge-facet': NOT_REACHED,
  'set-edge-tags': NOT_REACHED,
  'set-edge-bends': NOT_REACHED,
  'set-edge-routing': NOT_REACHED,
  'set-edge-side': NOT_REACHED,
  'set-edge-end': NOT_REACHED,
  'set-line-end': NOT_REACHED,
  'set-line-jumps': NOT_REACHED,
  'ungroup-ink': NOT_REACHED,
  'set-canvas-facet': NOT_REACHED,
  'set-canvas-tags': NOT_REACHED,
  'set-node-facet': NOT_REACHED,
  'set-node-tags': NOT_REACHED,
  'set-node-file': NOT_REACHED,
  'set-node-url': NOT_REACHED,
  'create-group': NOT_REACHED,
  'set-group-label': NOT_REACHED,
  'set-group-background': NOT_REACHED,
} satisfies Record<EditorCommand['kind'], SurfaceCoverage>

/** Per kind: how often the command CHANGED the reference document, so an inert one asserts nothing. */
const effective = emptyTally(COMMAND_COVERAGE)
const reach = { commands: 0, effective: 0, fellBack: 0, multiCommand: 0 }

// ---- the three documents ----

/** Map key order is a property of the replica's history, not of the content. */
const sorted = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(sorted)
    : typeof value === 'object' && value !== null
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([key, member]) => [key, sorted(member)]),
        )
      : value

const snapshotOf = (doc: LoroDoc) =>
  JSON.stringify(sorted({ json: doc.toJSON(), body: doc.getText('body').toDelta() }))

const loaded = (bytes: Uint8Array): LoroDoc => {
  const doc = new LoroDoc()
  doc.import(bytes)
  return doc
}

function engineTarget(handle: number): WriteTarget {
  const engine = sharedCrdtEngine()
  const read = (query: 'markdownBody' | 'coreFacets') => {
    const answer = engine.readNow({ handle, query: { query } }).value as { ok: unknown }
    const value = answer.ok
    return typeof value === 'object' && value !== null && '$undefined' in value ? undefined : value
  }
  return {
    documentId: undefined,
    body: () => read('markdownBody') as string,
    coreFacets: () => read('coreFacets') as ReturnType<WriteTarget['coreFacets']>,
    apply(writes) {
      const result = engine.write({ handle, batch: [...writes], judge: 'none' })
      if (result.outcome !== 'applied') throw new Error('the engine refused a write')
    },
  }
}

describe('a command as engine writes', () => {
  it('leaves the document where the direct writers leave it, command after command', () => {
    const engine = sharedCrdtEngine()
    fc.assert(
      fc.property(fc.array(commandArb, { minLength: 1, maxLength: 8 }), (commands) => {
        const seed = seedDoc().export({ mode: 'snapshot' })
        const ref = loaded(seed)
        const { handle } = engine.open({ peer: '7', bytes: bytesToBase64(seed) })
        try {
          if (commands.length > 1) reach.multiCommand++
          for (const command of commands) {
            const prev = readSpatialCanvas(ref)
            const next = applyCommand(prev, command)
            const before = snapshotOf(ref)
            if (oracle(ref, prev, next, command)) reach.fellBack++
            reach.commands++
            if (snapshotOf(ref) !== before) {
              reach.effective++
              effective[command.kind]++
            }
            commitToDoc(engineTarget(handle), prev, next, command)
            const wire = engine.export({ handle, mode: 'snapshot' }).bytes ?? ''
            const wireDoc = new LoroDoc()
            wireDoc.import(base64ToBytes(wire) ?? new Uint8Array())
            expect(snapshotOf(wireDoc), command.kind).toBe(snapshotOf(ref))
          }
        } finally {
          engine.close({ handle })
        }
      }),
      withDefaults({ numRuns: 100 }),
    )
  })
})

afterAllFloor(
  ['leaves the document where the direct writers leave it, command after command'],
  () => {
    assertLedger('EditorCommand kind', COMMAND_COVERAGE, effective)
    // Floors under the lowest of the measured runs, so a generator change that
    // stops reaching an arm fails here by name rather than passing over it.
    expect(reach.commands, 'the property applied almost no commands').toBeGreaterThan(250)
    expect(reach.effective / reach.commands, 'most commands changed nothing').toBeGreaterThan(0.45)
    expect(reach.fellBack, 'almost no command took the whole-canvas fallback').toBeGreaterThan(60)
    expect(reach.multiCommand, 'no sequence ever ran two commands in a row').toBeGreaterThan(20)
  },
)
