/**
 * A whole-canvas commit deletes only what the editor could see. The editor's
 * canvas comes from `readSpatialCanvas`, which omits any record this build's
 * schema cannot read, so a write that treated every stored id absent from it
 * as removed would erase a newer client's records as an op that ships.
 */
import {
  readSpatialCanvas,
  writeSpatialCanvas,
  writeSpatialNode,
} from '@kamiazya/whiteboard-loro-adapter'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { LoroDoc } from 'loro-crdt'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openTestSession } from '../test-utils/document-sync-session.js'
import { COMMIT_DEBOUNCE_MS } from './document-sync-session.js'
import { applyCommand, type EditorCommand } from './spatial/commands.js'

const A = textNode({ id: 'a', x: 0, y: 0, width: 100, height: 40, text: 'A' })
const canvas: SpatialCanvas = { nodes: [A], edges: [] }

function snapshotWithUnreadable(): Uint8Array {
  const doc = new LoroDoc()
  writeSpatialCanvas(doc, canvas)
  doc.getMap('nodes').set('future-node', { ...A, id: 'future-node', fieldFromTheFuture: 1 })
  doc.commit()
  return doc.export({ mode: 'snapshot' })
}

function openSession(snapshot: Uint8Array) {
  return openTestSession({ snapshot })
}

function stored(session: ReturnType<typeof openSession>['session']): LoroDoc {
  const doc = new LoroDoc()
  doc.import(session.exportSnapshot()!)
  return doc
}

function storedNodeIds(session: ReturnType<typeof openSession>['session']): string[] {
  return Object.keys(stored(session).getMap('nodes').toJSON()).sort()
}

/** The commit landed: the edit is in the document, not only on screen. */
function storedColorOfA(session: ReturnType<typeof openSession>['session']): string | undefined {
  return readSpatialCanvas(stored(session)).nodes.find((n) => n.id === 'a')?.color
}

afterEach(() => {
  vi.useRealTimers()
})

describe('an editor command with no fine-grained write', () => {
  it('leaves a record this build cannot read in the document', async () => {
    vi.useFakeTimers()
    const { session } = openSession(snapshotWithUnreadable())
    expect(session.getCanvas().nodes.map((n) => n.id)).toEqual(['a'])

    const command: EditorCommand = { kind: 'set-node-color', id: 'a', color: '1' }
    session.onChange(applyCommand(session.getCanvas(), command), command)
    await vi.advanceTimersByTimeAsync(COMMIT_DEBOUNCE_MS)

    expect(storedColorOfA(session)).toBe('1')
    expect(storedNodeIds(session)).toEqual(['a', 'future-node'])
    session.dispose()
  })

  it('leaves a peer record that merged inside the debounce window', async () => {
    vi.useFakeTimers()
    const snapshot = snapshotWithUnreadable()
    const { session, handlers } = openSession(snapshot)
    const command: EditorCommand = { kind: 'set-node-color', id: 'a', color: '1' }
    session.onChange(applyCommand(session.getCanvas(), command), command)

    const peer = new LoroDoc()
    peer.import(snapshot)
    writeSpatialNode(peer, { ...A, id: 'peer', x: 300 })
    handlers().onRemoteUpdate(peer.export({ mode: 'update' }))
    await vi.advanceTimersByTimeAsync(COMMIT_DEBOUNCE_MS)

    expect(storedColorOfA(session)).toBe('1')
    expect(storedNodeIds(session)).toEqual(['a', 'future-node', 'peer'])
    session.dispose()
  })
})
