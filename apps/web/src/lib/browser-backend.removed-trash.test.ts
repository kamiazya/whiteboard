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
import { expectLoggedFailure } from '../test-utils/logged-failures.js'
import { docOf, leaseOf } from '../test-utils/replica-lease.js'
import { BrowserBackend } from './browser-backend.js'

vi.mock('./content-timestamp.js', () => ({ touchContentTimestamp: async () => {} }))

const TARGET = {
  documentId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
  path: 'notes',
  kind: 'markdown' as const,
}
const OTHER = '01ARZ3NDEKTSV4RRFFQ69G5FAW'

/**
 * A store over bytes a test can read back: `create` loads the persisted record
 * afresh, `save` persists what it is given, so a record the backend drops and
 * reloads is the stored one and not the instance it was holding.
 */
function storeOf(seed: LoroDoc) {
  let persisted = seed.export({ mode: 'snapshot' })
  const docs = {
    create: async () => leaseOf(LoroDoc.fromSnapshot(persisted)),
    save: async (_workspaceId: string, record: Parameters<typeof docOf>[0]) => {
      persisted = docOf(record).export({ mode: 'snapshot' })
      return null
    },
    catchUp: async (_workspaceId: string, _record: unknown, cursor: unknown) => ({
      cursor,
      updates: [],
    }),
  } as unknown as ConstructorParameters<typeof BrowserBackend>[1]
  return { docs, stored: () => LoroDoc.fromSnapshot(persisted) }
}

async function connected(blobs: { put: (input: { bytes: Uint8Array }) => Promise<unknown> }) {
  const record = new LoroDoc()
  createWorkspaceDocumentAtPath(record, {
    path: TARGET.path,
    documentId: TARGET.documentId,
    kind: 'markdown',
  })
  createWorkspaceDocumentAtPath(record, { path: 'other', documentId: OTHER, kind: 'markdown' })
  const { docs, stored } = storeOf(record)
  const backend = new BrowserBackend(TARGET, docs, blobs as never)
  const reasons: string[] = []
  let snapshot: Uint8Array | null = null
  backend.connect({
    onConnected: () => {},
    onSnapshot: (bytes: Uint8Array) => {
      snapshot = bytes
    },
    onRemoteUpdate: () => {},
    onError: (reason: string) => reasons.push(reason),
  } as never)
  await vi.waitFor(() => expect(snapshot).not.toBeNull())
  const first = snapshot as unknown as Uint8Array
  const session = () => LoroDoc.fromSnapshot(first)
  return { backend, session, stored, reasons }
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
    const blobs = new HeldBlobs()
    const { backend, session, stored } = await connected(blobs)
    const replica = session()
    const from = replica.oplogVersion()
    deleteWorkspaceNodeAtPath(replica, 'other')
    replica.commit()

    await backend.pushLocalUpdate(replica.export({ mode: 'update', from }))

    const after = stored()
    expect(readWorkspaceDocuments(after).map((entry) => entry.documentId)).toEqual([
      TARGET.documentId,
    ])
    const [entry] = readTrashEntries(after)
    expect([entry?.documentId, entry?.path]).toEqual([OTHER, 'other'])
    expect(blobs.held.has(entry?.blob.digestHex ?? '')).toBe(true)
  })

  it('is refused as a whole when the trash cannot be written, so a later save never persists the removal', async () => {
    const failing = {
      put: async () => {
        throw new Error('quota exceeded')
      },
    }
    const { backend, session, stored, reasons } = await connected(failing)
    const remover = session()
    const from = remover.oplogVersion()
    deleteWorkspaceNodeAtPath(remover, 'other')
    remover.commit()
    await backend.pushLocalUpdate(remover.export({ mode: 'update', from }))
    await expectLoggedFailure('trashing what an update removed failed')
    expect(reasons).toContain('storage-failure')

    // An unrelated edit from a replica that never saw the removal.
    const editor = session()
    const before = editor.oplogVersion()
    editor.getMap('unrelated').set('k', 'v')
    editor.commit()
    await backend.pushLocalUpdate(editor.export({ mode: 'update', from: before }))

    const after = stored()
    expect(
      readWorkspaceDocuments(after)
        .map((entry) => entry.documentId)
        .sort(),
    ).toEqual([TARGET.documentId, OTHER].sort())
    expect(readTrashEntries(after)).toEqual([])
  })
})
