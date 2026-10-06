/**
 * The browser keeper's file sweep, against real IndexedDB: an image goes once
 * nothing a user can reach names it, and stays while a document, a trash
 * entry or a saved version does.
 */
import {
  writeSpatialCanvas,
  writeWorkspaceDocumentContent,
} from '@kamiazya/whiteboard-loro-adapter'
import { FILE_COLLECTION_CONFORMANCE } from '@kamiazya/whiteboard-loro-adapter/test-utils/file-collection-conformance'
import { newImageRef } from '@kamiazya/whiteboard-model'
import { fileNode } from '@kamiazya/whiteboard-model/test-utils'
import { LoroDoc } from 'loro-crdt'
import { beforeEach, describe, expect, it } from 'vitest'
import { clearWhiteboardDb } from '../test-utils/browser-document.js'
import { claimIsolatedWhiteboardDb } from '../test-utils/isolated-whiteboard-db.js'
import { seedSyncDocument } from '../test-utils/seed-sync-document.js'
import { sweepUnreferencedFiles } from './browser-file-sweep.js'
import { BrowserVersionStore } from './browser-version-store.js'
import { BrowserWorkspaceDocs } from './browser-workspace-docs.js'
import { getBrowserWorkspaceId } from './browser-workspace-id.js'
import { DocumentFileStore } from './document-file-store.js'
import { FoldingBrowserIndex } from './folding-browser-index.js'
import { IdbBlobStore } from './idb-blob-store.js'

claimIsolatedWhiteboardDb('browser-file-sweep')

/** Distinct bytes per image, so no two share a blob and `has` speaks for one. */
function bytesOf(fileId: string): Uint8Array {
  return new TextEncoder().encode(`png:${fileId}`)
}

async function digestOf(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource))
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('')
}

/** Stored as the editor stores a picked image: under its reference, long enough ago. */
async function upload(fileId: string, created = 0): Promise<void> {
  await new DocumentFileStore().put(newImageRef(fileId), {
    mimeType: 'image/png',
    blob: new Blob([bytesOf(fileId) as BlobPart], { type: 'image/png' }),
    created,
  })
}

async function bytesHeld(fileId: string): Promise<boolean> {
  const ref = { algorithm: 'sha-256', digestHex: await digestOf(bytesOf(fileId)) } as const
  return (await new IdbBlobStore().has({ ref })).exists
}

function drawing(fileIds: readonly string[]): LoroDoc {
  const doc = new LoroDoc()
  writeSpatialCanvas(doc, {
    nodes: fileIds.map((id, i) =>
      fileNode({ id: `n-${id}`, file: newImageRef(id), x: i * 20, y: 0, width: 10, height: 10 }),
    ),
    edges: [],
  })
  return doc
}

async function draw(documentId: string, fileIds: readonly string[]): Promise<void> {
  const docs = new BrowserWorkspaceDocs()
  const record = await docs.open(getBrowserWorkspaceId())
  if (record === null) throw new Error('no record')
  writeWorkspaceDocumentContent(record, documentId, drawing(fileIds))
  await docs.save(getBrowserWorkspaceId(), record)
}

async function seedDocument(path: string, fileIds: readonly string[]) {
  const index = new FoldingBrowserIndex()
  const workspaceId = getBrowserWorkspaceId()
  await index.createWorkspace({ workspaceId })
  const { documentId } = await index.createDocument({ workspaceId, path, kind: 'spatial' })
  await draw(documentId, fileIds)
  return { index, workspaceId, documentId }
}

