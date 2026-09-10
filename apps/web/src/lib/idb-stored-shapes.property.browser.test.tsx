/**
 * Every shape this app stores in IndexedDB is read back through a Zod
 * schema, and each schema is declared once — so the shapes cannot drift at
 * the TYPE level. What the type cannot see is a value the writer produces
 * that a runtime check refuses, and every reader here fails SOFT: a blob
 * whose record does not parse is a miss, a file whose record does not parse
 * is a missing image, a version row that does not parse is skipped. So the
 * drift shows up as data that quietly is not there.
 *
 * Each store is exercised end to end against the real IndexedDB: an input
 * drawn from the writer's own input space (or from the port's schema, where
 * the writer takes one), written by the production writer, read back by the
 * production reader. Structured clone, not JSON, so bytes and blobs cross
 * as themselves.
 *
 * One database for the file, and every run mints its own keys — a workspace
 * id, a file id, a document ref — so no run clears the store under another.
 */
import { operatorInfoSchema } from '@kamiazya/whiteboard-daemon-client/api-contracts/index'
import {
  readSpatialCanvas,
  writeSpatialCanvas,
  writeWorkspaceDocumentContent,
} from '@kamiazya/whiteboard-loro-adapter'
import { DOCUMENT_PATH_SEGMENT_PATTERN, generateDocumentId } from '@kamiazya/whiteboard-model'
import {
  arbitraryForSchema,
  workspaceSegmentArbitrary,
} from '@kamiazya/whiteboard-model/test-utils'
import type { DocRef, DocumentEntry } from '@kamiazya/whiteboard-ports'
import {
  chunkSnapshot,
  createDocumentInputSchema,
  createWorkspaceInputSchema,
} from '@kamiazya/whiteboard-ports'
import { LoroDoc } from 'loro-crdt'
import { afterAll, beforeAll, describe, expect, vi } from 'vitest'
import { clearWhiteboardDb } from '../test-utils/browser-document.js'
import { fc, fcTest, withDefaults } from '../test-utils/fast-check.js'
import { claimIsolatedWhiteboardDb } from '../test-utils/isolated-whiteboard-db.js'
import { DOCUMENT_FILES_STORE, openWhiteboardDb } from './browser-idb.js'
import { BrowserVersionStore } from './browser-version-store.js'
import { BrowserWorkspaceDocs } from './browser-workspace-docs.js'
import { getBrowserWorkspaceId } from './browser-workspace-id.js'
import { DocumentFileStore, documentFileRecordSchema } from './document-file-store.js'
import { FoldingBrowserIndex } from './folding-browser-index.js'
import { IdbBlobStore } from './idb-blob-store.js'
import { IdbDocumentIndex } from './idb-document-index.js'
import { IdbDocumentStore } from './idb-document-store.js'

claimIsolatedWhiteboardDb('idbstoredshapes')

beforeAll(clearWhiteboardDb)
afterAll(clearWhiteboardDb)

// Run counts stay inside the browser layer's budget (single digits to ~20,
// `test-layer-selection`): every case here is a real browser plus a real
// IndexedDB transaction, and the projects share one runner with two other
// browser projects. The bug this lane found needed four cases to reach.
const bytesArb = fc.uint8Array({ maxLength: 2048 })
const asList = (bytes: ArrayLike<number>): number[] => Array.from(bytes)

/**
 * What an upload can carry as its type: the ordinary ones, arbitrary text,
 * and the EMPTY one a `Blob` answers for a type it will not carry.
 *
 * The empty arm is weighted rather than left to arise from the others,
 * because it is the arrangement that found the defect and the run counts
 * here are small: at one draw in six it was missed by one mutation run in
 * three. Each property that can reach it also pins it as an `example`, so
 * the case runs every time whatever the draws do, and `emptyTypeDraws`
 * below fails the file if it stops being reached at all.
 */
const mimeTypeArb = fc.oneof(
  { weight: 3, arbitrary: fc.constantFrom('image/png', 'image/svg+xml', 'text/plain') },
  { weight: 2, arbitrary: fc.constant('') },
  { weight: 1, arbitrary: fc.string({ maxLength: 24 }) },
)

/** A tally, because a property that never draws the empty type asserts nothing about it. */
let emptyTypeDraws = 0
const recordMimeType = (mimeType: string): string => {
  if (mimeType === '') emptyTypeDraws += 1
  return mimeType
}

afterAll(() => {
  expect(emptyTypeDraws).toBeGreaterThanOrEqual(3)
})

/** Raw access to one object store, for seeding a legacy record and reading what a rewrite left. */
async function raw<T>(
  storeName: string,
  mode: IDBTransactionMode,
  body: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openWhiteboardDb()
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(storeName, mode)
    const request = body(tx.objectStore(storeName))
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
    tx.oncomplete = () => db.close()
  })
}

