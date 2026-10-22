/**
 * A workspace holds at most 4000 folders, and every way this index makes a
 * new one — a create or a move to a path whose folders do not exist yet, a
 * restore from the trash — refuses past it. Both keepers place through this
 * class, so the ceiling the daemon's sync path holds is held here as well.
 */

import {
  createWorkspaceDocumentAtPath,
  exportWorkspaceSubtree,
  readWorkspaceNodes,
  WORKSPACE_TREE_KEY,
} from '@kamiazya/whiteboard-loro-adapter'
import { type BlobStore, blobRefKey, TooManyFoldersError } from '@kamiazya/whiteboard-ports'
import { LoroDoc } from 'loro-crdt'
import { beforeEach, describe, expect, it } from 'vitest'
import { LoroWorkspaceDocumentIndex } from './loro-workspace-document-index.js'
import { restorableTrashDocuments } from './restore-judgement.js'
import type { WorkspaceDocs } from './workspace-docs.js'

/** Written out rather than imported, so the test is not judged by the constant it judges. */
const CEILING = 4000
const WS = 'ws-folders'

const notImplemented = (): Promise<never> => Promise.reject(new Error('not implemented'))

function inMemoryBlobStore(): BlobStore {
  const blobs = new Map<string, Uint8Array>()
  let next = 0
  return {
    async put({ bytes }) {
      next += 1
      const ref = { algorithm: 'sha-256', digestHex: String(next).padStart(64, '0') } as const
      blobs.set(blobRefKey(ref), new Uint8Array(bytes))
      return { ref }
    },
    async get({ ref }) {
      const bytes = blobs.get(blobRefKey(ref))
      return bytes === undefined ? null : { bytes: new Uint8Array(bytes) }
    },
    async has({ ref }) {
      return { exists: blobs.has(blobRefKey(ref)) }
    },
    async delete({ ref }) {
      blobs.delete(blobRefKey(ref))
    },
  }
}

function inMemoryWorkspaceDocs(): WorkspaceDocs & { peek: (id: string) => LoroDoc } {
  const docs = new Map<string, LoroDoc>()
  return {
    async open(workspaceId) {
      return docs.get(workspaceId) ?? null
    },
    async create(workspaceId) {
      const doc = docs.get(workspaceId) ?? new LoroDoc()
      docs.set(workspaceId, doc)
      return doc
    },
    async save() {
      return null
    },
    readCursor: notImplemented,
    catchUp: notImplemented,
    peek: (id) => docs.get(id) as LoroDoc,
  }
}

/** Fills the record up to `total` empty folders at the root. */
function fillFoldersTo(doc: LoroDoc, total: number): void {
  const tree = doc.getTree(WORKSPACE_TREE_KEY)
  for (let i = foldersIn(doc); i < total; i++) tree.createNode().data.set('segment', `f${i}`)
  doc.commit()
}

const foldersIn = (doc: LoroDoc) =>
  readWorkspaceNodes(doc).filter((node) => node.type === 'folder').length

describe('a workspace at its folder ceiling', () => {
  let docs: ReturnType<typeof inMemoryWorkspaceDocs>
  let index: LoroWorkspaceDocumentIndex

  beforeEach(async () => {
    docs = inMemoryWorkspaceDocs()
    index = new LoroWorkspaceDocumentIndex(docs, inMemoryBlobStore(), {
      listWorkspaces: async () => [],
      findWorkspace: async () => null,
      renameWorkspace: notImplemented,
    })
    await index.createWorkspace({ workspaceId: WS })
  })

  it('still creates a document whose new folders reach the ceiling', async () => {
    fillFoldersTo(docs.peek(WS), CEILING - 2)
    await index.createDocument({ workspaceId: WS, path: 'x/y/doc', kind: 'markdown' })
    expect(foldersIn(docs.peek(WS))).toBe(CEILING)
  })

  it('refuses a create whose new folders would pass it, leaving the record as it was', async () => {
    fillFoldersTo(docs.peek(WS), CEILING - 1)
    await expect(
      index.createDocument({ workspaceId: WS, path: 'x/y/doc', kind: 'markdown' }),
    ).rejects.toBeInstanceOf(TooManyFoldersError)
    expect(foldersIn(docs.peek(WS))).toBe(CEILING - 1)
    expect(readWorkspaceNodes(docs.peek(WS)).some((node) => node.path === 'x')).toBe(false)
  })

  it('creates into folders that already exist when at the ceiling', async () => {
    fillFoldersTo(docs.peek(WS), CEILING)
    await index.createDocument({ workspaceId: WS, path: 'f0/doc', kind: 'markdown' })
    expect(foldersIn(docs.peek(WS))).toBe(CEILING)
  })

  it('refuses a move whose destination needs folders past it', async () => {
    await index.createDocument({ workspaceId: WS, path: 'doc', kind: 'markdown' })
    fillFoldersTo(docs.peek(WS), CEILING)
    await expect(
      index.moveDocument({ workspaceId: WS, from: 'doc', to: 'x/doc' }),
    ).rejects.toBeInstanceOf(TooManyFoldersError)
    expect(readWorkspaceNodes(docs.peek(WS)).map((node) => node.path)).toContain('doc')
  })
})

describe('restoring a trashed document', () => {
  /** A trashed `top` whose subtree holds one folder, segment `segment`, and a document. */
  function trashedWithFolder(segment: string): Uint8Array {
    const doc = new LoroDoc()
    createWorkspaceDocumentAtPath(doc, {
      path: 'top',
      documentId: '01BRWAAAAAAAAAAAAAAAAAAAA0',
      kind: 'markdown',
    })
    const top = doc.getTree(WORKSPACE_TREE_KEY).roots()[0]
    const folder = top?.createNode()
    folder?.data.set('segment', segment)
    doc.commit()
    return exportWorkspaceSubtree(doc, 'top') as Uint8Array
  }

  it('counts the folders the subtree would bring back', () => {
    expect(
      restorableTrashDocuments(trashedWithFolder('inner'), {
        documentId: '01BRWAAAAAAAAAAAAAAAAAAAA0',
        parentPath: undefined,
      }),
    ).toEqual({ documents: 1, folders: 1 })
  })

  it('refuses a subtree holding a folder the path grammar refuses', () => {
    expect(
      restorableTrashDocuments(trashedWithFolder('not a segment'), {
        documentId: '01BRWAAAAAAAAAAAAAAAAAAAA0',
        parentPath: undefined,
      }),
    ).toBeNull()
  })
})
