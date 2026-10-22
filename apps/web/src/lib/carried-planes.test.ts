// @vitest-environment node
/**
 * The planes every workspace move carries beside its record, and the body
 * fitting they share: trash entries are what gives way under the keeper's
 * ceiling, and each one that does is NAMED, because the browser copy is the
 * only one of it left.
 *
 * Node rather than jsdom for the IndexedDB reads: fake-indexeddb clones a
 * row's `Uint8Array` frontiers into jsdom's realm, where the version store's
 * `z.instanceof(Uint8Array)` skips the row.
 */
import 'fake-indexeddb/auto'
import { promoteWorkspaceRequestSchema } from '@kamiazya/whiteboard-daemon-client/api-contracts/promotion'
import { readTrashEntries, writeSpatialCanvas } from '@kamiazya/whiteboard-loro-adapter'
import {
  base64UrlToBytes,
  generateDocumentId,
  newImageRef,
  VERSION_LABEL_MAX_LENGTH,
} from '@kamiazya/whiteboard-model'
import { fileNode } from '@kamiazya/whiteboard-model/test-utils'
import { blobRefKey } from '@kamiazya/whiteboard-ports'
import { encodeFrontiers, LoroDoc } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearWhiteboardDb } from '../test-utils/browser-document.js'
import { claimIsolatedWhiteboardDb } from '../test-utils/isolated-whiteboard-db.js'
import { seedWorkspaceDocumentContent } from '../test-utils/seed-workspace-content.js'
import { ensureBrowserWorkspace } from './browser-document-summary.js'
import { BLOBS_STORE, VERSIONS_STORE, whiteboardDbName } from './browser-idb.js'
import { BrowserWorkspaceDocs } from './browser-workspace-docs.js'
import { getBrowserWorkspaceId } from './browser-workspace-id.js'
import {
  fitCarriedPlanes,
  readCarriedPlanes,
  unconfirmedPlanes,
  versionsWithinJudgedBudget,
} from './carried-planes.js'
import { FoldingBrowserIndex } from './folding-browser-index.js'
import { IdbBlobStore } from './idb-blob-store.js'
import { inTransaction, request } from './idb-tx.js'

claimIsolatedWhiteboardDb('carried-planes')

const entry = (documentId: string, size: number) => ({ documentId, bytes: 'A'.repeat(size) })

const planes = (trash: ReturnType<typeof entry>[]) => ({
  trash,
  versions: [],
  trashPaths: new Map(trash.map((each) => [each.documentId, `notes/${each.documentId}`])),
})

describe('fitCarriedPlanes', () => {
  it('leaves out a trash entry past the ceiling, names it, and keeps the ones that fit', () => {
    const fitted = fitCarriedPlanes(
      'snap',
      planes([entry('small', 10), entry('huge', 5000), entry('also-small', 10)]),
      1000,
    )
    expect(fitted.trash.map((each) => each.documentId)).toEqual(['small', 'also-small'])
    expect(fitted.leftBehind).toEqual([
      'the trashed document "notes/huge" is too large to move with the rest',
    ])
  })

  it('keeps the fitted body inside the ceiling it was given', () => {
    const limit = 400
    const fitted = fitCarriedPlanes(
      'snap',
      planes([entry('a', 150), entry('b', 150), entry('c', 150)]),
      limit,
    )
    const body = JSON.stringify({ snapshot: 'snap', trash: fitted.trash, versions: [] })
    expect(new TextEncoder().encode(body).byteLength).toBeLessThanOrEqual(limit)
    expect(fitted.trash.length).toBeGreaterThan(0)
    expect(fitted.trash.length + fitted.leftBehind.length).toBe(3)
  })

  it('leaves the trash entries past the count one move carries behind, naming each', () => {
    const fitted = fitCarriedPlanes(
      'snap',
      planes([entry('a', 10), entry('b', 10), entry('c', 10)]),
      undefined,
      { trash: 2, versions: 10 },
    )
    expect(fitted.trash.map((each) => each.documentId)).toEqual(['a', 'b'])
    expect(fitted.leftBehind).toEqual([
      'the trashed document "notes/c": one move carries at most 2 trashed documents',
    ])
  })

  it('past the version count, keeps manual saves and the newest checkpoints, in reading order', () => {
    const version = (id: string, createdAt: number, auto: boolean) => ({
      id,
      documentId: 'doc',
      createdAt,
      auto,
      frontiers: 'AA',
    })
    const versions = [
      version('old-auto', 1, true),
      version('old-manual', 2, false),
      version('new-auto', 3, true),
      version('newest-auto', 4, true),
    ]
    const fitted = fitCarriedPlanes('snap', { ...planes([]), versions }, undefined, {
      trash: 10,
      versions: 3,
    })
    expect(fitted.versions.map((each) => each.id)).toEqual([
      'old-manual',
      'new-auto',
      'newest-auto',
    ])
    expect(fitted.leftBehind).toEqual(['1 older saved version: one move carries at most 3'])
    expect(fitted.versionsLeftBehind).toBe(1)
  })

  it('carries everything and leaves nothing when it all fits', () => {
    const fitted = fitCarriedPlanes('snap', planes([entry('a', 10)]))
    expect(fitted).toEqual({
      trash: [entry('a', 10)],
      versions: [],
      leftBehind: [],
      versionsLeftBehind: 0,
    })
  })
})