describe('IdbBlobStore', () => {
  fcTest.prop(
    [bytesArb, fc.option(mimeTypeArb, { nil: undefined })],
    withDefaults<[Uint8Array<ArrayBuffer>, string | undefined]>({
      numRuns: 20,
      examples: [[new Uint8Array([1, 2, 3]), '']],
    }),
  )('gives back the bytes and content type that were put', async (bytes, contentType) => {
    if (contentType !== undefined) recordMimeType(contentType)
    const store = new IdbBlobStore()
    const { ref } = await store.put({ bytes, contentType })
    expect(await store.has({ ref })).toEqual({ exists: true })
    const got = await store.get({ ref })
    expect(got).not.toBeNull()
    expect(asList(got?.bytes ?? [])).toEqual(asList(bytes))
    expect(got?.contentType).toBe(contentType)
  })
})

describe('DocumentFileStore', () => {
  fcTest.prop(
    [bytesArb, mimeTypeArb, fc.nat()],
    withDefaults<[Uint8Array<ArrayBuffer>, string, number]>({
      numRuns: 15,
      examples: [[new Uint8Array([1, 2, 3]), '', 0]],
    }),
  )(
    'gives back the image that was put, typed as the browser types it',
    async (bytes, mimeType, created) => {
      recordMimeType(mimeType)
      const store = new DocumentFileStore()
      const fileId = `file-${generateDocumentId()}`
      await store.put(fileId, { mimeType, blob: new Blob([bytes], { type: mimeType }), created })
      const got = await store.get(fileId)
      expect(got).not.toBeNull()
      expect(asList(new Uint8Array(await (got as Blob).arrayBuffer()))).toEqual(asList(bytes))
      // The record keeps the type as given; the Blob built from it normalises
      // the way every Blob does, so the expectation is built the same way.
      expect(got?.type).toBe(new Blob([], { type: mimeType }).type)
    },
  )

  fcTest.prop(
    [bytesArb, mimeTypeArb, fc.nat()],
    withDefaults<[Uint8Array<ArrayBuffer>, string, number]>({
      numRuns: 8,
      examples: [[new Uint8Array([1, 2, 3]), '', 0]],
    }),
  )(
    'reads a v1 record and rewrites it as v2 with its bytes in the blob store',
    async (bytes, mimeType, created) => {
      recordMimeType(mimeType)
      const fileId = `legacy-${generateDocumentId()}`
      const blob = new Blob([bytes], { type: mimeType })
      await raw(DOCUMENT_FILES_STORE, 'readwrite', (files) =>
        files.put({ v: 1, mimeType, created, blob }, fileId),
      )
      const store = new DocumentFileStore()
      const got = await store.get(fileId)
      expect(got).not.toBeNull()
      expect(asList(new Uint8Array(await (got as Blob).arrayBuffer()))).toEqual(asList(bytes))

      const rewritten = await vi.waitFor(async () => {
        const record = documentFileRecordSchema.parse(
          await raw(DOCUMENT_FILES_STORE, 'readonly', (files) => files.get(fileId)),
        )
        expect(record.v).toBe(2)
        return record
      })
      if (rewritten.v !== 2) throw new Error('unreachable')
      expect(rewritten).toMatchObject({ mimeType, created })
      expect(await new IdbBlobStore().has({ ref: rewritten.ref })).toEqual({ exists: true })
      // And the image still reads, now through the blob store.
      const again = await store.get(fileId)
      expect(asList(new Uint8Array(await (again as Blob).arrayBuffer()))).toEqual(asList(bytes))
    },
  )
})

describe('IdbDocumentIndex', () => {
  const documentPathArb = fc
    .array(fc.stringMatching(DOCUMENT_PATH_SEGMENT_PATTERN), { minLength: 1, maxLength: 3 })
    .map((segments) => segments.join('/'))
  const workspaceArb = arbitraryForSchema(createWorkspaceInputSchema.omit({ workspaceId: true }), {
    override: (path) =>
      path === '$.segment' ? fc.option(workspaceSegmentArbitrary, { nil: undefined }) : undefined,
  })
  const documentArb = arbitraryForSchema(createDocumentInputSchema.omit({ workspaceId: true }), {
    override: (path) => (path === '$.path' ? documentPathArb : undefined),
  })
  const byPath = (a: DocumentEntry, b: DocumentEntry) => (a.path < b.path ? -1 : 1)

  fcTest.prop(
    [
      workspaceArb,
      fc.uniqueArray(documentArb, { selector: (d) => d.path, minLength: 1, maxLength: 4 }),
    ],
    withDefaults({ numRuns: 15 }),
  )('lists the workspace and its documents as they were created', async (workspace, docs) => {
    const index = new IdbDocumentIndex()
    const workspaceId = generateDocumentId()
    await index.createWorkspace({ workspaceId, ...workspace })
    expect(await index.listWorkspaces()).toContainEqual({ workspaceId, ...workspace })
    expect(await index.resolveWorkspace(workspaceId)).toEqual({ workspaceId, ...workspace })

    const created: DocumentEntry[] = []
    for (const doc of docs) created.push(await index.createDocument({ workspaceId, ...doc }))
    const listed = await index.listDocuments({ workspaceId })
    expect([...listed].sort(byPath)).toEqual([...created].sort(byPath))
    for (const entry of created) {
      expect(await index.resolveDocument({ workspaceId, path: entry.path })).toEqual(entry)
    }
  })
})

