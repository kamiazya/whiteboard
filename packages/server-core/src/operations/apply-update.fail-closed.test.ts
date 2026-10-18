/**
 * A sync update whose judgement does not complete keeps nothing of itself.
 *
 * The import lands in the CACHED record before any judge reads it, so a judge
 * that throws — rather than refusing — leaves the cached instance holding
 * operations nobody judged. Kept, they ride the next ordinary save by anyone
 * and its fan-out. Each case here makes the judgement throw after the import,
 * then sends an ordinary edit and reads what was STORED.
 */
import {
  createWorkspaceDocumentAtPath,
  documentContainers,
  readMarkdownBody,
  WORKSPACE_TREE_KEY,
  writeMarkdownBody,
} from '@kamiazya/whiteboard-loro-adapter'
import { LoroDoc, type LoroTreeNode } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import type { LiveDocuments, WorkspaceDocuments } from '../server-deps.js'
import { StoredDoc } from '../test-utils/stored-doc.js'
import { unusedLiveDocuments } from '../test-utils/unused-live-documents.js'
import { unusedWorkspaceDocuments } from '../test-utils/unused-workspace-documents.js'
import { applyDocumentUpdate } from './apply-document-update.js'
import { applyWorkspaceDocumentUpdate } from './apply-workspace-document-update.js'

const WS = 'ws-1'
const DOC_ID = '01BRWAAAAAAAAAAAAAAAAAAAA0'
const NEW_ID = '01BRWAAAAAAAAAAAAAAAAAAAA6'

/**
 * Deep enough that a recursive walk of the tree overflowed the stack in this
 * project: measured on loro-crdt 1.13.6 under vitest, 3500 folders did not
 * and 5000 did, as a wasm `memory access out of bounds`. A chain this deep
 * costs about a second to bring into the state, hence the timeout below.
 */
const OVERFLOWING_DEPTH = 5000
const DEEP_CHAIN_TIMEOUT_MS = 30_000

function workspaceSeed(): LoroDoc {
  const doc = new LoroDoc()
  createWorkspaceDocumentAtPath(doc, { path: 'notes', documentId: DOC_ID, kind: 'markdown' })
  writeMarkdownBody(documentContainers(doc, DOC_ID), 'body')
  doc.commit()
  return doc
}

function workspaceDeps(store: StoredDoc) {
  const workspaceDocuments: WorkspaceDocuments = {
    ...unusedWorkspaceDocuments(),
    get: async () => store.get(),
    save: async (_workspaceId, doc) => store.save(doc),
    evict: () => store.evict(),
    evictProjections: () => {},
  }
  const liveDocuments: LiveDocuments = {
    ...unusedLiveDocuments(),
    withWriteLock: (_workspaceId, fn) => fn(),
  }
  return { liveDocuments, workspaceDocuments }
}

/** What a client holding `base` would send after `edit`. */
function updateFrom(base: LoroDoc, edit: (doc: LoroDoc) => void): Uint8Array {
  const client = base.fork()
  const from = client.oplogVersion()
  edit(client)
  client.commit()
  return client.export({ mode: 'update', from })
}

/** A chain of folders `depth` deep, written node by node as a client could. */
function folderChain(doc: LoroDoc, depth: number): void {
  let parent: LoroTreeNode | undefined
  for (let i = 0; i < depth; i++) {
    const node =
      parent === undefined ? doc.getTree(WORKSPACE_TREE_KEY).createNode() : parent.createNode()
    node.data.set('segment', 'a')
    parent = node
  }
}

/**
 * Makes the next read of `doc`'s imported operations throw, once — as any
 * judge might — and then reads as before.
 */
function failNextJudgement(doc: LoroDoc): void {
  const real = doc.exportJsonUpdates.bind(doc)
  doc.exportJsonUpdates = () => {
    doc.exportJsonUpdates = real
    throw new RangeError('judge failed')
  }
}

/** What the stored record holds, read from storage rather than the cache. */
function stored(store: StoredDoc): LoroDoc {
  store.evict()
  return store.get()
}

const storedBody = (store: StoredDoc) => readMarkdownBody(documentContainers(stored(store), DOC_ID))

