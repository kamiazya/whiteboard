/**
 * What a cross-origin transfer carries BESIDE the record, end to end on the
 * web side over real IndexedDB: the sender reads the payload, the offer
 * crosses the protocol's own gate, and the receiver posts it to its keeper as
 * a promote. The keeper here does what the daemon's promote does with the
 * carried planes — the bytes must hash to the entry's digest and re-import as
 * the document; a version's frontier must check out to the document it
 * names — so a trash entry that restores and a labelled version that lists
 * are what the test holds the transfer to. The daemon's side of the same body
 * is pinned in mcp-server's workspace-promote.test.ts.
 */

import {
  type PromoteWorkspaceRequest,
  promoteWorkspaceRequestSchema,
} from '@kamiazya/whiteboard-daemon-client/api-contracts/promotion'
import {
  importWorkspaceSubtree,
  projectWorkspaceDocument,
  readTrashEntries,
  resolveWorkspaceDocumentById,
  writeSpatialCanvas,
} from '@kamiazya/whiteboard-loro-adapter'
import { base64UrlToBytes } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { decodeFrontiers, LoroDoc } from 'loro-crdt'
import { beforeEach, describe, expect, it } from 'vitest'
import { clearWhiteboardDb } from '../test-utils/browser-document.js'
import { claimIsolatedWhiteboardDb } from '../test-utils/isolated-whiteboard-db.js'
import { jsonResponse } from '../test-utils/json-response.js'
import { seedWorkspaceDocumentContent } from '../test-utils/seed-workspace-content.js'
import { acceptTransferredRecord } from './accept-transferred-record.js'
import { ensureBrowserWorkspace } from './browser-document-summary.js'
import { BrowserVersionStore } from './browser-version-store.js'
import { BrowserWorkspaceDocs } from './browser-workspace-docs.js'
import { getBrowserWorkspaceId } from './browser-workspace-id.js'
import { CROSS_ORIGIN_TRANSFER_PROTOCOL } from './cross-origin-transfer-protocol.js'
import { FoldingBrowserIndex } from './folding-browser-index.js'
import { readOfferedTransfer } from './receive-transfer.js'
import { type PopupHandle, sendTransfer } from './send-transfer.js'
import { readTransferPayload } from './transfer-payload.js'

claimIsolatedWhiteboardDb('transfer-carried')

const KEEPER = 'https://keeper.example'
const SELF = 'https://app.example'
const NONCE = 'n'.repeat(32)

/** A canvas holding one text node, as the snapshot a document's content is seeded from. */
function canvasSaying(text: string): Uint8Array {
  const content = new LoroDoc()
  const node = textNode({ id: 't', x: 0, y: 0, width: 80, height: 40, text })
  writeSpatialCanvas(content, { nodes: [node], edges: [] })
  return new Uint8Array(content.export({ mode: 'snapshot' }))
}

/** A browser workspace with a labelled version of a live canvas and one trashed canvas. */
async function seedWorkspace() {
  const index = new FoldingBrowserIndex()
  await ensureBrowserWorkspace(index)
  const workspaceId = getBrowserWorkspaceId()
  const sketch = await index.createDocument({ workspaceId, path: 'sketch', kind: 'spatial' })
  const gone = await index.createDocument({ workspaceId, path: 'gone', kind: 'spatial' })
  expect(await seedWorkspaceDocumentContent(gone.documentId, canvasSaying('bin me'))).toBe(true)
  const drafted = await new BrowserVersionStore({
    docs: new BrowserWorkspaceDocs(),
    index,
  }).save(workspaceId, 'sketch', { label: 'as drafted' })
  await index.deleteDocument({ workspaceId, path: 'gone' })
  return { sketch, gone, drafted }
}

/**
 * The offer as the receiving window sees it: what `sendTransfer` posts to
 * the popup, read back through the receiver's gate.
 */
