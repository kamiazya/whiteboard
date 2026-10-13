// @vitest-environment node
/**
 * What a move to the daemon carries beside the record, as the request and
 * the result say it: the planes in the body, every image a trashed document
 * or a saved version names, and one sentence per thing left behind.
 *
 * Node rather than jsdom for the IndexedDB reads: fake-indexeddb clones a
 * row's `Uint8Array` frontiers into jsdom's realm, where the version store's
 * `z.instanceof(Uint8Array)` skips the row. Real IndexedDB is
 * promote-workspace.carried.browser.test.tsx.
 */
import 'fake-indexeddb/auto'
import type { PromoteWorkspaceRequest } from '@kamiazya/whiteboard-daemon-client/api-contracts/promotion'
import { readTrashEntries, writeSpatialCanvas } from '@kamiazya/whiteboard-loro-adapter'
import { newImageRef } from '@kamiazya/whiteboard-model'
import { fileNode } from '@kamiazya/whiteboard-model/test-utils'
import { StoredDocumentUnreadableError } from '@kamiazya/whiteboard-ports'
import type { WorkspaceDocs } from '@kamiazya/whiteboard-workspace-index'
import { LoroDoc } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearWhiteboardDb } from '../test-utils/browser-document.js'
import { claimIsolatedWhiteboardDb } from '../test-utils/isolated-whiteboard-db.js'
import { jsonResponse } from '../test-utils/json-response.js'
import { expectLoggedFailure } from '../test-utils/logged-failures.js'
import { seedWorkspaceDocumentContent } from '../test-utils/seed-workspace-content.js'
import { ensureBrowserWorkspace } from './browser-document-summary.js'
import { BrowserVersionStore } from './browser-version-store.js'
import { BrowserWorkspaceDocs } from './browser-workspace-docs.js'
import { getBrowserWorkspaceId } from './browser-workspace-id.js'
import { readCarriedPlanes } from './carried-planes.js'
import { DocumentFileStore } from './document-file-store.js'
import { FoldingBrowserIndex } from './folding-browser-index.js'
import { IdbBlobStore } from './idb-blob-store.js'
import { promoteWorkspace } from './promote-workspace.js'

// The real reader, spied so one case can make it fail.
vi.mock('./carried-planes.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./carried-planes.js')>()
  return { ...actual, readCarriedPlanes: vi.fn(actual.readCarriedPlanes) }
})

claimIsolatedWhiteboardDb('promote-workspace-carried-node')

const BASE = 'http://127.0.0.1:3099'

/** A daemon as fetch routes, keeping each promote body and each file PUT's path. */
function daemonStub(options: { confirms: boolean }) {
  const promotes: PromoteWorkspaceRequest[] = []
  const putFiles: string[] = []
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()
    if (url.endsWith('/workspace-document/promote') && init?.method === 'POST') {
      const body = JSON.parse(init.body as string) as PromoteWorkspaceRequest
      promotes.push(body)
      return Response.json({
        ok: true,
        recorded: [],
        shadowed: [],
        trashStored: options.confirms ? (body.trash ?? []).map((each) => each.documentId) : [],
        versionsKept: options.confirms ? (body.versions ?? []).map((each) => each.id) : [],
      })
    }
    if (url.includes('/file/') && init?.method === 'PUT') {
      putFiles.push(decodeURIComponent(url.slice(url.indexOf('/document/'))))
      return new Response(null, { status: 204 })
    }
    if (url.endsWith('/documents')) return jsonResponse({ documents: [] })
    throw new Error(`unexpected fetch: ${url}`)
  }) as typeof globalThis.fetch
  return { fetch, promotes, putFiles }
}

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

async function storePicture(id: string) {
  await new DocumentFileStore().put(newImageRef(id), {
    mimeType: 'image/png',
    blob: new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' }),
    created: Date.now(),
  })
}

async function newWorkspace() {
  const index = new FoldingBrowserIndex()
  await ensureBrowserWorkspace(index)
  return { index, workspaceId: getBrowserWorkspaceId() }
}

/** A canvas at `path` drawing `imageId`, then moved to the trash. */
async function trashedCanvas(index: FoldingBrowserIndex, path: string, imageId: string) {
  const workspaceId = getBrowserWorkspaceId()
  const created = await index.createDocument({ workspaceId, path, kind: 'spatial' })
  await storePicture(imageId)
  expect(await seedWorkspaceDocumentContent(created.documentId, canvasWith(imageId))).toBe(true)
  await index.deleteDocument({ workspaceId, path })
  return created
}

