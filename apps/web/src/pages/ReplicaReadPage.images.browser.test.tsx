/**
 * The offline page draws the pictures its replica cached: pulled while the
 * daemon was there, then read on a cold start with nothing connected and
 * nothing held in memory — the state a closed tab and a stopped daemon leave.
 */
import { forgetAllForTests } from '@kamiazya/whiteboard-daemon-client/replica-session-key'
import {
  createWorkspaceDocumentAtPath,
  documentContainers,
  writeSpatialCanvas,
} from '@kamiazya/whiteboard-loro-adapter'
import {
  bytesToBase64,
  bytesToBase64Url,
  clipboardFragmentSchema,
  newImageRef,
  nodeFile,
} from '@kamiazya/whiteboard-model'
import { fileNode } from '@kamiazya/whiteboard-model/test-utils'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { LoroDoc } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import { BrowserWorkspaceDocs } from '../lib/browser-workspace-docs.js'
import { carriedClipboardFiles, clearClipboardFragmentForTests } from '../lib/clipboard-store.js'
import { createDaemonFileAdapter } from '../lib/daemon-file-adapter.js'
import { IdbBlobStore } from '../lib/idb-blob-store.js'
import { cacheDaemonWorkspace } from '../lib/replica-cache.js'
import { saveOfflinePasskey } from '../lib/replica-offline-passkey.js'
import { REPLICA_IMAGE_UNAVAILABLE } from '../lib/replica-record.js'
import { REPLICA_STATE_COPY } from '../lib/replica-state-copy.js'
import { connectReplicaKeeper } from '../lib/replica-store.js'
import { rememberReplicaKey } from '../lib/replica-unlock.js'
import { clearWhiteboardDb } from '../test-utils/browser-document.js'
import { claimIsolatedWhiteboardDb } from '../test-utils/isolated-whiteboard-db.js'
import { replicaKeyBody, replicaKeyFetch } from '../test-utils/replica-key-fetch.js'
import { rootOf } from '../test-utils/spatial-editor-root.js'
import { ReplicaReadPage } from './ReplicaReadPage.js'

claimIsolatedWhiteboardDb('replica-read-page-images')

const DAEMON = 'http://127.0.0.1:3099'
const DAEMON_WS = '01ARZ3NDEKTSV4RRFFQ69G5FD0'
const BOARD = '01ARZ3NDEKTSV4RRFFQ69G5FD1'
const SEALED_KEYS = 'whiteboard:replica-sealed-keys'
const OFFLINE_PASSKEYS = 'whiteboard:replica-offline-passkeys'
const IMAGES_KEY = 'whiteboard:replica-images'
const PRF = new Uint8Array(32).fill(11)
const RAW_ID = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8])

/** A 1x1 PNG: real image bytes, so the page has something an <image> can show. */
const PNG = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  ),
  (c) => c.charCodeAt(0),
)

function boardNaming(...fileIds: string[]): LoroDoc {
  const doc = new LoroDoc()
  createWorkspaceDocumentAtPath(doc, { path: 'photo', documentId: BOARD, kind: 'spatial' })
  writeSpatialCanvas(documentContainers(doc, BOARD), {
    nodes: fileIds.map((id, i) =>
      fileNode({ id: `n-${id}`, file: newImageRef(id), x: i * 220, y: 0, width: 200, height: 200 }),
    ),
    edges: [],
  })
  doc.commit()
  return doc
}

/** The daemon while it was there: key, snapshot, and the file route for `serves` alone. */
function daemon(record: LoroDoc, serves: readonly string[]): typeof globalThis.fetch {
  return replicaKeyFetch({}, (url) => {
    if (url.endsWith(`/api/w/${DAEMON_WS}/workspace-document/snapshot`)) {
      return new Response(record.export({ mode: 'snapshot' }) as BodyInit, { status: 200 })
    }
    const file = /\/document\/photo\/file\/([\w-]+)$/.exec(url)?.[1]
    if (file !== undefined && serves.includes(file)) {
      return new Response(PNG as BodyInit, { headers: { 'Content-Type': 'image/png' } })
    }
    return new Response('not found', { status: 404 })
  })
}

/** Pulls the replica, then leaves what closing the tab with the daemon stopped leaves. */
async function pullThenGoOffline(record: LoroDoc, serves: readonly string[]): Promise<void> {
  const fetch = daemon(record, serves)
  connectReplicaKeeper({ baseUrl: DAEMON, fetch })
  const pulled = await cacheDaemonWorkspace({
    fetch,
    daemonBaseUrl: DAEMON,
    workspaceId: DAEMON_WS,
    workspaceDocs: new BrowserWorkspaceDocs(),
  })
  if (pulled.kind !== 'ok') throw new Error(`pull failed: ${pulled.kind}`)
  await rememberReplicaKey({
    daemonBaseUrl: DAEMON,
    workspaceId: DAEMON_WS,
    response: replicaKeyBody(),
    prfOutput: PRF,
  })
  saveOfflinePasskey(DAEMON, DAEMON_WS, { credentialId: bytesToBase64Url(RAW_ID), prfSalt: 'AAAA' })
  connectReplicaKeeper(null)
  forgetAllForTests()
}

/** Opens the copy with the passkey, offline, and selects the board. */
async function unlockAndOpenBoard(): Promise<void> {
  vi.spyOn(navigator.credentials, 'get').mockResolvedValue({
    rawId: RAW_ID.buffer,
    response: {
      authenticatorData: new Uint8Array(37).fill(1).buffer,
      clientDataJSON: new TextEncoder().encode('{"type":"webauthn.get"}').buffer,
      signature: new Uint8Array([7, 7, 7]).buffer,
    },
    getClientExtensionResults: () => ({ prf: { results: { first: PRF.buffer } } }),
  } as unknown as Credential)
  render(<ReplicaReadPage workspaceId={DAEMON_WS} daemonBaseUrl={DAEMON} onReconnect={vi.fn()} />)
  await userEvent.click(
    await screen.findByRole('button', { name: REPLICA_STATE_COPY.unlockable.action }),
  )
  await screen.findByTestId('replica-state-readable')
  await userEvent.click(await screen.findByText('photo'))
}

