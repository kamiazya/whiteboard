/**
 * The browser keeper's file sweep, against real IndexedDB: an image goes once
 * nothing a user can reach names it, and stays while a document, a trash
 * entry or a saved version does.
 */
import {
  projectWorkspaceDocument,
  writeProposal,
  writeSpatialCanvas,
  writeWorkspaceDocumentContent,
} from '@kamiazya/whiteboard-loro-adapter'
import {
  conformanceVerdictFor,
  FILE_COLLECTION_CONFORMANCE,
} from '@kamiazya/whiteboard-loro-adapter/test-utils/file-collection-conformance'
import { newImageRef } from '@kamiazya/whiteboard-model'
import { fileNode } from '@kamiazya/whiteboard-model/test-utils'
import { chunkSnapshot, DEFAULT_SNAPSHOT_MAX_CHUNK_BYTES } from '@kamiazya/whiteboard-ports'
import { LoroDoc } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearWhiteboardDb } from '../test-utils/browser-document.js'
import { expectLoggedFailures } from '../test-utils/browser-setup.js'
import { claimIsolatedWhiteboardDb } from '../test-utils/isolated-whiteboard-db.js'
import { seedSyncDocument } from '../test-utils/seed-sync-document.js'
import { sweepUnreferencedFiles } from './browser-file-sweep.js'
import { DOCUMENT_FILES_STORE, openWhiteboardDb, VERSIONS_STORE } from './browser-idb.js'
import { BrowserVersionStore } from './browser-version-store.js'
import { BrowserWorkspaceDocs } from './browser-workspace-docs.js'
import { getBrowserWorkspaceId } from './browser-workspace-id.js'
import { DocumentFileStore } from './document-file-store.js'
import { FoldingBrowserIndex } from './folding-browser-index.js'
import { IdbBlobStore } from './idb-blob-store.js'
import { openDocumentStore } from './replica-store.js'
import { withReplicaEntry } from './replicas.js'
import { createUserSettingsStore } from './user-settings-store.js'

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

function imageNodes(fileIds: readonly string[]) {
  return fileIds.map((id, i) =>
    fileNode({ id: `n-${id}`, file: newImageRef(id), x: i * 20, y: 0, width: 10, height: 10 }),
  )
}

function drawing(fileIds: readonly string[]): LoroDoc {
  const doc = new LoroDoc()
  writeSpatialCanvas(doc, { nodes: imageNodes(fileIds), edges: [] })
  return doc
}

/** Rewrites one document's content the way the editor's save does. */
async function rewrite(
  documentId: string,
  edit: (current: LoroDoc | null) => LoroDoc,
  workspaceId = getBrowserWorkspaceId(),
) {
  const docs = new BrowserWorkspaceDocs()
  const record = await docs.open(workspaceId)
  if (record === null) throw new Error('no record')
  writeWorkspaceDocumentContent(
    record,
    documentId,
    edit(projectWorkspaceDocument(record, documentId)),
  )
  await docs.save(workspaceId, record)
}

async function draw(
  documentId: string,
  fileIds: readonly string[],
  workspaceId?: string,
): Promise<void> {
  await rewrite(documentId, () => drawing(fileIds), workspaceId)
}

async function propose(
  documentId: string,
  fileIds: readonly string[],
  status: 'open' | 'dismissed',
): Promise<void> {
  await rewrite(documentId, (current) => {
    if (current === null) throw new Error(`no document ${documentId}`)
    writeProposal(current, {
      id: `p-${fileIds.join('-')}`,
      changes: imageNodes(fileIds).map((node) => ({
        id: `c-${node.id}`,
        status,
        op: 'node.add' as const,
        node,
      })),
    })
    return current
  })
}

async function seedDocument(
  path: string,
  fileIds: readonly string[],
  workspaceId = getBrowserWorkspaceId(),
) {
  const index = new FoldingBrowserIndex()
  await index.createWorkspace({ workspaceId })
  const { documentId } = await index.createDocument({ workspaceId, path, kind: 'spatial' })
  await draw(documentId, fileIds, workspaceId)
  return { index, workspaceId, documentId }
}

/** A workspace record whose bytes are no Loro snapshot, so it will not open. */
async function plantUnopenableRecord(workspaceId: string): Promise<void> {
  const { manifest, chunks } = chunkSnapshot(
    new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
    DEFAULT_SNAPSHOT_MAX_CHUNK_BYTES,
  )
  await openDocumentStore().saveSnapshot({
    docRef: { kind: 'workspace-tree', workspaceId },
    manifest,
    chunks,
    frontier: new Uint8Array(),
  })
}

/** Written past every store's schema, as a row from another build would be. */
async function plantRow(store: string, value: unknown, key?: string): Promise<void> {
  const db = await openWhiteboardDb()
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(store, 'readwrite')
      if (key === undefined) tx.objectStore(store).put(value)
      else tx.objectStore(store).put(value, key)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  } finally {
    db.close()
  }
}

/**
 * Runs `write` once, right after the sweep's FIRST record open returns — a
 * write landing while the scan is judging what it read.
 */
