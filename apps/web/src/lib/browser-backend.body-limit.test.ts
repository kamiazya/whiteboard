/**
 * The browser keeper refuses to persist text past its bound — a markdown body
 * past `MARKDOWN_MAX_CHARS`, a canvas's node text, labels and comment
 * messages past theirs — as the daemon refuses to store it: a document cannot
 * hold text one keeper accepts and the other refuses, which is what a later
 * promotion would otherwise trip over.
 */
import {
  createWorkspaceDocumentAtPath,
  type DocumentContainers,
  documentContainers,
  readCommentThreads,
  readMarkdownBody,
  readSpatialCanvas,
  writeCommentThread,
  writeMarkdownBody,
  writeSpatialCanvas,
  writeSpatialEdge,
  writeSpatialNode,
} from '@kamiazya/whiteboard-loro-adapter'
import {
  COMMENT_MESSAGE_MAX_CHARS,
  LABEL_MAX_CHARS,
  MARKDOWN_MAX_CHARS,
  NODE_LOCATION_MAX_CHARS,
  NODE_TEXT_MAX_CHARS,
  nodeText,
  TAGS_PER_ELEMENT_MAX,
} from '@kamiazya/whiteboard-model'
import { linkNode, textNode } from '@kamiazya/whiteboard-model/test-utils'
import type { WorkspaceDocs } from '@kamiazya/whiteboard-workspace-index'
import { LoroDoc, type LoroText } from 'loro-crdt'
import { describe, expect, it, vi } from 'vitest'
import { expectLoggedFailure } from '../test-utils/logged-failures.js'
import { BrowserBackend } from './browser-backend.js'
import type { LoroStore } from './loro-store.js'

// jsdom has no IndexedDB, so the startup fold and the timestamp touch are
// replaced by their outcome; see browser-backend.read-failure.test.ts.
vi.mock('./fold-workspace.js', () => ({
  foldOrServeTheTree: async () => ({ folded: 0, skipped: 0 }),
}))
vi.mock('./loro-store.js', () => ({ LoroStore: class {}, touchContentTimestamp: async () => {} }))

const TARGET = {
  documentId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
  path: 'notes',
  kind: 'markdown' as const,
}

async function connected(body: string) {
  const record = new LoroDoc()
  createWorkspaceDocumentAtPath(record, {
    path: TARGET.path,
    documentId: TARGET.documentId,
    kind: 'markdown',
  })
  writeMarkdownBody(documentContainers(record, TARGET.documentId), body)
  const saved: string[] = []
  const docs = {
    create: async () => record,
    save: async (_workspaceId: string, doc: LoroDoc) => {
      saved.push(readMarkdownBody(documentContainers(doc, TARGET.documentId)))
      return null
    },
  } as unknown as WorkspaceDocs
  const backend = new BrowserBackend(TARGET, docs, {} as LoroStore)
  const reasons: string[] = []
  const refusals: string[] = []
  let snapshot: Uint8Array | null = null
  let snapshots = 0
  backend.connect({
    onConnected: () => {},
    onSnapshot: (bytes: Uint8Array) => {
      snapshot = bytes
      snapshots += 1
    },
    onRemoteUpdate: () => {},
    onError: (reason: string) => reasons.push(reason),
    onWriteRefused: (refusal: { code: string | null }) => refusals.push(String(refusal.code)),
  } as never)
  await vi.waitFor(() => expect(snapshot).not.toBeNull())
  const session = LoroDoc.fromSnapshot(snapshot as unknown as Uint8Array)
  const pushEdit = (edit: (body: LoroText) => void) => {
    const from = session.oplogVersion()
    edit(documentContainers(session, TARGET.documentId).getText('body'))
    session.commit()
    return backend.pushLocalUpdate(session.export({ mode: 'update', from }))
  }
  const push = (text: string) => pushEdit((body) => body.insert(0, text))
  return { saved, reasons, refusals, snapshots: () => snapshots, push, pushEdit, record }
}

describe('a browser-kept markdown body pushed past the limit', () => {
  it('is not persisted, and the session is told why and handed the record again', async () => {
    const { saved, reasons, refusals, snapshots, push, record } = await connected(
      'y'.repeat(MARKDOWN_MAX_CHARS - 1),
    )

    await push('ab')

    await expectLoggedFailure('refused an update past a text limit')
    expect(saved).toEqual([])
    expect(reasons).toEqual([])
    expect(refusals).toEqual(['markdown_too_large'])
    expect(snapshots()).toBe(2)
    expect(readMarkdownBody(documentContainers(record, TARGET.documentId))).toHaveLength(
      MARKDOWN_MAX_CHARS - 1,
    )
  })

  it('within the limit is persisted', async () => {
    const { saved, reasons, push } = await connected('short')

    await push('a ')

    expect(saved).toEqual(['a short'])
    expect(reasons).toEqual([])
  })
})

