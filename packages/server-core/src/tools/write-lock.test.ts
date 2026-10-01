import {
  readSpatialCanvas,
  writeCoreFacets,
  writeDocumentKind,
  writeMarkdownBody,
  writeSpatialCanvas,
} from '@kamiazya/whiteboard-loro-adapter'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { reassembleSnapshot } from '@kamiazya/whiteboard-ports'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import type { ServerDeps } from '../server-deps.js'
import {
  FakeDocumentStore,
  registerDocumentInWorkspace,
  seedDoc,
} from '../test-utils/fake-document-store.js'
import { FakeLiveDocuments } from '../test-utils/fake-live-documents.js'
import { FakeVersionHistory } from '../test-utils/fake-version-history.js'
import { makeTestDeps } from '../test-utils/make-test-deps.js'
import { createBodyEditTool } from './body-edit.js'
import { createCanvasEditTool } from './canvas-edit.js'
import { createFacetSetTool } from './facet-set.js'
import { linkifyMentions } from './linkify-mentions.js'
import { createThreadEditTool } from './thread-edit.js'
import { createVersionSaveTool } from './version-save.js'

const WORKSPACE_ID = 'ws-1'
const BOARD_ID = '01H8XJZ9K5N4M3P2Q1R0S9T8V7'
const NOTE_ID = '01H8XJZ9K5N4M3P2Q1R0S9T8V8'

const CANVAS: SpatialCanvas = {
  nodes: [
    textNode({ id: 'n1', x: 0, y: 0, width: 100, height: 50, text: 'a' }),
    textNode({ id: 'n2', x: 200, y: 0, width: 100, height: 50, text: 'b' }),
  ],
  edges: [],
}

/**
 * The seam's lock as a REAL per-workspace queue, so two callers that both
 * take it run one after the other — which is what the daemon's own
 * implementation does, and what `FakeLiveDocuments`'s pass-through cannot
 * show. Counts the holds too, so a tool that never takes it is visible.
 */
class SerializingLiveDocuments extends FakeLiveDocuments {
  holds = 0
  private tail = Promise.resolve()
  override withWriteLock<T>(_workspaceId: string, fn: () => Promise<T>): Promise<T> {
    this.holds += 1
    const run = this.tail.then(fn)
    this.tail = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }
}

async function makeDeps() {
  const store = new FakeDocumentStore()
  await seedDoc(store, BOARD_ID, (doc) => {
    writeDocumentKind(doc, 'spatial')
    writeSpatialCanvas(doc, CANVAS)
  })
  await registerDocumentInWorkspace(store, WORKSPACE_ID, BOARD_ID, 'board')
  await seedDoc(store, NOTE_ID, (doc) => {
    writeDocumentKind(doc, 'markdown')
    writeCoreFacets(doc, { type: 'note', tags: [] })
    writeMarkdownBody(doc, 'A note about the Board.\n')
  })
  store.documentIndex.seed({
    workspaceId: WORKSPACE_ID,
    documentId: NOTE_ID,
    path: 'note',
    kind: 'markdown',
    name: 'Note',
  })
  // Named, and named in the note's prose, so linkify has a mention to find.
  store.documentIndex.seed({
    workspaceId: WORKSPACE_ID,
    documentId: BOARD_ID,
    path: 'board',
    kind: 'spatial',
    name: 'Board',
  })
  const liveDocuments = new SerializingLiveDocuments()
  const deps: ServerDeps = makeTestDeps({
    documentStore: store,
    documentIndex: store.documentIndex,
    liveDocuments,
    versions: new FakeVersionHistory(),
  })
  return { deps, store, liveDocuments }
}

async function storedPositions(store: FakeDocumentStore) {
  const stored = await store.loadSnapshot({
    docRef: { kind: 'document', workspaceId: WORKSPACE_ID, documentId: BOARD_ID },
  })
  if (stored === null) throw new Error('no snapshot')
  const doc = new LoroDoc()
  doc.import(reassembleSnapshot(stored.manifest, stored.chunks))
  return Object.fromEntries(readSpatialCanvas(doc).nodes.map((node) => [node.id, node.x]))
}

