/**
 * Every engine document a session opens is given back: when a snapshot
 * replaces it, when one is refused unread, and when the session is disposed.
 * Judged by the handles the engine minted, so a handle closed twice cannot
 * stand in for another that leaked.
 */

import { writeSpatialCanvas } from '@kamiazya/whiteboard-loro-adapter'
import { LoroDoc } from 'loro-crdt'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  flushMicrotasks,
  markdownSnapshotOf,
  openTestSession,
  snapshotOf,
  typeIntoBody,
} from '../test-utils/document-sync-session.js'
import { watchEngineHandles } from '../test-utils/replica-lease.js'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('the engine documents a session opens', () => {
  it('are all closed once the session that replaced and then disposed them is gone', async () => {
    const handles = await watchEngineHandles()
    const s = openTestSession({ snapshot: markdownSnapshotOf('one') })
    s.handlers().onSnapshot(markdownSnapshotOf('two'))
    s.handlers().onSnapshot(markdownSnapshotOf('three'))

    s.session.dispose()
    await flushMicrotasks()

    expect(handles.minted()).toHaveLength(3)
    expect(handles.unaccounted()).toEqual([])
  })

  it('include one a snapshot in a retired shape was refused with', async () => {
    const handles = await watchEngineHandles()
    const s = openTestSession({ snapshot: snapshotOf({ nodes: [], edges: [] }) })
    const retired = new LoroDoc()
    writeSpatialCanvas(retired, { nodes: [], edges: [] })
    retired.getMap('comments').set('c1', { id: 'c1', x: 0, y: 0, text: 'before threads' })
    retired.commit()

    s.handlers().onSnapshot(retired.export({ mode: 'snapshot' }))
    s.session.dispose()
    await flushMicrotasks()

    expect(handles.minted()).toHaveLength(2)
    expect(handles.unaccounted()).toEqual([])
  })

  it('include the one disposed while typed text was still waiting to be written', async () => {
    const handles = await watchEngineHandles()
    const s = openTestSession({ snapshot: markdownSnapshotOf('hello') })
    typeIntoBody(s.session, 5, ' world')

    s.session.dispose()
    await vi.waitFor(() => expect(handles.unaccounted()).toEqual([]))

    expect(handles.minted()).toHaveLength(1)
  })
})
