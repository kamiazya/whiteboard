/**
 * What a workspace-document sync update may do with FOLDERS — the nodes that
 * hold a path component and no document. Every listing walks them, and a
 * client creates them as freely as documents, so they are held to the path
 * grammar documents are held to and to a ceiling of their own.
 */
import {
  createWorkspaceDocumentAtPath,
  documentContainers,
  readWorkspaceNodes,
  WORKSPACE_TREE_KEY,
  writeMarkdownBody,
} from '@kamiazya/whiteboard-loro-adapter'
import { DOCUMENT_PATH_MAX_LENGTH } from '@kamiazya/whiteboard-model'
import { LoroDoc, type LoroTreeNode } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import type { LiveDocuments, WorkspaceDocuments } from '../server-deps.js'
import { StoredDoc } from '../test-utils/stored-doc.js'
import { unusedLiveDocuments } from '../test-utils/unused-live-documents.js'
import { unusedWorkspaceDocuments } from '../test-utils/unused-workspace-documents.js'
import { applyWorkspaceDocumentUpdate } from './apply-workspace-document-update.js'
import {
  OffGrammarPathError,
  syncWriteAnswer,
  TooManyFoldersError,
  WORKSPACE_MAX_FOLDERS,
} from './sync-write-refusals.js'

const WS = 'ws-1'
const DOC_ID = '01BRWAAAAAAAAAAAAAAAAAAAA0'

function seed(edit?: (doc: LoroDoc) => void): StoredDoc {
  const doc = new LoroDoc()
  createWorkspaceDocumentAtPath(doc, { path: 'notes', documentId: DOC_ID, kind: 'markdown' })
  writeMarkdownBody(documentContainers(doc, DOC_ID), 'body')
  edit?.(doc)
  doc.commit()
  return new StoredDoc(doc)
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

function send(store: StoredDoc, edit: (doc: LoroDoc) => void) {
  const client = store.get().fork()
  const from = client.oplogVersion()
  edit(client)
  client.commit()
  return applyWorkspaceDocumentUpdate(workspaceDeps(store), {
    workspaceId: WS,
    update: client.export({ mode: 'update', from }),
  }).catch((err: unknown) => err)
}

/** A chain of folders, each segment `segment`, `depth` deep from the root. */
function folderChain(doc: LoroDoc, depth: number, segment = 'a'): void {
  let parent: LoroTreeNode | undefined
  for (let level = 0; level < depth; level++) {
    const node =
      parent === undefined ? doc.getTree(WORKSPACE_TREE_KEY).createNode() : parent.createNode()
    node.data.set('segment', segment)
    parent = node
  }
}

/** `count` folders side by side at the root. */
function folderRow(doc: LoroDoc, count: number): void {
  const tree = doc.getTree(WORKSPACE_TREE_KEY)
  for (let i = 0; i < count; i++) tree.createNode().data.set('segment', `f${i}`)
}

const storedFolders = (store: StoredDoc) => {
  store.evict()
  return readWorkspaceNodes(store.get()).filter((node) => node.type === 'folder').length
}

const storedBody = (store: StoredDoc) => {
  store.evict()
  return documentContainers(store.get(), DOC_ID).getText('body').toString()
}

/**
 * A ceiling, not a delay: a record at the folder ceiling is walked twice and
 * checked out once per judgement, about a second on a loaded machine.
 */
const CEILING_TIMEOUT_MS = 30_000

/** Folders `a/a/…` deep enough that the deepest path passes the length bound. */
const PAST_THE_PATH_BOUND = Math.ceil(DOCUMENT_PATH_MAX_LENGTH / 2) + 1

describe('a workspace-document sync update that writes folders', () => {
  it('a folder chain whose deepest path passes the path length bound is refused, and nothing is kept', async () => {
    const store = seed()

    const refusal = await send(store, (doc) => folderChain(doc, PAST_THE_PATH_BOUND))

    expect(refusal).toBeInstanceOf(OffGrammarPathError)
    expect(store.saves).toBe(0)
    expect(storedFolders(store)).toBe(0)
  })

  it('a folder whose segment the grammar refuses is refused', async () => {
    const store = seed()

    const refusal = await send(store, (doc) => folderChain(doc, 1, 'not a segment'))

    expect(refusal).toBeInstanceOf(OffGrammarPathError)
    expect(syncWriteAnswer(refusal)).toEqual({ code: 'invalid_path', status: 400 })
  })

  it('a folder chain as deep as the path bound allows is applied', async () => {
    const store = seed()

    await expect(
      send(store, (doc) => folderChain(doc, PAST_THE_PATH_BOUND - 1)),
    ).resolves.toMatchObject({ kind: 'applied' })
    expect(storedFolders(store)).toBe(PAST_THE_PATH_BOUND - 1)
  })

  it(
    'folders past the ceiling are refused, and nothing is kept',
    async () => {
      const store = seed()

      const refusal = await send(store, (doc) => folderRow(doc, WORKSPACE_MAX_FOLDERS + 1))

      expect(refusal).toBeInstanceOf(TooManyFoldersError)
      expect(syncWriteAnswer(refusal)).toEqual({ code: 'too_many_folders', status: 413 })
      expect(storedFolders(store)).toBe(0)
    },
    CEILING_TIMEOUT_MS,
  )

  it(
    'folders exactly at the ceiling are applied',
    async () => {
      const store = seed()

      await expect(
        send(store, (doc) => folderRow(doc, WORKSPACE_MAX_FOLDERS)),
      ).resolves.toMatchObject({ kind: 'applied' })
    },
    CEILING_TIMEOUT_MS,
  )

  it(
    'a record already past both bounds still lists and takes an edit that adds no folder',
    async () => {
      const store = seed((doc) => {
        folderRow(doc, WORKSPACE_MAX_FOLDERS + 1)
        folderChain(doc, PAST_THE_PATH_BOUND)
      })

      await expect(
        send(store, (doc) => {
          documentContainers(doc, DOC_ID).getText('body').insert(0, 'more ')
          // A node-meta write, so the placement judge runs over the record.
          doc
            .getTree(WORKSPACE_TREE_KEY)
            .getNodes()
            .find((node) => node.data.get('documentId') === DOC_ID)
            ?.data.set('name', 'Notes')
        }),
      ).resolves.toMatchObject({ kind: 'applied' })
      expect(storedBody(store)).toBe('more body')
      expect(storedFolders(store)).toBe(WORKSPACE_MAX_FOLDERS + 1 + PAST_THE_PATH_BOUND)
    },
    CEILING_TIMEOUT_MS,
  )
})