// Every mutating tool is a load-modify-save, and the store's save writes
// unconditionally: two calls that load the same base before either saves
// drop one of the changes. The lock that prevents it used to be taken by
// the MCP adapter around each tool, so the same operation reached over HTTP
// — `linkify-mentions` is one — ran with no lock at all, and an agent write
// and a browser update to one document were serialised on two different
// keys. ADR-0018 §4: an adapter translates, it does not decide; the lock
// is the operation's, through the seam it already has.
describe('a mutating tool holds the workspace write lock around its load-modify-save', () => {
  it('two concurrent canvas edits: the second never reads a base the first had not written', async () => {
    const { deps, store } = await makeDeps()
    // Record the store traffic and assert its shape: interleaved
    // load/load/save/save is the lost update; load/save/load/save is the
    // lock working. (A barrier cannot be used: once serialised, the second
    // load waits for the first save, and waiting for both loads deadlocks.)
    const events: string[] = []
    const load = store.loadSnapshot.bind(store)
    const save = store.saveSnapshot.bind(store)
    store.loadSnapshot = async (input) => {
      events.push('load')
      return load(input)
    }
    store.saveSnapshot = async (input) => {
      events.push('save')
      return save(input)
    }

    const tool = createCanvasEditTool(deps)
    await Promise.all([
      tool.execute({
        workspaceId: WORKSPACE_ID,
        documentId: BOARD_ID,
        mode: 'apply',
        ops: [{ op: 'node.patch', id: 'n1', patch: { x: 11 } }],
      }),
      tool.execute({
        workspaceId: WORKSPACE_ID,
        documentId: BOARD_ID,
        mode: 'apply',
        ops: [{ op: 'node.patch', id: 'n2', patch: { x: 22 } }],
      }),
    ])

    const firstSave = events.indexOf('save')
    const secondLoad = events.indexOf('load', events.indexOf('load') + 1)
    expect(firstSave, `store traffic was ${events.join(',')}`).toBeGreaterThan(-1)
    expect(secondLoad, `store traffic was ${events.join(',')}`).toBeGreaterThan(firstSave)
    expect(await storedPositions(store)).toEqual({ n1: 11, n2: 22 })
  })

  // One row per tool that writes a document through the store. A tool
  // added to the server and not to this table is not caught here; what is
  // caught is one of THESE losing its lock in a refactor.
  const WRITERS: Record<string, (deps: ServerDeps) => Promise<unknown>> = {
    wb_canvas_edit: (deps) =>
      createCanvasEditTool(deps).execute({
        workspaceId: WORKSPACE_ID,
        documentId: BOARD_ID,
        mode: 'apply',
        ops: [{ op: 'node.patch', id: 'n1', patch: { x: 5 } }],
      }),
    wb_thread_edit: (deps) =>
      createThreadEditTool(deps).execute({
        workspaceId: WORKSPACE_ID,
        ops: [
          {
            op: 'thread.add',
            anchor: { kind: 'text', quote: { exact: 'note' }, start: 2, end: 6 },
            body: 'why?',
            author: 'agent:reviewer',
          },
        ],
        documentId: NOTE_ID,
      }),
    wb_body_edit: (deps) =>
      createBodyEditTool(deps).execute({
        workspaceId: WORKSPACE_ID,
        documentId: NOTE_ID,
        mode: 'apply',
        ops: [
          {
            id: 'c1',
            op: 'body.replace',
            anchor: { kind: 'text', quote: { exact: 'A note' }, start: 0, end: 6 },
            text: 'The note',
            assumed: 'A note',
          },
        ],
      }),
    wb_facet_set: (deps) =>
      createFacetSetTool(deps).execute({
        workspaceId: WORKSPACE_ID,
        documentIds: [NOTE_ID],
        tags: { add: ['seed'] },
      }),
    wb_version_save: (deps) =>
      createVersionSaveTool(deps).execute({
        workspaceId: WORKSPACE_ID,
        documentIds: [BOARD_ID],
        label: 'checkpoint',
      }),
    'linkify-mentions': (deps) =>
      linkifyMentions(deps, {
        workspaceId: WORKSPACE_ID,
        documentId: NOTE_ID,
        targetDocumentId: BOARD_ID,
      }),
  }

  for (const [name, write] of Object.entries(WRITERS)) {
    it(`${name} takes the lock`, async () => {
      const { deps, liveDocuments } = await makeDeps()
      await write(deps)
      expect(liveDocuments.holds).toBeGreaterThanOrEqual(1)
    })
  }
})