/**
 * The same four edits `apply-document-update-limit.test.ts` sends through the
 * daemon's sync operation, with the same verdicts: both keepers judge a write
 * by what it does to the text, so a write one keeper takes the other takes.
 */
describe.each([
  {
    edit: 'a select-all replace that shrinks the body',
    before: 200_000,
    change: (body: LoroText) => {
      body.delete(0, body.length)
      body.insert(0, 'z'.repeat(100_000))
    },
    after: 100_000,
  },
  {
    edit: 'a select-all replace of the same length',
    before: 150_000,
    change: (body: LoroText) => {
      body.delete(0, body.length)
      body.insert(0, 'z'.repeat(150_000))
    },
    after: 150_000,
  },
  {
    edit: 'clearing a body already past the limit',
    before: MARKDOWN_MAX_CHARS + 10_000,
    change: (body: LoroText) => body.delete(0, body.length),
    after: 0,
  },
  {
    edit: 'a delete from a body already past the limit',
    before: MARKDOWN_MAX_CHARS + 10,
    change: (body: LoroText) => body.delete(0, 5),
    after: MARKDOWN_MAX_CHARS + 5,
  },
  {
    edit: 'a small insert growing the body past the limit',
    before: MARKDOWN_MAX_CHARS - 3,
    change: (body: LoroText) => body.insert(0, 'four'),
    after: null,
  },
  {
    edit: 'one run past the limit',
    before: 5,
    change: (body: LoroText) => body.insert(0, 'x'.repeat(MARKDOWN_MAX_CHARS + 1)),
    after: null,
  },
])('$edit, pushed to the browser keeper', ({ before, change, after }) => {
  it(after === null ? 'is refused' : 'is persisted', async () => {
    const { saved, reasons, refusals, pushEdit } = await connected('y'.repeat(before))

    await pushEdit(change)

    expect(reasons).toEqual([])
    if (after === null) {
      await expectLoggedFailure('refused an update past a text limit')
      expect(saved).toEqual([])
      expect(refusals).toEqual(['markdown_too_large'])
    } else {
      expect(saved.map((body) => body.length)).toEqual([after])
      expect(refusals).toEqual([])
    }
  })
})

describe('a browser-kept body replaced wholesale', () => {
  it('is persisted, and so is the edit after it', async () => {
    const { saved, reasons, refusals, pushEdit } = await connected('y'.repeat(150_000))

    await pushEdit((body) => {
      body.delete(0, body.length)
      body.insert(0, 'z'.repeat(150_000))
    })
    await pushEdit((body) => body.insert(0, 'ab'))

    expect(reasons).toEqual([])
    expect(refusals).toEqual([])
    expect(saved.map((body) => `${body.slice(0, 3)}:${body.length}`)).toEqual([
      'zzz:150000',
      'abz:150002',
    ])
  })
})

const BOARD = {
  documentId: '01ARZ3NDEKTSV4RRFFQ69G5FAW',
  path: 'board',
  kind: 'spatial' as const,
}

/** A canvas record with two text nodes, an edge between them and one comment thread. */
function boardRecord(): LoroDoc {
  const record = new LoroDoc()
  createWorkspaceDocumentAtPath(record, {
    path: BOARD.path,
    documentId: BOARD.documentId,
    kind: 'spatial',
  })
  const seeded = documentContainers(record, BOARD.documentId)
  writeSpatialCanvas(seeded, {
    nodes: [
      textNode({ id: 'a', x: 0, y: 0, width: 100, height: 60, text: 'a' }),
      textNode({ id: 'b', x: 300, y: 0, width: 100, height: 60, text: 'b' }),
    ],
    edges: [{ id: 'e1', from: { node: 'a' }, to: { node: 'b' }, label: 'calls' }],
  })
  writeCommentThread(seeded, {
    id: 't1',
    anchor: { kind: 'document' },
    status: 'open',
    messages: [{ id: 'm1', body: 'looks off' }],
  })
  return record
}

/** That canvas, kept by the browser and connected. */
async function connectedBoard() {
  const record = boardRecord()
  let saves = 0
  const docs = {
    create: async () => record,
    save: async () => {
      saves += 1
      return null
    },
  } as unknown as WorkspaceDocs
  const backend = new BrowserBackend(BOARD, docs, {} as LoroStore)
  const reasons: string[] = []
  const refusals: string[] = []
  let snapshot: Uint8Array | null = null
  backend.connect({
    onConnected: () => {},
    onSnapshot: (bytes: Uint8Array) => {
      snapshot = bytes
    },
    onRemoteUpdate: () => {},
    onError: (reason: string) => reasons.push(reason),
    onWriteRefused: (refusal: { code: string | null }) => refusals.push(String(refusal.code)),
  } as never)
  await vi.waitFor(() => expect(snapshot).not.toBeNull())
  const session = LoroDoc.fromSnapshot(snapshot as unknown as Uint8Array)
  const pushEdit = (edit: (board: DocumentContainers) => void) => {
    const from = session.oplogVersion()
    edit(documentContainers(session, BOARD.documentId))
    session.commit()
    return backend.pushLocalUpdate(session.export({ mode: 'update', from }))
  }
  const stored = () => documentContainers(record, BOARD.documentId)
  return { saves: () => saves, reasons, refusals, pushEdit, stored }
}