function writeDuringScan(write: () => Promise<void>): void {
  const open = BrowserWorkspaceDocs.prototype.open
  let fired = false
  vi.spyOn(BrowserWorkspaceDocs.prototype, 'open').mockImplementation(async function (
    this: BrowserWorkspaceDocs,
    workspaceId: string,
  ) {
    const record = await open.call(this, workspaceId)
    if (!fired) {
      fired = true
      await write()
    }
    return record
  })
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
    expect(await new DocumentFileStore().read(newImageRef('img-a'))).toEqual({ kind: 'absent' })
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

  it('keeps what each of several saved versions draws', async () => {
    for (const id of ['img-v1', 'img-v2', 'img-v3']) await upload(id)
    const { index, workspaceId, documentId } = await seedDocument('page', ['img-v1'])
    const versions = new BrowserVersionStore({ docs: new BrowserWorkspaceDocs(), index })
    await versions.save(workspaceId, 'page')
    await draw(documentId, ['img-v2'])
    await versions.save(workspaceId, 'page')
    await draw(documentId, ['img-v3'])
    await versions.save(workspaceId, 'page')
    await draw(documentId, [])

    expect(await sweepUnreferencedFiles()).toEqual({ kind: 'swept', deleted: [] })
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

describe('sweepUnreferencedFiles stands down rather than delete what it could not judge', () => {
  beforeEach(async () => {
    await clearWhiteboardDb()
    createUserSettingsStore().reset()
  })
  afterEach(() => {
    vi.restoreAllMocks()
    createUserSettingsStore().reset()
  })

  it('stands down on a workspace record that will not open', async () => {
    const logged = expectLoggedFailures()
    await upload('img-a')
    await seedDocument('page', ['img-a'])
    await plantUnopenableRecord('other-ws')
    await upload('img-other')

    expect(await sweepUnreferencedFiles()).toEqual({
      kind: 'stood-down',
      reason: 'unreadable-record',
    })
    expect(await bytesHeld('img-other')).toBe(true)
    expect(logged.some((line) => line.includes('workspace record unreadable'))).toBe(true)
  })

  it('stands down when a node of the record cannot be judged', async () => {
    const logged = expectLoggedFailures()
    await upload('img-new')
    await seedDocument('page', ['img-new'])
    const docs = new BrowserWorkspaceDocs()
    const record = await docs.open(getBrowserWorkspaceId())
    if (record === null) throw new Error('no record')
    // A kind this build does not know, as a newer one would write it.
    for (const node of record.getTree('tree').getNodes()) node.data.set('kind', 'future-kind')
    record.commit()
    await docs.save(getBrowserWorkspaceId(), record)

    expect(await sweepUnreferencedFiles()).toEqual({ kind: 'stood-down', reason: 'unjudged' })
    expect(await bytesHeld('img-new')).toBe(true)
    expect(logged.some((line) => line.includes('could not be read'))).toBe(true)
  })

  it('stands down when a judged record moves during the scan', async () => {
    await upload('img-late')
    const { documentId } = await seedDocument('page', [])
    writeDuringScan(() => draw(documentId, ['img-late']))

    expect(await sweepUnreferencedFiles()).toEqual({ kind: 'stood-down', reason: 'record-moved' })
    expect(await bytesHeld('img-late')).toBe(true)
  })

  it('stands down when a workspace record appears during the scan', async () => {
    await upload('img-elsewhere')
    await seedDocument('page', [])
    writeDuringScan(async () => {
      await seedDocument('page', ['img-elsewhere'], '01ARZ3NDEKTSV4RRFFQ69G5FAW')
    })

    expect(await sweepUnreferencedFiles()).toEqual({ kind: 'stood-down', reason: 'record-moved' })
    expect(await bytesHeld('img-elsewhere')).toBe(true)
  })

  it("does not judge a replica's sealed record, so a replica holds no sweep back", async () => {
    await upload('img-orphan')
    await seedDocument('page', [])
    await plantUnopenableRecord('replica-ws')
    createUserSettingsStore().update((current) =>
      withReplicaEntry(current, 'replica-ws', {
        daemonBaseUrl: 'http://127.0.0.1:3099',
        syncedAt: new Date().toISOString(),
      }),
    )

    expect(await sweepUnreferencedFiles()).toEqual({
      kind: 'swept',
      deleted: [newImageRef('img-orphan')],
    })
  })
})

describe('sweepUnreferencedFiles steps over a row it cannot parse', () => {
  beforeEach(clearWhiteboardDb)

  it('leaves a file record that does not parse and sweeps the rest', async () => {
    await seedDocument('page', [])
    await upload('img-orphan')
    await plantRow(DOCUMENT_FILES_STORE, { v: 99, junk: true }, 'asset:corrupt')

    expect(await sweepUnreferencedFiles()).toEqual({
      kind: 'swept',
      deleted: [newImageRef('img-orphan')],
    })
  })

  it('skips a version row that does not parse and still sweeps', async () => {
    await seedDocument('page', [])
    await upload('img-orphan')
    await plantRow(VERSIONS_STORE, { id: 'v-bad', junk: true })

    expect(await sweepUnreferencedFiles()).toEqual({
      kind: 'swept',
      deleted: [newImageRef('img-orphan')],
    })
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
        case 'propose':
          await propose(ids.get(step.path) ?? '', step.draws, step.status)
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

    const verdict = conformanceVerdictFor('browser')
    const collected = verdict.collected.map((id) => newImageRef(id))
    expect(result.kind === 'swept' ? [...result.deleted].sort() : result).toEqual(collected.sort())
    for (const fileId of verdict.kept) {
      expect(await bytesHeld(fileId), fileId).toBe(true)
    }
  })
})
