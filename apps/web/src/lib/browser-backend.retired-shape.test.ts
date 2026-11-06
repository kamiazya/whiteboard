/**
 * The browser keeper refuses an update that newly writes a shape an older
 * version stored and this one no longer reads, as the daemon does: a short
 * push naming `x-whiteboard` still reaches the full judge, and the session is
 * handed the record it had.
 */
import {
  createWorkspaceDocumentAtPath,
  type DocumentContainers,
  documentContainers,
  readSpatialCanvas,
  writeSpatialCanvas,
} from '@kamiazya/whiteboard-loro-adapter'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import type { WorkspaceDocs } from '@kamiazya/whiteboard-workspace-index'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, it, vi } from 'vitest'
import { expectLoggedFailure } from '../test-utils/logged-failures.js'
import { BrowserBackend } from './browser-backend.js'
import { writeRefusalReason } from './write-refusal-store.js'

// jsdom has no IndexedDB, so the timestamp touch is replaced by its
// outcome; see browser-backend.read-failure.test.ts.
vi.mock('./loro-store.js', () => ({ LoroStore: class {}, touchContentTimestamp: async () => {} }))

const BOARD = {
  documentId: '01ARZ3NDEKTSV4RRFFQ69G5FAW',
  path: 'board',
  kind: 'spatial' as const,
}

async function connectedBoard() {
  const record = new LoroDoc()
  createWorkspaceDocumentAtPath(record, { ...BOARD })
  writeSpatialCanvas(documentContainers(record, BOARD.documentId), {
    nodes: [textNode({ id: 'a', x: 0, y: 0, width: 100, height: 60, text: 'a' })],
    edges: [],
  })
  let saves = 0
  const docs = {
    create: async () => record,
    save: async () => {
      saves += 1
      return null
    },
  } as unknown as WorkspaceDocs
  const backend = new BrowserBackend(BOARD, docs)
  const refusals: { code: string | null; message: string }[] = []
  const snapshots: Uint8Array[] = []
  backend.connect({
    onConnected: () => {},
    onSnapshot: (bytes: Uint8Array) => snapshots.push(bytes),
    onRemoteUpdate: () => {},
    onError: () => {},
    onWriteRefused: (refusal: { code: string | null; message: string }) => refusals.push(refusal),
  } as never)
  await vi.waitFor(() => expect(snapshots).toHaveLength(1))
  const session = LoroDoc.fromSnapshot(snapshots[0] as Uint8Array)
  const pushEdit = (edit: (board: DocumentContainers) => void) => {
    const from = session.oplogVersion()
    edit(documentContainers(session, BOARD.documentId))
    session.commit()
    return backend.pushLocalUpdate(session.export({ mode: 'update', from }))
  }
  return { refusals, snapshots, saves: () => saves, pushEdit, record }
}

describe('a retired shape pushed to a browser-kept canvas', () => {
  it('is refused, and the session is handed the record unchanged', async () => {
    const { refusals, snapshots, saves, pushEdit, record } = await connectedBoard()

    await pushEdit((board) =>
      board.getMap('nodes').set('old', { id: 'old', 'x-whiteboard': { a: 1 } }),
    )

    await expectLoggedFailure('refused an update past a text limit')
    expect(refusals).toEqual([{ code: 'retired_stored_shape', message: '' }])
    expect(saves()).toBe(0)
    expect(snapshots).toHaveLength(2)
    const handed = LoroDoc.fromSnapshot(snapshots[1] as Uint8Array)
    expect(
      readSpatialCanvas(documentContainers(handed, BOARD.documentId)).nodes.map((n) => n.id),
    ).toEqual(['a'])
    expect(
      readSpatialCanvas(documentContainers(record, BOARD.documentId)).nodes.map((n) => n.id),
    ).toEqual(['a'])
  })

  it('is refused as the comment plane for a row in the flat comments map', async () => {
    const { refusals, pushEdit } = await connectedBoard()

    await pushEdit((board) => board.getMap('comments').set('c1', { id: 'c1' }))

    await expectLoggedFailure('refused an update past a text limit')
    expect(refusals.map((refusal) => refusal.code)).toEqual(['retired_comment_plane'])
  })

  it('says why in words for both codes', () => {
    for (const code of ['retired_stored_shape', 'retired_comment_plane'] as const) {
      expect(writeRefusalReason({ code, message: '' })).toMatch(/older version/)
    }
  })
})