describe('IdbDocumentStore', () => {
  const frontierArb = fc.uint8Array({ maxLength: 64 })

  fcTest.prop(
    [
      bytesArb,
      fc.integer({ min: 1, max: 512 }),
      frontierArb,
      fc.array(bytesArb, { minLength: 1, maxLength: 4 }),
      frontierArb,
    ],
    withDefaults({ numRuns: 15 }),
  )(
    'gives back the snapshot and the delta log as they were saved',
    async (snapshot, maxChunkBytes, frontier, updates, newFrontier) => {
      const store = new IdbDocumentStore()
      const docRef: DocRef = {
        kind: 'document',
        workspaceId: generateDocumentId(),
        documentId: generateDocumentId(),
      }
      const { manifest, chunks } = chunkSnapshot(snapshot, maxChunkBytes)
      await store.saveSnapshot({ docRef, manifest, chunks, frontier })

      const loaded = await store.loadSnapshot({ docRef })
      expect(loaded).not.toBeNull()
      expect(loaded?.manifest).toEqual(manifest)
      const joined = [...(loaded?.chunks ?? [])]
        .sort((a, b) => a.index - b.index)
        .flatMap((chunk) => asList(chunk.bytes))
      expect(joined).toEqual(asList(snapshot))
      expect(asList(loaded?.frontier ?? [])).toEqual(asList(frontier))
      expect(await store.readSnapshotManifest({ docRef })).toEqual({ manifest, generation: 1 })

      await store.appendDeltas({ docRef, deltaBatch: { updates, newFrontier } })
      const log = await store.loadDeltas({ docRef, afterSeq: null })
      expect(log.updates.map(asList)).toEqual(updates.map(asList))
      expect(log.lastSeq).toBe(updates.length)
      expect(asList(log.frontier)).toEqual(asList(newFrontier))
      expect(await store.readFrontier({ docRef })).toEqual({ frontier: newFrontier })
    },
  )
})

describe('BrowserVersionStore', () => {
  const PATH = 'versions-property'
  let versions: BrowserVersionStore
  let workspaceId: string

  beforeAll(async () => {
    const index = new FoldingBrowserIndex()
    workspaceId = getBrowserWorkspaceId()
    await index.createWorkspace({ workspaceId })
    const { documentId } = await index.createDocument({ workspaceId, path: PATH, kind: 'spatial' })
    const docs = new BrowserWorkspaceDocs()
    const record = await docs.open(workspaceId)
    if (record === null) throw new Error('no record')
    const doc = new LoroDoc()
    writeSpatialCanvas(doc, {
      nodes: [{ id: 'n1', type: 'text', x: 0, y: 0, width: 80, height: 40, text: 'saved' }],
      edges: [],
    })
    doc.commit()
    writeWorkspaceDocumentContent(record, documentId, doc)
    await docs.save(workspaceId, record)
    versions = new BrowserVersionStore({ docs, index })
  })

  const saveInputArb = fc.record(
    {
      label: fc.string({ maxLength: 20 }),
      operator: arbitraryForSchema(operatorInfoSchema),
      restoredFrom: fc.string({ minLength: 1, maxLength: 10 }),
      auto: fc.boolean(),
      branchName: fc.string({ maxLength: 12 }),
    },
    { requiredKeys: [] },
  )

  fcTest.prop([saveInputArb], withDefaults({ numRuns: 10 }))(
    'lists a saved version as the entry save answered with',
    async (input) => {
      const saved = await versions.save(workspaceId, PATH, input)
      expect(saved).toMatchObject({
        path: PATH,
        auto: input.auto === true,
        branchName: input.branchName ? input.branchName : 'main',
        elementCount: 1,
      })
      expect(saved.label).toBe(input.label ? input.label : undefined)
      expect(saved.operator).toEqual(input.operator)
      expect(saved.restoredFrom).toBe(input.restoredFrom)
      expect(await versions.list(workspaceId, PATH)).toContainEqual(saved)
      const past = await versions.loadPast(workspaceId, PATH, saved.id)
      expect(past).not.toBeNull()
      const node = readSpatialCanvas(past as LoroDoc).nodes[0]
      expect(node?.type === 'text' ? node.text : undefined).toBe('saved')
    },
  )
})