describe('versionsWithinJudgedBudget', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  // Pricing a version projects it on the page's thread, for as long as the
  // keeper's own budget, so a slice that has run long hands the thread back.
  it('hands the thread back between slices, and still keeps every version that fits', async () => {
    let clock = 0
    vi.spyOn(Date, 'now').mockImplementation(() => {
      clock += 20
      return clock
    })
    const versions = ['v-1', 'v-2', 'v-3'].map((id, index) => ({
      id,
      documentId: generateDocumentId(),
      createdAt: index,
      auto: false,
      frontiers: 'AA',
    }))
    let ranBetween = false
    setTimeout(() => {
      ranBetween = true
    }, 0)
    const fitted = await versionsWithinJudgedBudget(new LoroDoc(), versions, 1_000)
    expect(ranBetween).toBe(true)
    expect(fitted).toEqual({ kept: versions, dropped: 0 })
  })
})

describe('unconfirmedPlanes', () => {
  it('counts what the keeper did not read back, in the words of the keeper named', () => {
    expect(
      unconfirmedPlanes(
        { trash: [entry('a', 1), entry('b', 1)], versions: [] },
        { trashStored: ['a'], versionsKept: [] },
        'the keeper',
      ),
    ).toEqual(['1 trashed document did not reach the keeper'])
  })
})

function canvasWith(imageId: string): Uint8Array {
  const content = new LoroDoc()
  const node = fileNode({
    id: `n-${imageId}`,
    file: newImageRef(imageId),
    x: 0,
    y: 0,
    width: 10,
    height: 10,
  })
  writeSpatialCanvas(content, { nodes: [node], edges: [] })
  return new Uint8Array(content.export({ mode: 'snapshot' }))
}

/** A browser workspace with a live canvas `sketch` and a trashed canvas `gone`. */
async function seedWorkspace() {
  const index = new FoldingBrowserIndex()
  await ensureBrowserWorkspace(index)
  const workspaceId = getBrowserWorkspaceId()
  const sketch = await index.createDocument({ workspaceId, path: 'sketch', kind: 'spatial' })
  const gone = await index.createDocument({ workspaceId, path: 'gone', kind: 'spatial' })
  expect(await seedWorkspaceDocumentContent(sketch.documentId, canvasWith('on-the-sketch'))).toBe(
    true,
  )
  expect(await seedWorkspaceDocumentContent(gone.documentId, canvasWith('in-the-trash'))).toBe(true)
  await index.deleteDocument({ workspaceId, path: 'gone' })
  const record = await new BrowserWorkspaceDocs().open(workspaceId)
  if (record === null) throw new Error('no workspace record')
  return { record, workspaceId, sketch, gone }
}

/** A version row written the way the store keeps one, with what the test names. */
async function putVersionRow(row: Record<string, unknown>) {
  await inTransaction(whiteboardDbName(), [VERSIONS_STORE], 'readwrite', (tx) =>
    request(
      tx.objectStore(VERSIONS_STORE).put({
        path: 'sketch',
        elementCount: 1,
        contentDigest: 'digest',
        ...row,
      }),
    ),
  )
}

