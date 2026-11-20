/**
 * What a refusal carries across the engine boundary: the limit's own breach
 * object, which a keeper words its refusal from. One case per breach shape the
 * two judges can produce, each held to the object the judge itself answers for
 * the same bytes — so a field a judge adds reaches a daemon's refusal without
 * a line here, and a shape no case builds fails the suite.
 */
import {
  CANVAS_MAX_NODES,
  COMMENT_MESSAGE_MAX_CHARS,
  CONTAINER_NAME_MAX_CHARS,
  DOCUMENT_MAX_OPEN_CHANGES,
  DOCUMENT_MAX_OPEN_THREADS,
  DOCUMENT_NAME_MAX_LENGTH,
  LABEL_MAX_CHARS,
  MARKDOWN_MAX_CHARS,
  NODE_LOCATION_MAX_CHARS,
  NODE_TEXT_MAX_CHARS,
  TAGS_PER_ELEMENT_MAX,
  TEXT_ANCHOR_QUOTE_MAX_CHARS,
  THREAD_MAX_MESSAGES,
  WORKSPACE_MAX_DOCUMENTS,
  WORKSPACE_MAX_FOLDERS,
  type CommentThread,
  documentEngine as wire,
  type ProposedChange,
} from '@kamiazya/whiteboard-model'
import { fileNode, groupNode, textNode } from '@kamiazya/whiteboard-model/test-utils'
import { type JsonChange, LoroDoc } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import { writeCommentThread, writeThreadMessage } from '../comment-threads.js'
import { CANVAS_KEY, CANVAS_TAGS_FIELD, NODES_KEY } from '../containers.js'
import { writeDocumentKind } from '../document-envelope.js'
import type { CrdtEngine } from '../engine/types.js'
import { writeSpatialCanvas, writeSpatialNode } from '../loro-bridge.js'
import { writeProposal } from '../proposals.js'
import { importWithinTextLimits } from '../sync-text-limits.js'
import { judgeWorkspaceSyncImport } from '../workspace-sync-limits.js'
import { documentContainers } from '../workspace-tree.js'
import { mutation } from './crdt-engine-conformance-kit.js'
import {
  BOARD,
  crowd,
  documentNode,
  folderNode,
  NOTE,
  seedRecord,
} from './crdt-engine-conformance-workspace-sync.js'

interface Case {
  readonly judge: 'text' | 'workspace-sync'
  readonly base: () => LoroDoc
  /** The bytes a peer sends to a record holding `base`. */
  readonly update: (base: LoroDoc) => Uint8Array
}

const CEILING_TIMEOUT_MS = 30_000
const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64')

function editedBy(edit: (client: LoroDoc) => void): Case['update'] {
  return (base) => {
    const client = base.fork()
    client.setPeerId(2n)
    const from = client.oplogVersion()
    edit(client)
    client.commit()
    return client.export({ mode: 'update', from })
  }
}

const seeded = (body = 's') => {
  const doc = new LoroDoc()
  doc.getText('body').insert(0, body)
  doc.commit()
  return doc
}

const box = (id: string) => textNode({ id, x: 0, y: 0, width: 100, height: 40, text: id })
const board = () => {
  const doc = new LoroDoc()
  writeSpatialCanvas(doc, { nodes: [box('a'), box('b')], edges: [] })
  doc.commit()
  return doc
}
const over = (max: number) => 'x'.repeat(max + 1)

const thread = (id: string, messages: number, anchor: CommentThread['anchor']): CommentThread => ({
  id,
  anchor,
  status: 'open',
  messages: Array.from({ length: messages }, (_, m) => ({ id: `${id}-m${m}`, body: 'and?' })),
})
const DOCUMENT_ANCHOR = { kind: 'document' } as const
const change = (i: number): ProposedChange => ({
  id: `ch${i}`,
  status: 'open',
  op: 'node.add',
  node: box(`n${i}`),
})

/** Q's writes into a container P has not created, depending on nothing: a change no record can place. */
function orphanWrites(): Uint8Array {
  const orphan = 'cid:0@777:Map'
  const orphaned: JsonChange = {
    id: '0@888',
    timestamp: 0,
    deps: [],
    lamport: 0,
    msg: null,
    ops: Array.from({ length: 200 }, (_, i) => ({
      container: orphan,
      content: { type: 'insert', key: `k${i}`, value: { id: `k${i}`, text: 'x'.repeat(40) } },
      counter: i,
    })) as JsonChange['ops'],
  }
  const q = new LoroDoc()
  q.setPeerId(888n)
  // A string, since the typed form has no spelling for uncompressed peer ids.
  q.importJsonUpdates(
    JSON.stringify({ schema_version: 1, start_version: {}, peers: null, changes: [orphaned] }),
  )
  return q.export({ mode: 'update' })
}