const promote = (fetch: typeof globalThis.fetch) =>
  promoteWorkspace({
    fetch,
    keeperBaseUrl: BASE,
    workspaceId: 'ws-a',
    workspaceDocs: new BrowserWorkspaceDocs(),
  })

describe('promoteWorkspace, the planes beside the record', () => {
  beforeEach(clearWhiteboardDb)
  afterEach(() => {
    vi.mocked(readCarriedPlanes).mockClear()
  })

  it('sends a workspace holding only trash its entry and uploads its image under its path', async () => {
    const { index } = await newWorkspace()
    const gone = await trashedCanvas(index, 'gone', 'only-in-the-trash')
    const daemon = daemonStub({ confirms: true })

    const result = await promote(daemon.fetch)

    expect(result).toEqual(expect.objectContaining({ kind: 'ok', leftBehind: [] }))
    expect(daemon.promotes[0]?.trash?.map((each) => each.documentId)).toEqual([gone.documentId])
    expect(daemon.putFiles).toEqual(['/document/gone/file/only-in-the-trash'])
  })

  it('uploads an image only a saved version names under a live document path', async () => {
    const { index, workspaceId } = await newWorkspace()
    const docs = new BrowserWorkspaceDocs()
    const sketch = await index.createDocument({ workspaceId, path: 'sketch', kind: 'spatial' })
    await storePicture('only-in-a-version')
    expect(
      await seedWorkspaceDocumentContent(sketch.documentId, canvasWith('only-in-a-version')),
    ).toBe(true)
    const drafted = await new BrowserVersionStore({ docs, index }).save(workspaceId, 'sketch', {
      label: 'as drafted',
    })
    expect(await seedWorkspaceDocumentContent(sketch.documentId, canvasWith('redrawn'))).toBe(true)
    // The live canvas now draws a picture this browser never stored, so the
    // one upload is the picture only the version still draws.
    const daemon = daemonStub({ confirms: true })

    const result = await promote(daemon.fetch)

    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    expect(daemon.promotes[0]?.versions?.map((each) => each.id)).toEqual([drafted.id])
    expect(result.blobs.transferred).toEqual(['only-in-a-version'])
    expect(result.blobs.missing).toEqual(['redrawn'])
    expect(daemon.putFiles).toEqual(['/document/sketch/file/only-in-a-version'])
  })

  it('lists what could not be read before what the daemon did not confirm', async () => {
    const { index, workspaceId } = await newWorkspace()
    await trashedCanvas(index, 'gone', 'only-in-the-trash')
    const docs = new BrowserWorkspaceDocs()
    const sketch = await index.createDocument({ workspaceId, path: 'sketch', kind: 'spatial' })
    expect(await seedWorkspaceDocumentContent(sketch.documentId, canvasWith('live'))).toBe(true)
    await new BrowserVersionStore({ docs, index }).save(workspaceId, 'sketch', { label: 'one' })
    const record = await docs.open(workspaceId)
    const entry = record === null ? undefined : readTrashEntries(record)[0]
    if (entry === undefined) throw new Error('no trash entry')
    await new IdbBlobStore().delete({ ref: entry.blob })

    const result = await promote(daemonStub({ confirms: false }).fetch)

    expect(result).toEqual(
      expect.objectContaining({
        kind: 'ok',
        leftBehind: [
          'the trashed document "gone" cannot be read in this browser',
          '1 saved version did not reach the daemon',
        ],
      }),
    )
  })

  it('sends no plane keys for a workspace with no trash and no versions', async () => {
    const { index, workspaceId } = await newWorkspace()
    await index.createDocument({ workspaceId, path: 'sketch', kind: 'spatial' })
    const daemon = daemonStub({ confirms: true })

    expect((await promote(daemon.fetch)).kind).toBe('ok')

    // A daemon whose strict request schema predates the planes refuses any
    // body that names them, empty or not.
    expect(Object.keys(daemon.promotes[0] ?? {})).toEqual(['snapshot'])
  })

  it('says to update the daemon when it cannot read the planes sent beside the record', async () => {
    const { index } = await newWorkspace()
    await trashedCanvas(index, 'gone', 'only-in-the-trash')
    const olderDaemon = (async () =>
      Response.json(
        { error: 'invalid_body', message: 'snapshot must be base64url' },
        { status: 400 },
      )) as typeof globalThis.fetch

    const result = await promote(olderDaemon)

    expect(result).toEqual({
      kind: 'failed',
      reason:
        'The daemon refused the trash and saved versions sent with the workspace (snapshot must be base64url). If the daemon is older than this page, update it and move again.',
    })
  })

  it('passes a shape refusal of a body carrying no planes through as the daemon said it', async () => {
    const { index, workspaceId } = await newWorkspace()
    await index.createDocument({ workspaceId, path: 'sketch', kind: 'spatial' })
    const refusing = (async () =>
      Response.json(
        { error: 'invalid_body', message: 'snapshot must be base64url' },
        { status: 400 },
      )) as typeof globalThis.fetch

    expect(await promote(refusing)).toEqual({
      kind: 'failed',
      reason: 'snapshot must be base64url',
    })
  })

  it('passes a refusal of the record itself through, planes carried or not', async () => {
    const { index } = await newWorkspace()
    await trashedCanvas(index, 'gone', 'only-in-the-trash')
    const refusing = (async () =>
      Response.json(
        { error: 'malformed_snapshot', message: 'Malformed workspace record snapshot' },
        { status: 400 },
      )) as typeof globalThis.fetch

    expect(await promote(refusing)).toEqual({
      kind: 'failed',
      reason: 'Malformed workspace record snapshot',
    })
  })

  it('fails before anything is sent when the planes cannot be read', async () => {
    await newWorkspace()
    vi.mocked(readCarriedPlanes).mockRejectedValueOnce(new Error('the database closed'))
    const daemon = daemonStub({ confirms: true })

    const result = await promote(daemon.fetch)

    expect(result).toEqual({
      kind: 'failed',
      reason: 'This browser could not read its workspace to move it.',
    })
    expect(daemon.promotes).toEqual([])
    await expectLoggedFailure('carried planes could not be read')
  })
})