/**
 * The same bounds the daemon's sync operation is held to, pushed through the
 * browser keeper.
 */
const linkTo = (length: number) => (board: DocumentContainers) =>
  writeSpatialNode(
    board,
    linkNode({
      id: 'k',
      x: 0,
      y: 200,
      width: 200,
      height: 60,
      url: `https://example.com/${'a'.repeat(length - 'https://example.com/'.length)}`,
    }),
  )

const tagNodeA = (count: number) => (board: DocumentContainers) =>
  writeSpatialNode(board, {
    ...textNode({ id: 'a', x: 0, y: 0, width: 100, height: 60, text: 'a' }),
    tags: Array.from({ length: count }, (_, i) => `t${i}`),
  })

describe.each([
  {
    edit: "a node's text",
    code: 'node_text_too_large',
    past: (board: DocumentContainers) =>
      writeSpatialNode(
        board,
        textNode({
          id: 'a',
          x: 0,
          y: 0,
          width: 100,
          height: 60,
          text: 'x'.repeat(NODE_TEXT_MAX_CHARS + 1),
        }),
      ),
    within: (board: DocumentContainers) =>
      writeSpatialNode(
        board,
        textNode({
          id: 'a',
          x: 0,
          y: 0,
          width: 100,
          height: 60,
          text: 'x'.repeat(NODE_TEXT_MAX_CHARS),
        }),
      ),
  },
  {
    edit: "a link's URL",
    code: 'node_location_too_large',
    past: linkTo(NODE_LOCATION_MAX_CHARS + 1),
    within: linkTo(NODE_LOCATION_MAX_CHARS),
  },
  {
    edit: "an edge's label",
    code: 'label_too_large',
    past: (board: DocumentContainers) =>
      writeSpatialEdge(board, {
        id: 'e1',
        from: { node: 'a' },
        to: { node: 'b' },
        label: 'x'.repeat(LABEL_MAX_CHARS + 1),
      }),
    within: (board: DocumentContainers) =>
      writeSpatialEdge(board, {
        id: 'e1',
        from: { node: 'a' },
        to: { node: 'b' },
        label: 'x'.repeat(LABEL_MAX_CHARS),
      }),
  },
  {
    edit: 'a comment message',
    code: 'comment_too_large',
    past: (board: DocumentContainers) =>
      writeCommentThread(board, {
        id: 't1',
        anchor: { kind: 'document' },
        status: 'open',
        messages: [{ id: 'm1', body: 'x'.repeat(COMMENT_MESSAGE_MAX_CHARS + 1) }],
      }),
    within: (board: DocumentContainers) =>
      writeCommentThread(board, {
        id: 't1',
        anchor: { kind: 'document' },
        status: 'open',
        messages: [{ id: 'm1', body: 'x'.repeat(COMMENT_MESSAGE_MAX_CHARS) }],
      }),
  },
  {
    edit: "a node's tags",
    code: 'tags_too_large',
    past: tagNodeA(TAGS_PER_ELEMENT_MAX + 1),
    within: tagNodeA(TAGS_PER_ELEMENT_MAX),
  },
])('$edit on a browser-kept canvas', ({ code, past, within }) => {
  it(`past its bound is refused as ${code}, and nothing is kept`, async () => {
    const { saves, reasons, refusals, pushEdit, stored } = await connectedBoard()

    await pushEdit(past)

    await expectLoggedFailure('refused an update past a text limit')
    expect(reasons).toEqual([])
    expect(refusals).toEqual([code])
    expect(saves()).toBe(0)
    const canvas = readSpatialCanvas(stored())
    expect(canvas.nodes.map(nodeText)).toEqual(['a', 'b'])
    expect(canvas.edges[0]?.label).toBe('calls')
    expect(readCommentThreads(stored())[0]?.messages[0]?.body).toBe('looks off')
  })

  it('at its bound is kept', async () => {
    const { saves, reasons, refusals, pushEdit } = await connectedBoard()

    await pushEdit(within)

    expect(reasons).toEqual([])
    expect(refusals).toEqual([])
    expect(saves()).toBe(1)
  })
})