/**
 * The text judge answers a short update without reading it, so each edit is
 * padded past that: the padding is a root container no bound names.
 */
const text = (base: () => LoroDoc, edit: (client: LoroDoc) => void): Case => ({
  judge: 'text',
  base,
  update: editedBy((client) => {
    client.getText('pad').insert(0, 'p'.repeat(2_000))
    edit(client)
  }),
})
const sync = (edit: (client: LoroDoc) => void, base: () => LoroDoc = seedRecord): Case => ({
  judge: 'workspace-sync',
  base,
  update: editedBy(edit),
})
const crowded = (count: number, documents: boolean) => () => {
  const doc = new LoroDoc()
  crowd(doc, count, documents)
  doc.commit()
  return doc
}
const manyOf = (count: number, write: (doc: LoroDoc, i: number) => void) => () => {
  const doc = new LoroDoc()
  for (let i = 0; i < count; i += 1) write(doc, i)
  doc.commit()
  return doc
}

const half = Math.floor(MARKDOWN_MAX_CHARS / 2) + 10
const piece = (MARKDOWN_MAX_CHARS * 3) / 4

const CASES = {
  run: text(seeded, (c) => c.getText('body').insert(0, over(MARKDOWN_MAX_CHARS))),
  runs: text(seeded, (c) => {
    c.getText('a').insert(0, 'a'.repeat(piece))
    c.getText('b').insert(0, 'b'.repeat(piece))
  }),
  body: text(seeded, (c) => {
    const body = c.getText('body')
    body.insert(1, 'a'.repeat(half))
    c.getMap('m').set('k', 1)
    body.insert(1 + half, 'b'.repeat(half))
  }),
  'node-text': text(board, (c) =>
    writeSpatialNode(c, {
      id: 'n1',
      resource: { mimeType: 'text/markdown', content: over(NODE_TEXT_MAX_CHARS) },
      x: 0,
      y: 0,
      width: 200,
      height: 100,
    }),
  ),
  'node-location': text(board, (c) =>
    writeSpatialNode(
      c,
      fileNode({
        id: 'f',
        x: 0,
        y: 0,
        width: 200,
        height: 60,
        file: over(NODE_LOCATION_MAX_CHARS),
      }),
    ),
  ),
  label: text(board, (c) =>
    writeSpatialNode(
      c,
      groupNode({ id: 'g', x: 0, y: 200, width: 400, height: 200, label: over(LABEL_MAX_CHARS) }),
    ),
  ),
  'comment-message': text(board, (c) =>
    writeCommentThread(c, {
      ...thread('t', 0, DOCUMENT_ANCHOR),
      messages: [{ id: 'm9', body: over(COMMENT_MESSAGE_MAX_CHARS) }],
    }),
  ),
  tags: text(board, (c) =>
    c.getMap(CANVAS_KEY).set(
      CANVAS_TAGS_FIELD,
      Array.from({ length: TAGS_PER_ELEMENT_MAX + 1 }, (_, i) => `t${i}`),
    ),
  ),
  'container-name': text(board, (c) =>
    c.getMap('r'.repeat(CONTAINER_NAME_MAX_CHARS + 1)).set('a', 1),
  ),
  'canvas-size': text(
    manyOf(CANVAS_MAX_NODES, (doc, i) => writeSpatialNode(doc, box(`n${i}`))),
    (c) => writeSpatialNode(c, box('extra')),
  ),
  'thread-anchor': text(board, (c) =>
    writeCommentThread(
      c,
      thread('t1', 1, {
        kind: 'spatial',
        nodeIds: Array.from({ length: CANVAS_MAX_NODES + 1 }, (_, i) => `n${i}`),
        x: 0,
        y: 0,
        width: 10,
        height: 10,
      }),
    ),
  ),
  'anchor-quote': text(board, (c) =>
    writeCommentThread(
      c,
      thread('t1', 1, {
        kind: 'text',
        quote: { exact: 'q'.repeat(TEXT_ANCHOR_QUOTE_MAX_CHARS + 1) },
        start: 0,
        end: TEXT_ANCHOR_QUOTE_MAX_CHARS + 1,
      }),
    ),
  ),
  'open-threads': text(
    manyOf(DOCUMENT_MAX_OPEN_THREADS, (doc, i) =>
      writeCommentThread(doc, thread(`t${i}`, 1, DOCUMENT_ANCHOR)),
    ),
    (c) => writeCommentThread(c, thread('extra', 1, DOCUMENT_ANCHOR)),
  ),
  'open-changes': text(
    manyOf(1, (doc) =>
      writeProposal(doc, {
        id: 'p1',
        changes: Array.from({ length: DOCUMENT_MAX_OPEN_CHANGES }, (_, i) => change(i)),
      }),
    ),
    (c) => writeProposal(c, { id: 'p2', changes: [change(-1)] }),
  ),
  'thread-messages': text(
    manyOf(1, (doc) => writeCommentThread(doc, thread('long', THREAD_MAX_MESSAGES, DOCUMENT_ANCHOR))),
    (c) => writeThreadMessage(c, 'long', { id: 'extra', body: 'one more' }),
  ),
  'content-root': text(seedRecord, (c) => documentNode(c, NOTE).data.set('nodes', 1)),
  'reserved-map-key': text(board, (c) => c.getMap(NODES_KEY).set('__proto__', { id: 'n2' })),
  'retired-shape': text(board, (c) =>
    c.getMap(NODES_KEY).set('n2', { id: 'n2', 'x-whiteboard': { a: 1 } }),
  ),
  'retired-comment-plane': text(board, (c) => c.getMap('comments').set('c', { id: 'c' })),
  'unattached-container': { judge: 'text', base: board, update: orphanWrites },
  'causal-gap': {
    judge: 'workspace-sync',
    base: seedRecord,
    update: (base) => {
      const client = base.fork()
      documentNode(client, NOTE).data.set('name', 'one')
      client.commit()
      const middle = client.oplogVersion()
      documentNode(client, NOTE).data.set('name', 'two')
      client.commit()
      return client.export({ mode: 'update', from: middle })
    },
  },
  'too-many-documents': sync((c) => crowd(c, 1, true), crowded(WORKSPACE_MAX_DOCUMENTS, true)),
  'too-many-folders': sync((c) => crowd(c, 1, false), crowded(WORKSPACE_MAX_FOLDERS, false)),
  'unreadable-document-meta': sync((c) => documentNode(c, NOTE).data.set('kind', 'bogus')),
  'invalid-path': sync((c) => documentNode(c, NOTE).data.set('segment', 'not a segment')),
  'document-name-too-long': sync((c) =>
    documentNode(c, NOTE).data.set('name', over(DOCUMENT_NAME_MAX_LENGTH)),
  ),
  'folder-name-refused': sync((c) => folderNode(c, 'week').data.set('name', 'a/b')),
  'document-kind-changed': sync((c) => writeDocumentKind(documentContainers(c, BOARD), 'markdown')),
} satisfies Record<wire.BreachShape, Case>