describe('sweepUnreferencedFiles', () => {
  beforeEach(clearWhiteboardDb)

  it('drops an image once its node is deleted and its document purged', async () => {
    await upload('img-a')
    const { index, workspaceId, documentId } = await seedDocument('page', ['img-a'])
    await draw(documentId, [])
    await index.deleteDocument({ workspaceId, path: 'page' })
    expect(await index.purgeTrashEntry({ workspaceId, documentId })).toBe(true)

    const result = await sweepUnreferencedFiles()

    expect(result).toEqual({ kind: 'swept', deleted: [newImageRef('img-a')] })
    expect(await bytesHeld('img-a')).toBe(false)
    expect(await new DocumentFileStore().get(newImageRef('img-a'))).toBeNull()
  })

  it('keeps an image a live document draws and drops the one nothing names', async () => {
    await upload('img-live')
    await upload('img-orphan')
    await seedDocument('page', ['img-live'])

    const result = await sweepUnreferencedFiles()

    expect(result).toEqual({ kind: 'swept', deleted: [newImageRef('img-orphan')] })
    expect(await bytesHeld('img-live')).toBe(true)
    expect(await bytesHeld('img-orphan')).toBe(false)
  })

  it('keeps an image only a trashed document draws, so a restore finds it', async () => {
    await upload('img-trash')
    const { index, workspaceId } = await seedDocument('page', ['img-trash'])
    await index.deleteDocument({ workspaceId, path: 'page' })

    expect(await sweepUnreferencedFiles()).toEqual({ kind: 'swept', deleted: [] })
    expect(await bytesHeld('img-trash')).toBe(true)
  })

  it('keeps an image only a saved version draws', async () => {
    await upload('img-then')
    const { index, workspaceId, documentId } = await seedDocument('page', ['img-then'])
    await new BrowserVersionStore({ docs: new BrowserWorkspaceDocs(), index }).save(
      workspaceId,
      'page',
    )
    await draw(documentId, [])

    expect(await sweepUnreferencedFiles()).toEqual({ kind: 'swept', deleted: [] })
    expect(await bytesHeld('img-then')).toBe(true)
  })

  it('keeps an upload inside the grace window, whose node is not saved yet', async () => {
    await seedDocument('page', [])
    await upload('img-fresh', Date.now())

    expect(await sweepUnreferencedFiles()).toEqual({ kind: 'swept', deleted: [] })
    expect(await bytesHeld('img-fresh')).toBe(true)
  })

  it('stands down while a per-document record the fold has not taken remains', async () => {
    await upload('img-legacy')
    await seedDocument('page', [])
    await seedSyncDocument('01ARZ3NDEKTSV4RRFFQ69G5FAV', {
      snapshot: new LoroDoc().export({ mode: 'snapshot' }),
    })

    expect(await sweepUnreferencedFiles()).toEqual({
      kind: 'stood-down',
      reason: 'unfolded-documents',
    })
    expect(await bytesHeld('img-legacy')).toBe(true)
  })
})

describe('sweepUnreferencedFiles on the cross-keeper scenario', () => {
  beforeEach(clearWhiteboardDb)

  // The daemon takes the same steps in file-gc.conformance.test.ts.
  it('reaches the verdict every keeper reaches', async () => {
    const index = new FoldingBrowserIndex()
    const workspaceId = getBrowserWorkspaceId()
    await index.createWorkspace({ workspaceId })
    const versions = new BrowserVersionStore({ docs: new BrowserWorkspaceDocs(), index })
    const ids = new Map<string, string>()
    for (const step of FILE_COLLECTION_CONFORMANCE.steps) {
      switch (step.op) {
        case 'upload':
          await upload(step.fileId)
          break
        case 'create': {
          const { documentId } = await index.createDocument({
            workspaceId,
            path: step.path,
            kind: 'spatial',
          })
          ids.set(step.path, documentId)
          await draw(documentId, step.draws)
          break
        }
        case 'draw':
          await draw(ids.get(step.path) ?? '', step.draws)
          break
        case 'save-version':
          await versions.save(workspaceId, step.path)
          break
        case 'delete':
          await index.deleteDocument({ workspaceId, path: step.path })
          break
        case 'purge': {
          const documentId = ids.get(step.path) ?? ''
          expect(await index.purgeTrashEntry({ workspaceId, documentId })).toBe(true)
          break
        }
      }
    }

    const result = await sweepUnreferencedFiles()

    const collected = FILE_COLLECTION_CONFORMANCE.collected.map((id) => newImageRef(id))
    expect(result.kind === 'swept' ? [...result.deleted].sort() : result).toEqual(collected.sort())
    for (const fileId of FILE_COLLECTION_CONFORMANCE.kept) {
      expect(await bytesHeld(fileId), fileId).toBe(true)
    }
  })
})