describe('readCarriedPlanes', () => {
  beforeEach(clearWhiteboardDb)

  it('carries each trash entry by path and each saved version without its device', async () => {
    const { record, workspaceId, sketch, gone } = await seedWorkspace()
    const frontiers = new Uint8Array(encodeFrontiers(record.oplogFrontiers()))
    await putVersionRow({
      id: 'v-labelled',
      workspaceId,
      documentId: sketch.documentId,
      label: 'as drafted',
      createdAt: 1700000000000.75,
      operator: { kind: 'human', actor: 'device-1', displayName: 'Yuki' },
      restoredFrom: 'v-earlier',
      frontiers,
    })

    const planes = await readCarriedPlanes(record, workspaceId)

    expect(planes.leftBehind).toEqual([])
    expect(planes.trash.map((each) => each.documentId)).toEqual([gone.documentId])
    expect([...planes.trashPaths]).toEqual([[gone.documentId, 'gone']])
    const entry = readTrashEntries(record)[0]
    const stored =
      entry === undefined ? undefined : await new IdbBlobStore().get({ ref: entry.blob })
    expect(base64UrlToBytes(planes.trash[0]?.bytes ?? '')).toEqual(stored?.bytes)
    expect(planes.versions).toEqual([
      {
        id: 'v-labelled',
        documentId: sketch.documentId,
        createdAt: 1700000000000,
        auto: false,
        label: 'as drafted',
        operator: { kind: 'human', displayName: 'Yuki' },
        restoredFrom: 'v-earlier',
        frontiers: expect.any(String),
      },
    ])
    expect(base64UrlToBytes(planes.versions[0]?.frontiers ?? '')).toEqual(frontiers)
    expect([...planes.scan.referenced].sort()).toEqual(['in-the-trash', 'on-the-sketch'])
  })

  it('carries a bare auto version as auto, with no label, operator or restore', async () => {
    const { record, workspaceId, sketch } = await seedWorkspace()
    await putVersionRow({
      id: 'v-auto',
      workspaceId,
      documentId: sketch.documentId,
      createdAt: 5,
      auto: true,
      frontiers: new Uint8Array(encodeFrontiers(record.oplogFrontiers())),
    })

    const { versions } = await readCarriedPlanes(record, workspaceId)

    expect(versions).toEqual([
      {
        id: 'v-auto',
        documentId: sketch.documentId,
        createdAt: 5,
        auto: true,
        frontiers: expect.any(String),
      },
    ])
  })

  it('fits a label stored past the wire bound so the request still parses', async () => {
    const { record, workspaceId, sketch } = await seedWorkspace()
    // An astral character straddling the bound: cutting by code unit would
    // leave half of it behind.
    const stored = `${'a'.repeat(VERSION_LABEL_MAX_LENGTH - 1)}😀 and more`
    await putVersionRow({
      id: 'v-long',
      workspaceId,
      documentId: sketch.documentId,
      label: stored,
      createdAt: 1,
      frontiers: new Uint8Array(encodeFrontiers(record.oplogFrontiers())),
    })

    const { versions, leftBehind } = await readCarriedPlanes(record, workspaceId)

    expect(leftBehind).toEqual([])
    expect(versions[0]?.label).toBe('a'.repeat(VERSION_LABEL_MAX_LENGTH - 1))
    expect(
      promoteWorkspaceRequestSchema.safeParse({ snapshot: 'AAAA', trash: [], versions }).success,
    ).toBe(true)
  })

  it('omits an empty stored label, which the wire refuses', async () => {
    const { record, workspaceId, sketch } = await seedWorkspace()
    await putVersionRow({
      id: 'v-empty',
      workspaceId,
      documentId: sketch.documentId,
      label: '',
      createdAt: 1,
      frontiers: new Uint8Array(encodeFrontiers(record.oplogFrontiers())),
    })

    const { versions } = await readCarriedPlanes(record, workspaceId)

    expect(versions).toHaveLength(1)
    expect(versions[0]).not.toHaveProperty('label')
  })

  it('names a version the record cannot check out and does not send it', async () => {
    const { record, workspaceId, sketch } = await seedWorkspace()
    const elsewhere = new LoroDoc()
    elsewhere.getText('t').insert(0, 'a history this record never saw')
    elsewhere.commit()
    await putVersionRow({
      id: 'v-foreign',
      workspaceId,
      documentId: sketch.documentId,
      createdAt: 1,
      frontiers: new Uint8Array(encodeFrontiers(elsewhere.oplogFrontiers())),
    })

    const planes = await readCarriedPlanes(record, workspaceId)

    expect(planes.versions).toEqual([])
    expect(planes.leftBehind).toEqual(['1 saved version could not be read'])
  })

  it('leaves out a version of another workspace or of a document the record does not hold', async () => {
    const { record, workspaceId, sketch } = await seedWorkspace()
    const frontiers = new Uint8Array(encodeFrontiers(record.oplogFrontiers()))
    await putVersionRow({
      id: 'v-other-workspace',
      workspaceId: generateDocumentId(),
      documentId: sketch.documentId,
      createdAt: 1,
      frontiers,
    })
    await putVersionRow({
      id: 'v-unheld',
      workspaceId,
      documentId: generateDocumentId(),
      createdAt: 1,
      frontiers,
    })

    const planes = await readCarriedPlanes(record, workspaceId)

    expect(planes.versions).toEqual([])
    expect(planes.leftBehind).toEqual([])
  })

  it('names a part of the record this build cannot judge, so the browser copy stays', async () => {
    // Pictures named only by such a node are absent from the scan's referenced
    // set, so they are never sent and never counted missing: this line is the
    // demote gate's only knowledge of them.
    const { record, workspaceId } = await seedWorkspace()
    const node = record
      .getTree('tree')
      .getNodes()
      .find((each) => each.data.get('kind') === 'spatial')
    if (node === undefined) throw new Error('no spatial node in the tree')
    node.data.set('kind', 'future-kind')
    record.commit()

    const planes = await readCarriedPlanes(record, workspaceId)

    expect(planes.leftBehind).toContain(
      'part of the workspace could not be read by this version of the app',
    )
  })

  it('names a trash entry whose bytes are gone and carries nothing for it', async () => {
    const { record, workspaceId } = await seedWorkspace()
    const entry = readTrashEntries(record)[0]
    if (entry === undefined) throw new Error('no trash entry')
    await new IdbBlobStore().delete({ ref: entry.blob })

    const planes = await readCarriedPlanes(record, workspaceId)

    expect(planes.trash).toEqual([])
    expect(planes.trashPaths.size).toBe(0)
    expect(planes.leftBehind).toEqual([
      'the trashed document "gone" cannot be read in this browser',
    ])
  })

  it('names a trash entry whose bytes are no document, as unreadable', async () => {
    const { record, workspaceId } = await seedWorkspace()
    const entry = readTrashEntries(record)[0]
    if (entry === undefined) throw new Error('no trash entry')
    // Filed under the entry's own key, so the read succeeds and the import is what fails.
    await inTransaction(whiteboardDbName(), [BLOBS_STORE], 'readwrite', (tx) =>
      request(
        tx
          .objectStore(BLOBS_STORE)
          .put({ v: 1, bytes: new Uint8Array([1, 2, 3]) }, blobRefKey(entry.blob)),
      ),
    )

    const planes = await readCarriedPlanes(record, workspaceId)

    expect(planes.trash).toEqual([])
    expect(planes.leftBehind).toEqual([
      'the trashed document "gone" cannot be read in this browser',
    ])
  })
})

describe('unconfirmedPlanes, versions', () => {
  it('counts saved versions the keeper did not keep, in the plural', () => {
    const version = (id: string) => ({
      id,
      documentId: 'd',
      createdAt: 0,
      auto: false,
      frontiers: '',
    })
    expect(
      unconfirmedPlanes(
        { trash: [], versions: [version('a'), version('b')] },
        { trashStored: [], versionsKept: [] },
        'the daemon',
      ),
    ).toEqual(['2 saved versions did not reach the daemon'])
  })
})
