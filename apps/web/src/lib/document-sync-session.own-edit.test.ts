/**
 * The session says which content state the person's OWN edit left the
 * document in, so a surface can treat that state as seen. A change that
 * arrives from a peer, an agent or the daemon is not announced: the person did
 * not look at it being made.
 */

import { writeSpatialCanvas } from '@kamiazya/whiteboard-loro-adapter'
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
