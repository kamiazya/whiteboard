/**
 * The session says which content state the person's OWN edit left the
 * document in, so a surface can treat that state as seen. A change that
 * arrives from a peer, an agent or the daemon is not announced: the person did
 * not look at it being made.
 */

import {
  createWorkspaceDocumentAtPath,
  documentContainers,
  resolveWorkspaceDocumentById,
  writeSpatialCanvas,
} from '@kamiazya/whiteboard-loro-adapter'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { LoroDoc } from 'loro-crdt'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { editAndPush, openTestSession, snapshotOf } from '../test-utils/document-sync-session.js'
import type { EditorCommand } from './spatial/commands.js'

const canvas: SpatialCanvas = {
  nodes: [textNode({ id: 'n-a', x: 0, y: 0, width: 100, height: 40, text: 'A' })],
  edges: [],
}

const MOVE: EditorCommand = { kind: 'move-node', id: 'n-a', x: 10, y: 20 }

afterEach(() => {
  vi.useRealTimers()
})

describe('the content state of the person’s own edit', () => {
  it('is announced once the edit has been written to the document', async () => {
    vi.useFakeTimers()
    const states: string[] = []
    const s = openTestSession({
      snapshot: snapshotOf(canvas),
      deps: { onOwnEditContentState: (state) => states.push(state) },
    })
    const opened = s.session.getContentState()

    await editAndPush(s.session, canvas, MOVE)

    expect(states.length).toBeGreaterThan(0)
    expect(states.at(-1)).toBe(s.session.getContentState())
    expect(states.at(-1)).not.toBe(opened)
    s.session.dispose()
  })

  it('is not announced for a change that arrived from elsewhere', () => {
    const states: string[] = []
    const s = openTestSession({
      snapshot: snapshotOf(canvas),
      deps: { onOwnEditContentState: (state) => states.push(state) },
    })
    const peer = new LoroDoc()
    peer.import(snapshotOf(canvas))
    writeSpatialCanvas(peer, {
      ...canvas,
      nodes: [textNode({ id: 'n-a', x: 0, y: 0, width: 100, height: 40, text: 'changed' })],
    })

    s.handlers().onRemoteUpdate(peer.export({ mode: 'update' }))

    expect(s.session.getContentState()).not.toBeNull()
    expect(states).toEqual([])
    s.session.dispose()
  })
})

/**
 * The list compares a recorded state with the digest the workspace index
 * derives for the document's tree node. A workspace-scoped session holds the
 * whole workspace record, so digesting the record's own roots would announce
 * a state no listing ever shows.
 */
describe('the content state announced by a workspace-scoped session', () => {
  const DOC = '01ARZ3NDEKTSV4RRFFQ69G5FAV'

  function workspaceSnapshot(): Uint8Array {
    const record = new LoroDoc()
    createWorkspaceDocumentAtPath(record, { path: 'design', documentId: DOC, kind: 'spatial' })
    writeSpatialCanvas(documentContainers(record, DOC), canvas)
    record.commit()
    return record.export({ mode: 'snapshot' })
  }

  it('is the digest the workspace listing derives for that document', async () => {
    vi.useFakeTimers()
    const states: string[] = []
    const s = openTestSession({
      snapshot: workspaceSnapshot(),
      deps: { contentDocumentId: DOC, onOwnEditContentState: (state) => states.push(state) },
    })

    await editAndPush(s.session, canvas, MOVE)

    const exported = s.session.exportSnapshot()
    expect(exported).not.toBeNull()
    const record = new LoroDoc()
    record.import(exported as Uint8Array)
    const listed = resolveWorkspaceDocumentById(record, DOC)?.contentDigest
    expect(listed).toBeDefined()
    expect(states.at(-1)).toBe(listed)
    s.session.dispose()
  })

  it('is the state getContentState answers, and it moves with an edit', async () => {
    vi.useFakeTimers()
    const s = openTestSession({
      snapshot: workspaceSnapshot(),
      deps: { contentDocumentId: DOC },
    })
    const opened = s.session.getContentState()

    await editAndPush(s.session, canvas, MOVE)

    const exported = s.session.exportSnapshot() as Uint8Array
    const record = new LoroDoc()
    record.import(exported)
    const listed = resolveWorkspaceDocumentById(record, DOC)?.contentDigest
    expect(listed).toBeDefined()
    expect(s.session.getContentState()).toBe(listed)
    expect(s.session.getContentState()).not.toBe(opened)
    s.session.dispose()
  })
})