const drawnText = (): string =>
  [...document.querySelectorAll('svg text')].map((node) => node.textContent ?? '').join(' ')

beforeEach(clearWhiteboardDb)
beforeEach(clearClipboardFragmentForTests)
afterEach(() => {
  vi.restoreAllMocks()
  connectReplicaKeeper(null)
  forgetAllForTests()
  for (const key of [SEALED_KEYS, OFFLINE_PASSKEYS, IMAGES_KEY]) localStorage.removeItem(key)
  cleanup()
})

describe('ReplicaReadPage images', () => {
  it('draws a cached picture offline, from the bytes this device holds', async () => {
    await pullThenGoOffline(boardNaming('img-cat'), ['img-cat'])
    await unlockAndOpenBoard()

    await vi.waitFor(() => {
      const href = document.querySelector('svg image')?.getAttribute('href') ?? ''
      expect(href).toMatch(/^blob:/)
    })
    expect(drawnText()).not.toContain('asset:')
  })

  it('draws a cached picture whose first read from the store fails', async () => {
    await pullThenGoOffline(boardNaming('img-cat'), ['img-cat'])
    vi.spyOn(IdbBlobStore.prototype, 'get').mockRejectedValueOnce(
      new DOMException('busy', 'UnknownError'),
    )
    await unlockAndOpenBoard()

    await vi.waitFor(() => {
      const href = document.querySelector('svg image')?.getAttribute('href') ?? ''
      expect(href).toMatch(/^blob:/)
    })
    expect(drawnText()).not.toContain(REPLICA_IMAGE_UNAVAILABLE)
  })

  it('labels a picture it holds no bytes for as unavailable, never by its raw id', async () => {
    await pullThenGoOffline(boardNaming('img-cat', 'img-gone'), ['img-cat'])
    await unlockAndOpenBoard()

    await vi.waitFor(() => expect(drawnText()).toContain(REPLICA_IMAGE_UNAVAILABLE))
    expect(drawnText()).not.toContain('asset:')
    expect(document.querySelectorAll('svg image')).toHaveLength(1)
  })
})

function clipboardEvent(type: 'copy' | 'paste', data: DataTransfer): void {
  fireEvent(
    rootOf(document.body),
    new ClipboardEvent(type, { bubbles: true, cancelable: true, clipboardData: data }),
  )
}

/** Selects the drawn picture by pressing on it, then copies it. */
async function copyThePicture(): Promise<string> {
  const picture = await vi.waitFor(() => {
    const drawn = document.querySelector('svg image')
    if (drawn === null) throw new Error('no picture drawn yet')
    return drawn.getBoundingClientRect()
  })
  const at = { clientX: picture.x + picture.width / 2, clientY: picture.y + picture.height / 2 }
  const root = rootOf(document.body)
  fireEvent.pointerDown(root, { button: 0, pointerId: 1, ...at })
  fireEvent.pointerUp(root, { pointerId: 1, ...at })
  const data = new DataTransfer()
  clipboardEvent('copy', data)
  return data.getData('text/plain')
}

const DAEMON_SCOPE = createDaemonFileAdapter({
  daemonFetch: globalThis.fetch,
  daemonBaseUrl: DAEMON,
  workspaceId: DAEMON_WS,
  path: '',
}).fileScope

describe('ReplicaReadPage pictures across copy and paste', () => {
  it("stamps a copy with the daemon's scope, so the daemon page keeps its pictures", async () => {
    await pullThenGoOffline(boardNaming('img-cat'), ['img-cat'])
    await unlockAndOpenBoard()

    const copied = clipboardFragmentSchema.parse(JSON.parse(await copyThePicture()))
    expect(copied.nodes.map(nodeFile)).toEqual([newImageRef('img-cat')])
    expect(copied.source?.fileScope).toBe(DAEMON_SCOPE)
    // The bytes come from the sealed cache, so a paste into another workspace can store them.
    const carried = await carriedClipboardFiles(copied.source?.copyId ?? '')
    expect(carried?.[newImageRef('img-cat')]?.dataBase64).toBe(bytesToBase64(PNG))
  })

  it('leaves out a picture from another keeper, saying why, rather than pasting it dangling', async () => {
    await pullThenGoOffline(boardNaming(), [])
    await unlockAndOpenBoard()
    await vi.waitFor(() => expect(rootOf(document.body)).not.toBeNull())

    const foreign = {
      type: 'whiteboard/clipboard',
      version: 1,
      nodes: [fileNode({ id: 'f', x: 0, y: 0, width: 50, height: 50, file: 'asset:elsewhere' })],
      edges: [],
      source: { fileScope: 'browser:http://other.example', copyId: 'c' },
      files: { 'asset:elsewhere': { mimeType: 'image/png', dataBase64: bytesToBase64(PNG) } },
    }
    const data = new DataTransfer()
    data.setData('text/plain', JSON.stringify(foreign))
    clipboardEvent('paste', data)

    await vi.waitFor(() =>
      expect(document.querySelector('[data-testid="clipboard-notice"]')?.textContent).toContain(
        'A picture was left out of the paste: pictures from another workspace are stored by the daemon',
      ),
    )
    expect(drawnText()).not.toContain(REPLICA_IMAGE_UNAVAILABLE)
  })
})
