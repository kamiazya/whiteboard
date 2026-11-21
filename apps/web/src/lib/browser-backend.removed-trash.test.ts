/**
 * A document an update removes from the browser-kept workspace goes to the
 * trash as the daemon's import puts it there: its bytes stored first, then the
 * row naming them, so the document can be restored under its own id.
 */
import {
  createWorkspaceDocumentAtPath,
  deleteWorkspaceNodeAtPath,
  readTrashEntries,
  readWorkspaceDocuments,
} from '@kamiazya/whiteboard-loro-adapter'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, it, vi } from 'vitest'
import { docsOverRecord } from '../test-utils/replica-lease.js'
import { BrowserBackend } from './browser-backend.js'

vi.mock('./content-timestamp.js', () => ({ touchContentTimestamp: async () => {} }))

const TARGET = {
  documentId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
  path: 'notes',
  kind: 'markdown' as const,
}
const OTHER = '01ARZ3NDEKTSV4RRFFQ69G5FAW'

async function connected() {
  const record = new LoroDoc()
  createWorkspaceDocumentAtPath(record, {
    path: TARGET.path,
    documentId: TARGET.documentId,
    kind: 'markdown',
  })
  createWorkspaceDocumentAtPath(record, { path: 'other', documentId: OTHER, kind: 'markdown' })
  const { docs, stored } = await docsOverRecord(record)
  const blobs = new HeldBlobs()
  const backend = new BrowserBackend(TARGET, docs, blobs as never)
  let snapshot: Uint8Array | null = null
  backend.connect({
    onConnected: () => {},
    onSnapshot: (bytes: Uint8Array) => {
      snapshot = bytes
    },
    onRemoteUpdate: () => {},
    onError: () => {},
  } as never)
  await vi.waitFor(() => expect(snapshot).not.toBeNull())
  const session = LoroDoc.fromSnapshot(snapshot as unknown as Uint8Array)
  return { backend, session, stored, blobs }
}

/** A blob store that only remembers which refs were put. */
class HeldBlobs {
  readonly held = new Set<string>()
  async put(input: { bytes: Uint8Array }) {
    const digestHex = Array.from(
      new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(input.bytes))),
      (byte) => byte.toString(16).padStart(2, '0'),
    ).join('')
    this.held.add(digestHex)
    return { ref: { algorithm: 'sha-256' as const, digestHex } }
  }
}

describe('an update that removes a document from a browser-kept workspace', () => {
  it('leaves it in the trash with its bytes stored, under its own id and path', async () => {
    const { backend, session, stored, blobs } = await connected()
    const from = session.oplogVersion()
    deleteWorkspaceNodeAtPath(session, 'other')
    session.commit()

    await backend.pushLocalUpdate(session.export({ mode: 'update', from }))

    const after = stored()
    expect(readWorkspaceDocuments(after).map((entry) => entry.documentId)).toEqual([
      TARGET.documentId,
    ])
    const [entry] = readTrashEntries(after)
    expect([entry?.documentId, entry?.path]).toEqual([OTHER, 'other'])
    expect(blobs.held.has(entry?.blob.digestHex ?? '')).toBe(true)
  })
})