async function offerAsReceived() {
  const posted: unknown[] = []
  const popup: PopupHandle = {
    closed: false,
    postMessage: (message) => posted.push(message),
  }
  const sent = sendTransfer({
    keeperBaseUrl: KEEPER,
    senderOrigin: SELF,
    nonce: NONCE,
    payload: readTransferPayload(new BrowserWorkspaceDocs()),
    openWindow: () => popup,
    closedPollMs: 10,
  })
  window.dispatchEvent(
    new MessageEvent('message', {
      origin: KEEPER,
      data: { type: 'transfer-ready', protocol: CROSS_ORIGIN_TRANSFER_PROTOCOL, nonce: NONCE },
    }),
  )
  await expect.poll(() => posted.length).toBe(1)
  const offer = readOfferedTransfer(
    { senderOrigin: SELF, nonce: NONCE },
    {
      origin: SELF,
      data: posted[0],
    },
  )
  return { offer, sent }
}

/** A keeper whose promote answers it holds what the body carried, keeping the body. */
function keeper() {
  const promotes: PromoteWorkspaceRequest[] = []
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith('/workspace-document/promote')) {
      const body = promoteWorkspaceRequestSchema.parse(JSON.parse(String(init?.body)))
      promotes.push(body)
      return jsonResponse({
        ok: true,
        attested: false,
        recorded: [],
        shadowed: [],
        trashStored: (body.trash ?? []).map((each) => each.documentId),
        versionsKept: (body.versions ?? []).map((each) => each.id),
      })
    }
    if (url.endsWith('/documents')) return jsonResponse({ documents: [] })
    throw new Error(`unexpected fetch: ${url}`)
  }) as typeof globalThis.fetch
  return { fetch, promotes }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes)))
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

describe('a cross-origin transfer, what travels beside the record', () => {
  beforeEach(clearWhiteboardDb)

  it('lands a trash entry that restores and a labelled version that lists', async () => {
    const { gone, sketch, drafted } = await seedWorkspace()
    const { offer } = await offerAsReceived()
    if (offer.kind !== 'offer') throw new Error(`offer ${offer.kind}`)
    const destination = keeper()
    const outcome = await acceptTransferredRecord({
      fetch: destination.fetch,
      workspaceId: 'ws-there',
      ...offer,
    })
    expect(outcome).toMatchObject({ ok: true, leftBehind: [] })

    const [body] = destination.promotes
    if (body === undefined) throw new Error('no promote')
    const record = new LoroDoc()
    record.import(base64UrlToBytes(body.snapshot) ?? new Uint8Array())

    // The trash entry restores: its bytes are the ones it names, and they
    // re-import as the document it was.
    const entry = readTrashEntries(record).find((each) => each.documentId === gone.documentId)
    const bytes = base64UrlToBytes(
      body.trash?.find((each) => each.documentId === gone.documentId)?.bytes ?? '',
    )
    if (entry === undefined || bytes === null) throw new Error('trash entry not carried')
    expect(await sha256Hex(bytes)).toBe(entry.blob.digestHex)
    expect(importWorkspaceSubtree(record, bytes, undefined)).not.toBeNull()
    expect(resolveWorkspaceDocumentById(record, gone.documentId)).not.toBeNull()

    // The labelled version lists: its row arrived, and its frontier checks
    // out to the document it names.
    const version = body.versions?.find((each) => each.id === drafted.id)
    expect(version).toMatchObject({ documentId: sketch.documentId, label: 'as drafted' })
    const past = record.fork()
    past.checkout(decodeFrontiers(base64UrlToBytes(version?.frontiers ?? '') ?? new Uint8Array()))
    expect(projectWorkspaceDocument(past, sketch.documentId)).not.toBeNull()
  })

  it('names what the keeper did not confirm holding', async () => {
    await seedWorkspace()
    const { offer } = await offerAsReceived()
    if (offer.kind !== 'offer') throw new Error(`offer ${offer.kind}`)
    const silent = (async (input: RequestInfo | URL) =>
      String(input).endsWith('/documents')
        ? jsonResponse({ documents: [] })
        : jsonResponse({ ok: true, attested: false, recorded: [], shadowed: [] })) as typeof fetch
    expect(
      await acceptTransferredRecord({ fetch: silent, workspaceId: 'ws-there', ...offer }),
    ).toMatchObject({
      ok: true,
      leftBehind: [
        '1 trashed document did not reach the keeper',
        '1 saved version did not reach the keeper',
      ],
    })
  })
})
