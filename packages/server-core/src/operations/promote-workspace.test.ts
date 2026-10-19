import {
  createWorkspaceDocumentAtPath,
  documentContainers,
  MARKDOWN_BODY_KEY,
  readMarkdownBody,
  resolveWorkspaceDocumentById,
  SYNC_TEXT_BREACH_CODES,
  WORKSPACE_TREE_KEY,
  writeCommentThread,
  writeMarkdownBody,
  writeProposal,
  writeSpatialCanvas,
  writeSpatialEdge,
  writeSpatialNode,
} from '@kamiazya/whiteboard-loro-adapter'
import {
  CANVAS_MAX_NODES,
  COMMENT_MESSAGE_MAX_CHARS,
  CONTAINER_NAME_MAX_CHARS,
  DOCUMENT_MAX_OPEN_CHANGES,
  DOCUMENT_MAX_OPEN_THREADS,
  LABEL_MAX_CHARS,
  MARKDOWN_MAX_CHARS,
  NODE_LOCATION_MAX_CHARS,
  NODE_TEXT_MAX_CHARS,
  TAG_MAX_CHARS,
  TEXT_ANCHOR_QUOTE_MAX_CHARS,
} from '@kamiazya/whiteboard-model'
import { fileNode, textNode } from '@kamiazya/whiteboard-model/test-utils'
import { LoroDoc, LoroMap, LoroText, type LoroTreeNode } from 'loro-crdt'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DocumentEngineTrapError } from '../document-io.js'
import type { LiveDocuments, WorkspaceDocuments } from '../server-deps.js'
import { FakeBlobStore } from '../test-utils/fake-blob-store.js'
import { FakeLiveDocuments } from '../test-utils/fake-live-documents.js'
import { FakeVersionHistory } from '../test-utils/fake-version-history.js'
import { unusedWorkspaceDocuments } from '../test-utils/unused-workspace-documents.js'
import { TooManyVersionsError } from '../versions/version-refusal.js'
import { promoteWorkspace } from './promote-workspace.js'
import {
  OffGrammarPathError,
  syncWriteAnswer,
  WORKSPACE_MAX_DOCUMENTS,
} from './sync-write-refusals.js'

const WS = 'ws-1'
const ROADMAP_ID = '01BRWAAAAAAAAAAAAAAAAAAAA0'
const SKETCH_ID = '01BRWAAAAAAAAAAAAAAAAAAAA1'
const CONTESTED_ID = '01BRWAAAAAAAAAAAAAAAAAAAA2'
const DAEMON_OWN_ID = '01BRWAAAAAAAAAAAAAAAAAAAA3'

const operator = { kind: 'human' as const, displayName: 'Yuki' }

/**
 * A record of `count` empty markdown documents, written as raw tree nodes in
 * one commit: the path-checked create walks the whole tree per call, which
 * makes a fixture this size take minutes.
 */
function recordOf(count: number): Uint8Array {
  const record = new LoroDoc()
  const tree = record.getTree(WORKSPACE_TREE_KEY)
  for (let i = 0; i < count; i++) {
    const node = tree.createNode()
    node.data.set('documentId', `01BRWB${crockford(i).padStart(20, '0')}`)
    node.data.set('segment', `d${i}`)
    node.data.set('kind', 'markdown')
    node.data.set('createdAt', 1_000)
    node.data.set('updatedAt', 1_000)
  }
  record.commit()
  return record.export({ mode: 'snapshot' }) as Uint8Array
}

/** `n` in the ULID alphabet, so a minted id is canonical. */
function crockford(n: number): string {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
  let out = ''
  let rest = n
  do {
    out = alphabet[rest % 32] + out
    rest = Math.floor(rest / 32)
  } while (rest > 0)
  return out
}

/**
 * Who wins a contested path is the tree's sibling order: position first,
 * then the lower peer id (measured with a probe over both orderings). The
 * daemon takes peer 1 and the browser 2 by default, so the INCOMING contested
 * document is the shadowed one; the third case swaps them.
 */