const NETWORK_SENTENCE = 'Could not reach the destination (network error).'

function openThrowing(err: unknown): WorkspaceDocs {
  const docs = new BrowserWorkspaceDocs()
  vi.spyOn(docs, 'open').mockRejectedValue(err)
  return docs
}

const promoteFrom = (fetch: typeof globalThis.fetch, workspaceDocs: WorkspaceDocs) =>
  promoteWorkspace({ fetch, keeperBaseUrl: BASE, workspaceId: 'ws-a', workspaceDocs })

describe('promoteWorkspace failure reasons', () => {
  beforeEach(clearWhiteboardDb)
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('a fetch that throws is reported as an unreachable destination', async () => {
    const { index, workspaceId } = await newWorkspace()
    await index.createDocument({ workspaceId, path: 'sketch', kind: 'spatial' })
    const offline = (async () => {
      throw new TypeError('Failed to fetch')
    }) as typeof globalThis.fetch

    expect(await promote(offline)).toEqual({ kind: 'failed', reason: NETWORK_SENTENCE })
  })

  it('an unreadable browser record is reported as unreadable and logged', async () => {
    const daemon = daemonStub({ confirms: true })

    const result = await promoteFrom(
      daemon.fetch,
      openThrowing(new StoredDocumentUnreadableError('malformed', 'a delta does not decode')),
    )

    expect(result).toEqual({
      kind: 'failed',
      reason: "This browser's copy of this workspace could not be read, so it was not moved.",
    })
    expect(daemon.promotes).toEqual([])
    await expectLoggedFailure('stored workspace could not be read; promote abandoned')
  })

  it('a record this device cannot open is reported as a device failure and logged', async () => {
    const daemon = daemonStub({ confirms: true })

    const result = await promoteFrom(
      daemon.fetch,
      openThrowing(new DOMException('the quota has been exceeded', 'QuotaExceededError')),
    )

    expect(result).toEqual({
      kind: 'failed',
      reason: 'This workspace could not be prepared on this device to move it.',
    })
    expect(daemon.promotes).toEqual([])
    await expectLoggedFailure('workspace promote failed on this device')
  })

  it('an image whose stored bytes this device cannot read fails that image alone and is logged', async () => {
    const { index, workspaceId } = await newWorkspace()
    const sketch = await index.createDocument({ workspaceId, path: 'sketch', kind: 'spatial' })
    await storePicture('unreadable-here')
    expect(
      await seedWorkspaceDocumentContent(sketch.documentId, canvasWith('unreadable-here')),
    ).toBe(true)
    // The record names its bytes; the read of those bytes is what fails.
    vi.spyOn(IdbBlobStore.prototype, 'get').mockRejectedValue(
      new DOMException('the read was refused', 'NotReadableError'),
    )
    const daemon = daemonStub({ confirms: true })

    const result = await promote(daemon.fetch)

    if (result.kind !== 'ok')
      throw new Error(`expected the merged move to report, got ${result.kind}`)
    expect(result.blobs).toEqual({
      transferred: [],
      missing: [],
      failed: [{ fileId: 'unreadable-here', reason: 'This browser could not read that image.' }],
    })
    expect(daemon.putFiles).toEqual([])
    await expectLoggedFailure('image could not be read for the move')
  })
})