describe('a workspace-document sync update whose judgement throws after the import', () => {
  it(
    'a deep folder chain beside a new document, from a caller who may not place documents, leaves nothing stored',
    async () => {
      const seed = workspaceSeed()
      const store = new StoredDoc(seed)
      const nodesBefore = seed.getTree(WORKSPACE_TREE_KEY).getNodes().length
      const update = updateFrom(seed, (doc) => {
        createWorkspaceDocumentAtPath(doc, {
          path: 'planted',
          documentId: NEW_ID,
          kind: 'markdown',
        })
        folderChain(doc, OVERFLOWING_DEPTH)
      })

      const outcome = await applyWorkspaceDocumentUpdate(workspaceDeps(store), {
        workspaceId: WS,
        update,
        mayPlaceDocuments: false,
      }).then(
        (result) => result.kind,
        (err: unknown) => err,
      )
      expect(outcome).not.toBe('applied')

      // An ordinary edit from a client that never saw the refused update.
      await expect(
        applyWorkspaceDocumentUpdate(workspaceDeps(store), {
          workspaceId: WS,
          update: updateFrom(seed, (doc) =>
            documentContainers(doc, DOC_ID).getText('body').insert(0, 'more '),
          ),
        }),
      ).resolves.toMatchObject({ kind: 'applied' })

      const record = stored(store)
      expect(record.getTree(WORKSPACE_TREE_KEY).getNodes()).toHaveLength(nodesBefore)
      expect(readMarkdownBody(documentContainers(record, DOC_ID))).toBe('more body')
    },
    DEEP_CHAIN_TIMEOUT_MS,
  )

  it('a judge that throws an ordinary error leaves nothing of the update stored', async () => {
    const seed = workspaceSeed()
    const store = new StoredDoc(seed)
    failNextJudgement(store.get())

    const outcome = await applyWorkspaceDocumentUpdate(workspaceDeps(store), {
      workspaceId: WS,
      update: updateFrom(seed, (doc) =>
        documentContainers(doc, DOC_ID).getText('body').insert(0, 'unjudged '),
      ),
    }).then(
      (result) => result.kind,
      (err: unknown) => err,
    )
    expect(outcome).not.toBe('applied')

    await applyWorkspaceDocumentUpdate(workspaceDeps(store), {
      workspaceId: WS,
      update: updateFrom(seed, (doc) => doc.getMap('workspaceMeta').set('lastCompactedAt', 1)),
    })

    expect(storedBody(store)).toBe('body')
  })
})

describe('a workspace-document sync update whose save fails', () => {
  it('leaves nothing of the update for the next save to persist', async () => {
    const seed = workspaceSeed()
    const store = new StoredDoc(seed)
    const deps = workspaceDeps(store)
    const save = deps.workspaceDocuments.save
    deps.workspaceDocuments.save = async () => {
      deps.workspaceDocuments.save = save
      throw new Error('disk full')
    }

    await expect(
      applyWorkspaceDocumentUpdate(deps, {
        workspaceId: WS,
        update: updateFrom(seed, (doc) =>
          documentContainers(doc, DOC_ID).getText('body').insert(0, 'unsaved '),
        ),
      }),
    ).rejects.toThrow('disk full')
    await applyWorkspaceDocumentUpdate(deps, {
      workspaceId: WS,
      update: updateFrom(seed, (doc) => doc.getMap('workspaceMeta').set('lastCompactedAt', 1)),
    })

    expect(storedBody(store)).toBe('body')
  })
})

describe('a per-document sync update whose judgement throws after the import', () => {
  it('leaves nothing of the update in the cached document', async () => {
    const seed = new LoroDoc()
    writeMarkdownBody(seed, 'body')
    seed.commit()
    const store = new StoredDoc(seed)
    failNextJudgement(store.get())
    const liveDocuments: LiveDocuments = {
      ...unusedLiveDocuments(),
      withWriteLock: (_workspaceId, fn) => fn(),
      get: async () => store.get(),
      save: async (_workspaceId, _path, doc) => store.save(doc),
      evict: () => store.evict(),
    }

    await expect(
      applyDocumentUpdate(
        { liveDocuments },
        {
          workspaceId: WS,
          path: 'notes',
          update: updateFrom(seed, (doc) => doc.getText('body').insert(0, 'unjudged ')),
        },
      ),
    ).rejects.toThrow()

    expect(store.saves).toBe(0)
    // What the next writer would diff against and save: its oplog, which a
    // detached import fills while the state still reads as before.
    expect(store.get().oplogVersion().compare(seed.oplogVersion())).toBe(0)
  })
})