/** What the judge itself answers for the bytes, which is what a direct caller of it reads today. */
function judgedDirectly({ judge, update }: Case, base: LoroDoc) {
  const bytes = update(base)
  const breach =
    judge === 'text'
      ? importWithinTextLimits(base.fork(), bytes).breach
      : judgeWorkspaceSyncImport(base.fork(), bytes)
  return { bytes, breach }
}

export function describeBreachDetail(makeEngine: () => CrdtEngine) {
  describe('what a refusal carries of the limit it names', () => {
    it('has a case for every breach shape, so a shape no case builds fails here', () => {
      expect(Object.keys(CASES).sort()).toEqual([...wire.breachShapeSchema.options].sort())
    })

    it.each(Object.entries(CASES) as Array<[wire.BreachShape, Case]>)(
      'carries the judge\'s own object for %s',
      (shape, held) => {
        const base = held.base()
        const { bytes, breach: direct } = judgedDirectly(held, base)
        expect(direct?.shape, 'the fixture builds this shape').toBe(shape)

        const engine = makeEngine()
        const { handle } = engine.open({
          peer: '1',
          bytes: base64(base.export({ mode: 'snapshot' })),
        })
        const result = mutation(engine.import({ handle, bytes: base64(bytes), judge: held.judge }))

        expect(result.outcome).toBe('refused')
        if (result.outcome !== 'refused') return
        expect(result.breach.shape).toBe(shape)
        // The wire is JSON: what a judge leaves undefined is not on it.
        expect(result.breach.detail).toEqual(JSON.parse(JSON.stringify(direct)))
        if (direct !== null && 'container' in direct) {
          expect(result.breach.container).toBe(direct.container)
        }
      },
      CEILING_TIMEOUT_MS,
    )
  })
}