function browserRecord(peer = 2n): Uint8Array {
  const doc = new LoroDoc()
  doc.setPeerId(peer)
  // Created FIRST on both sides, so the two contested nodes tie on position
  // and the peer id alone decides — a node created after siblings sorts
  // after them regardless of peer (measured).
  createWorkspaceDocumentAtPath(doc, {
    path: 'contested',
    documentId: CONTESTED_ID,
    kind: 'markdown',
  })
  createWorkspaceDocumentAtPath(doc, {
    path: 'notes/roadmap',
    documentId: ROADMAP_ID,
    kind: 'markdown',
  })
  writeMarkdownBody(documentContainers(doc, ROADMAP_ID), '# roadmap v1')
  createWorkspaceDocumentAtPath(doc, { path: 'sketch', documentId: SKETCH_ID, kind: 'spatial' })
  doc.commit()
  return doc.export({ mode: 'snapshot' }) as Uint8Array
}

/** A daemon workspace that already holds its own documents, one at a path the record also uses. */
function fakes(peer = 1n) {
  const workspaceDoc = new LoroDoc()
  workspaceDoc.setPeerId(peer)
  createWorkspaceDocumentAtPath(workspaceDoc, {
    path: 'contested',
    documentId: DAEMON_OWN_ID,
    kind: 'markdown',
  })
  workspaceDoc.commit()
  const live = new FakeLiveDocuments()
  const versions = new FakeVersionHistory()
  const blobs = new FakeBlobStore()
  let saves = 0
  let evictions = 0
  const workspaceDocuments: WorkspaceDocuments = {
    ...unusedWorkspaceDocuments(),
    async exists() {
      return true
    },
    async get() {
      return workspaceDoc
    },
    async save() {
      saves += 1
    },
    evict() {
      evictions += 1
    },
    evictProjections() {},
  }
  return {
    live: live as LiveDocuments,
    versions,
    blobs,
    workspaceDocuments,
    workspaceDoc,
    saves: () => saves,
    evictions: () => evictions,
    deps: { liveDocuments: live as LiveDocuments, workspaceDocuments, versions, blobStore: blobs },
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

/** A test that builds a ceiling-sized record; measured 1.2 s alone. */
const CEILING_TIMEOUT_MS = 30_000

describe('promoteWorkspace', () => {
  it('merges the record and writes one explicit human checkpoint per promoted document', async () => {
    const fake = fakes()
    const result = await promoteWorkspace(fake.deps, {
      workspaceId: WS,
      snapshot: browserRecord(),
      operator,
    })
    expect(result.kind).toBe('promoted')
    if (result.kind !== 'promoted') return
    expect([...result.recorded].sort()).toEqual([ROADMAP_ID, SKETCH_ID])
    expect(result.shadowed).toEqual([CONTESTED_ID])
    expect(fake.saves()).toBe(1)
    // The merge landed: the record's body is readable in the workspace doc.
    expect(readMarkdownBody(documentContainers(fake.workspaceDoc, ROADMAP_ID))).toBe('# roadmap v1')

    // One row per promoted document, explicit, human.
    expect(fake.versions.saves.map((save) => save.path).sort()).toEqual(['notes/roadmap', 'sketch'])
    for (const save of fake.versions.saves) {
      expect(save.options).toEqual({ auto: false, operator })
    }
  })

  it("writes no row for the target's own documents", async () => {
    const fake = fakes()
    const result = await promoteWorkspace(fake.deps, {
      workspaceId: WS,
      snapshot: browserRecord(),
      operator,
    })
    expect(result.kind).toBe('promoted')
    expect(fake.versions.saves).toHaveLength(2)
    for (const save of fake.versions.saves) {
      expect(save.options).toEqual({ auto: false, operator })
      expect(save.path).not.toBe('contested')
    }
  })

  it("when the promoted document wins the contested path it gets the row and the target's own does not", async () => {
    const fake = fakes(2n)
    const result = await promoteWorkspace(fake.deps, {
      workspaceId: WS,
      snapshot: browserRecord(1n),
      operator,
    })
    expect(result.kind).toBe('promoted')
    if (result.kind !== 'promoted') return
    expect([...result.recorded].sort()).toEqual([ROADMAP_ID, SKETCH_ID, CONTESTED_ID])
    expect(result.shadowed).toEqual([])
    expect(fake.versions.saves.map((save) => save.path).sort()).toEqual([
      'contested',
      'notes/roadmap',
      'sketch',
    ])
  })

  // A move is not an edit: a promoted document reads as last edited when it
  // was, not when it moved.
  it('keeps the updatedAt each promoted document arrived with', async () => {
    const fake = fakes()
    const record = new LoroDoc()
    record.setPeerId(2n)
    createWorkspaceDocumentAtPath(record, {
      path: 'notes/roadmap',
      documentId: ROADMAP_ID,
      kind: 'markdown',
      createdAt: 1_000,
    })
    writeMarkdownBody(documentContainers(record, ROADMAP_ID), '# roadmap v1')
    record.commit()

    await promoteWorkspace(fake.deps, {
      workspaceId: WS,
      snapshot: record.export({ mode: 'snapshot' }) as Uint8Array,
      operator,
    })

    expect(resolveWorkspaceDocumentById(fake.workspaceDoc, ROADMAP_ID)?.updatedAt).toBe(1_000)
  })

  it('refuses bytes that are not a Loro snapshot before touching the workspace', async () => {
    const fake = fakes()
    const result = await promoteWorkspace(fake.deps, {
      workspaceId: WS,
      snapshot: new Uint8Array([1, 2, 3, 4]),
      operator,
    })
    expect(result).toEqual({ kind: 'malformed-snapshot' })
    expect(fake.saves()).toBe(0)
    expect(fake.versions.saves).toEqual([])
  })

  it('an engine trap in the merge drops the target record and is not called malformed', async () => {
    const fake = fakes()
    vi.spyOn(fake.workspaceDoc, 'import').mockImplementation(() => {
      throw Object.assign(new Error('unreachable'), { name: 'RuntimeError' })
    })
    const dropped: string[] = []
    const failure = await promoteWorkspace(
      {
        liveDocuments: fake.live,
        workspaceDocuments: {
          ...fake.workspaceDocuments,
          evict: () => dropped.push('record'),
          evictProjections: () => dropped.push('projections'),
        },
        versions: fake.versions,
        blobStore: fake.blobs,
      },
      { workspaceId: WS, snapshot: browserRecord(), operator },
    ).catch((err: unknown) => err)
    expect(failure).toBeInstanceOf(DocumentEngineTrapError)
    expect(dropped).toEqual(['record', 'projections'])
    expect(fake.saves()).toBe(0)
    expect(fake.versions.saves).toEqual([])
  })

  it('an engine trap on the incoming record is not called malformed either', async () => {
    const fake = fakes()
    // The first import promote makes is into its own throwaway copy of the record.
    vi.spyOn(LoroDoc.prototype, 'import').mockImplementationOnce(() => {
      throw Object.assign(new Error('unreachable'), { name: 'RuntimeError' })
    })
    const failure = await promoteWorkspace(fake.deps, {
      workspaceId: WS,
      snapshot: browserRecord(),
      operator,
    }).catch((err: unknown) => err)
    expect(failure).toBeInstanceOf(DocumentEngineTrapError)
    expect(fake.saves()).toBe(0)
  })

  it('refuses a record holding a path outside the document-path grammar and merges none of it', async () => {
    const fake = fakes()
    const record = new LoroDoc()
    record.setPeerId(2n)
    createWorkspaceDocumentAtPath(record, {
      path: 'sketch',
      documentId: SKETCH_ID,
      kind: 'spatial',
    })
    createWorkspaceDocumentAtPath(record, {
      path: 'Meeting notes',
      documentId: ROADMAP_ID,
      kind: 'markdown',
    })
    record.commit()
    const refusal = await promoteWorkspace(fake.deps, {
      workspaceId: WS,
      snapshot: record.export({ mode: 'snapshot' }),
      operator,
    }).catch((err: unknown) => err)
    // The merge's own refusal: one judgement of a path for promote and sync alike.
    expect(refusal).toBeInstanceOf(OffGrammarPathError)
    expect(refusal).toMatchObject({ paths: ['Meeting notes'] })
    // Nothing saved, and the instance the merge touched is dropped, so the
    // next read rebuilds the record from what was stored.
    expect(fake.saves()).toBe(0)
    expect(fake.evictions()).toBe(1)
    expect(fake.versions.saves).toEqual([])
  })

  /**
   * The merge sees only a container and a key; the promoted record is what
   * can say which document holds it, and a person fixing the record needs
   * the document, not a key they never see. One case per breach shape, keyed
   * by the table every keeper answers them from, so a shape added there
   * without a case here fails to compile.
   */
  type Board = ReturnType<typeof documentContainers>
  const nodeDataOf = (record: LoroDoc, documentId: string): LoroTreeNode['data'] => {
    const node = record
      .getTree('tree')
      .getNodes()
      .find((candidate) => candidate.data.get('documentId') === documentId)
    if (node === undefined) throw new Error(`no node holds ${documentId}`)
    return node.data
  }
  const breachCases = {
    run: {
      at: 'notes/roadmap',
      write: (doc: Board) => doc.getText('body').insert(0, 'x'.repeat(MARKDOWN_MAX_CHARS + 1)),
    },
    runs: {
      // Written into the roadmap, but a runs cost is the whole update's, so
      // the refusal names no document.
      at: 'notes/roadmap',
      unscoped: true,
      // Two runs each within the limit, scattered so they never join, then
      // cut back so the body itself is short: only their cost refuses them.
      write: (doc: Board) => {
        const piece = 'x'.repeat((MARKDOWN_MAX_CHARS * 3) / 4)
        const body = doc.getText('body')
        body.insert(0, piece)
        body.insert(0, piece)
        body.delete(0, 2 * piece.length)
      },
    },
    body: {
      at: 'notes/roadmap',
      // Pieces that never join into one run (each lands before the last),
      // together past the limit; many short ones keep the replay cheap.
      write: (doc: Board) => {
        const piece = 'x'.repeat(MARKDOWN_MAX_CHARS / 16 + 1)
        for (let i = 0; i < 16; i += 1) doc.getText('body').insert(0, piece)
      },
    },
    'node-text': {
      at: 'sketch',
      write: (board: Board) =>
        writeSpatialNode(
          board,
          textNode({
            id: 'big',
            x: 0,
            y: 0,
            width: 200,
            height: 100,
            text: 'x'.repeat(NODE_TEXT_MAX_CHARS + 1),
          }),
        ),
    },
    'node-location': {
      at: 'sketch',
      write: (board: Board) =>
        writeSpatialNode(
          board,
          fileNode({
            id: 'ref',
            x: 0,
            y: 0,
            width: 200,
            height: 60,
            file: 'x'.repeat(NODE_LOCATION_MAX_CHARS + 1),
          }),
        ),
    },
    label: {
      at: 'sketch',
      write: (board: Board) =>
        writeSpatialEdge(board, {
          id: 'e1',
          from: { node: 'a' },
          to: { node: 'b' },
          label: 'x'.repeat(LABEL_MAX_CHARS + 1),
        }),
    },
    'comment-message': {
      at: 'sketch',
      write: (board: Board) =>
        writeCommentThread(board, {
          id: 't1',
          anchor: { kind: 'document' },
          status: 'open',
          messages: [{ id: 'm1', body: 'x'.repeat(COMMENT_MESSAGE_MAX_CHARS + 1) }],
        }),
    },
    tags: {
      at: 'sketch',
      write: (board: Board) => board.getMap('canvas').set('tags', ['x'.repeat(TAG_MAX_CHARS + 1)]),
    },
    'container-name': {
      at: 'sketch',
      // A thread is a container named by its id, so an id this long names it past the bound.
      write: (board: Board) =>
        writeCommentThread(board, {
          id: 't'.repeat(CONTAINER_NAME_MAX_CHARS),
          anchor: { kind: 'document' },
          status: 'open',
          messages: [{ id: 'm1', body: 'hello' }],
        }),
    },
    'canvas-size': {
      at: 'sketch',
      write: (board: Board) =>
        writeSpatialCanvas(board, {
          nodes: Array.from({ length: CANVAS_MAX_NODES + 1 }, (_, i) =>
            textNode({ id: `n${i}`, x: 0, y: 0, width: 100, height: 40, text: 'n' }),
          ),
          edges: [],
        }),
    },
    'thread-anchor': {
      at: 'sketch',
      // Resolved, so the open-thread ceiling does not see it: the anchor bound must.
      write: (board: Board) =>
        writeCommentThread(board, {
          id: 't1',
          anchor: {
            kind: 'spatial',
            nodeIds: Array.from({ length: CANVAS_MAX_NODES + 1 }, (_, i) => `n${i}`),
            x: 0,
            y: 0,
          },
          status: 'resolved',
          messages: [{ id: 'm1', body: 'hello' }],
        }),
    },
    'anchor-quote': {
      at: 'notes/roadmap',
      // Resolved, so the open-thread ceiling does not see it: the quote bound must.
      write: (doc: Board) =>
        writeCommentThread(doc, {
          id: 't1',
          anchor: {
            kind: 'text',
            quote: { exact: 'q'.repeat(TEXT_ANCHOR_QUOTE_MAX_CHARS + 1) },
            start: 0,
            end: TEXT_ANCHOR_QUOTE_MAX_CHARS + 1,
          },
          status: 'resolved',
          messages: [{ id: 'm1', body: 'hello' }],
        }),
    },
    'open-threads': {
      at: 'notes/roadmap',
      write: (doc: Board) => {
        for (let i = 0; i <= DOCUMENT_MAX_OPEN_THREADS; i += 1) {
          writeCommentThread(doc, {
            id: `t${i}`,
            anchor: { kind: 'document' },
            status: 'open',
            messages: [{ id: 'm1', body: 'hello' }],
          })
        }
      },
    },
    'open-changes': {
      at: 'sketch',
      write: (board: Board) =>
        writeProposal(board, {
          id: 'p1',
          changes: Array.from({ length: DOCUMENT_MAX_OPEN_CHANGES + 1 }, (_, i) => ({
            id: `ch${i}`,
            status: 'open' as const,
            op: 'node.add' as const,
            node: textNode({ id: `n${i}`, x: 0, y: 0, width: 100, height: 40, text: 'n' }),
          })),
        }),
    },
    'content-root': {
      at: 'sketch',
      status: 400,
      onRecord: (record: LoroDoc, documentId: string) =>
        nodeDataOf(record, documentId).set('nodes', 1),
    },
    'unattached-container': {
      at: 'sketch',
      status: 409,
      onRecord: (record: LoroDoc, documentId: string) => {
        // Q writes into the map P's first op will create, before P has created it.
        const P = '777'
        const orphan = new LoroDoc()
        orphan.setPeerId(888n)
        // A string, since the typed form has no spelling for uncompressed peer ids.
        orphan.importJsonUpdates(
          JSON.stringify({
            schema_version: 1,
            start_version: {},
            peers: null,
            changes: [
              {
                id: '0@888',
                timestamp: 0,
                deps: [],
                lamport: 0,
                msg: null,
                ops: [
                  {
                    container: `cid:0@${P}:Map`,
                    content: { type: 'insert', key: 'n1', value: { id: 'n1' } },
                    counter: 0,
                  },
                ],
              },
            ],
          }),
        )
        record.commit()
        const attacher = record.fork()
        attacher.setPeerId(BigInt(P))
        nodeDataOf(attacher, documentId).setContainer('nodes', new LoroMap())
        attacher.commit()
        record.import(orphan.export({ mode: 'update' }))
        record.import(attacher.export({ mode: 'update', from: record.oplogVersion() }))
      },
    },
  } satisfies Record<
    keyof typeof SYNC_TEXT_BREACH_CODES,
    {
      at: string
      unscoped?: true
      status?: number
      write?: (doc: Board) => void
      onRecord?: (record: LoroDoc, documentId: string) => void
    }
  >

  it.each(
    Object.keys(SYNC_TEXT_BREACH_CODES) as (keyof typeof SYNC_TEXT_BREACH_CODES)[],
  )('refuses a record whose document holds a %s breach, naming the document that holds it', async (shape) => {
    const { at } = breachCases[shape]
    const fake = fakes()
    const record = new LoroDoc()
    record.setPeerId(2n)
    createWorkspaceDocumentAtPath(record, {
      path: 'notes/roadmap',
      documentId: ROADMAP_ID,
      kind: 'markdown',
    })
    createWorkspaceDocumentAtPath(record, {
      path: 'sketch',
      documentId: SKETCH_ID,
      kind: 'spatial',
    })
    const documentId = at === 'sketch' ? SKETCH_ID : ROADMAP_ID
    const breachCase: {
      unscoped?: true
      status?: number
      write?: (doc: Board) => void
      onRecord?: (record: LoroDoc, documentId: string) => void
    } = breachCases[shape]
    breachCase.write?.(documentContainers(record, documentId))
    breachCase.onRecord?.(record, documentId)
    record.commit()
    const refusal = await promoteWorkspace(fake.deps, {
      workspaceId: WS,
      snapshot: record.export({ mode: 'snapshot' }),
      operator,
    }).catch((err: unknown) => err)
    expect(syncWriteAnswer(refusal)).toEqual({
      code: SYNC_TEXT_BREACH_CODES[shape],
      status: breachCase.status ?? 413,
    })
    expect(refusal).toMatchObject({ breach: { shape } })
    if (breachCase.unscoped) {
      expect((refusal as { at?: unknown }).at).toBeUndefined()
      expect((refusal as Error).message).not.toContain(at)
    } else {
      expect(refusal).toMatchObject({ at: { path: at } })
      expect((refusal as Error).message).toMatch(new RegExp(`^The document at "${at}" `))
    }
    expect(fake.saves()).toBe(0)
  })

  it('refuses a runs breach spread over two documents without naming either one', async () => {
    const fake = fakes()
    const record = new LoroDoc()
    record.setPeerId(2n)
    createWorkspaceDocumentAtPath(record, {
      path: 'notes/roadmap',
      documentId: ROADMAP_ID,
      kind: 'markdown',
    })
    createWorkspaceDocumentAtPath(record, {
      path: 'notes/retro',
      documentId: CONTESTED_ID,
      kind: 'markdown',
    })
    // One run per document, each within the limit and each body short of
    // it: only their cost summed over the update refuses them.
    const piece = 'x'.repeat((MARKDOWN_MAX_CHARS * 3) / 4)
    documentContainers(record, ROADMAP_ID).getText('body').insert(0, piece)
    documentContainers(record, CONTESTED_ID).getText('body').insert(0, piece)
    record.commit()
    const refusal = await promoteWorkspace(fake.deps, {
      workspaceId: WS,
      snapshot: record.export({ mode: 'snapshot' }),
      operator,
    }).catch((err: unknown) => err)
    expect(refusal).toMatchObject({ breach: { shape: 'runs' } })
    expect((refusal as { at?: unknown }).at).toBeUndefined()
    const { message } = refusal as Error
    expect(message).not.toContain('notes/roadmap')
    expect(message).not.toContain('notes/retro')
    expect(message).toMatch(/^This update makes /)
    expect(fake.saves()).toBe(0)
  })

  it('refuses a record whose orphan write has no attaching change, without a path lookup', async () => {
    const fake = fakes()
    const record = new LoroDoc()
    record.setPeerId(2n)
    createWorkspaceDocumentAtPath(record, {
      path: 'sketch',
      documentId: SKETCH_ID,
      kind: 'spatial',
    })
    record.commit()
    // A write into a map peer 777's first op would create; that op never arrives.
    const orphan = new LoroDoc()
    orphan.setPeerId(888n)
    orphan.importJsonUpdates(
      JSON.stringify({
        schema_version: 1,
        start_version: {},
        peers: null,
        changes: [
          {
            id: '0@888',
            timestamp: 0,
            deps: [],
            lamport: 0,
            msg: null,
            ops: [
              {
                container: 'cid:0@777:Map',
                content: { type: 'insert', key: 'n1', value: { id: 'n1' } },
                counter: 0,
              },
            ],
          },
        ],
      }),
    )
    record.import(orphan.export({ mode: 'update' }))
    const refusal = await promoteWorkspace(fake.deps, {
      workspaceId: WS,
      snapshot: record.export({ mode: 'snapshot' }),
      operator,
    }).catch((err: unknown) => err)
    expect(syncWriteAnswer(refusal)).toEqual({ code: 'causal_gap', status: 409 })
    expect(refusal).toMatchObject({ breach: { shape: 'unattached-container' } })
    expect(refusal).not.toHaveProperty('at.path')
    expect(fake.saves()).toBe(0)
  })

  // A List root also named `tree` puts a `body` at `['tree', 0, 'body']`, a
  // document body's path by name — and `0` is no tree node's id.
  it('refuses an oversized body under a root named like the tree without naming a document', async () => {
    const fake = fakes()
    const record = new LoroDoc()
    record.setPeerId(2n)
    createWorkspaceDocumentAtPath(record, {
      path: 'sketch',
      documentId: SKETCH_ID,
      kind: 'spatial',
    })
    record
      .getList(WORKSPACE_TREE_KEY)
      .insertContainer(0, new LoroMap())
      .setContainer(MARKDOWN_BODY_KEY, new LoroText())
      .insert(0, 'x'.repeat(MARKDOWN_MAX_CHARS + 1))
    record.commit()
    const refusal = await promoteWorkspace(fake.deps, {
      workspaceId: WS,
      snapshot: record.export({ mode: 'snapshot' }),
      operator,
    }).catch((err: unknown) => err)
    expect(syncWriteAnswer(refusal)).toMatchObject({ status: 413 })
    expect(refusal).not.toHaveProperty('at.path')
    expect(fake.saves()).toBe(0)
  })

  it('refuses a record holding more documents than a promote carries, before merging any of it', async () => {
    const fake = fakes()
    const documents = WORKSPACE_MAX_DOCUMENTS + 1
    const result = await promoteWorkspace(fake.deps, {
      workspaceId: WS,
      snapshot: recordOf(documents),
      operator,
    })
    expect(result).toEqual({
      kind: 'too-many-documents',
      documents,
      limit: WORKSPACE_MAX_DOCUMENTS,
    })
    expect(fake.saves()).toBe(0)
    expect(fake.versions.saves).toHaveLength(0)
  })

  // The target already holds one document of its own, so this record brings
  // the merged workspace exactly to the ceiling. A ceiling-sized record:
  // 1.2 s alone, past the 5 s default under a full parallel run.
  it('promotes a record that brings the workspace exactly to the document ceiling', {
    timeout: CEILING_TIMEOUT_MS,
  }, async () => {
    const fake = fakes()
    const result = await promoteWorkspace(fake.deps, {
      workspaceId: WS,
      snapshot: recordOf(WORKSPACE_MAX_DOCUMENTS - 1),
      operator,
    })
    expect(result.kind).toBe('promoted')
    expect(fake.versions.saves).toHaveLength(WORKSPACE_MAX_DOCUMENTS - 1)
  })

  it('lands a record into a document whose history is full, skipping only its version', async () => {
    const fake = fakes()
    fake.versions.save = async () => {
      throw new TooManyVersionsError(200)
    }
    const result = await promoteWorkspace(fake.deps, {
      workspaceId: WS,
      snapshot: recordOf(2),
      operator,
    })
    expect(result.kind).toBe('promoted')
    expect(result.kind === 'promoted' ? result.recorded : null).toEqual([])
    expect(fake.saves()).toBeGreaterThan(0)
  })

  it('refuses a record within the ceiling whose merge would take the workspace past it', {
    timeout: CEILING_TIMEOUT_MS,
  }, async () => {
    const fake = fakes()
    const refusal = await promoteWorkspace(fake.deps, {
      workspaceId: WS,
      snapshot: recordOf(WORKSPACE_MAX_DOCUMENTS),
      operator,
    }).catch((err: unknown) => err)
    expect(syncWriteAnswer(refusal)).toEqual({ code: 'too_many_documents', status: 413 })
    expect(fake.saves()).toBe(0)
    expect(fake.versions.saves).toHaveLength(0)
  })
})
