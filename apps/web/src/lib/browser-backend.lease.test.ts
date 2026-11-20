// @vitest-environment node
/**
 * The workspace record a backend opens is given back on every way a
 * connection can end: asserted by the handle the engine minted, so a handle
 * closed twice cannot hide one that leaked.
 */
import {
  documentContainers,
  readMarkdownBody,
  writeMarkdownBody,
} from '@kamiazya/whiteboard-loro-adapter'
import { LoroDoc } from 'loro-crdt'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { InMemoryRecordDocs } from '../test-utils/in-memory-record-docs.js'
import { expectLoggedFailure } from '../test-utils/logged-failures.js'
import { watchEngineHandles } from '../test-utils/replica-lease.js'
import { BrowserBackend } from './browser-backend.js'

const TARGET = {
  documentId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
  path: 'notes',
  kind: 'markdown' as const,
}

afterEach(() => vi.restoreAllMocks())

function connect(backend: BrowserBackend) {
  const snapshots: Uint8Array[] = []
  const errors: string[] = []
  backend.connect({
    onConnected: () => {},
    onSnapshot: (bytes: Uint8Array) => snapshots.push(bytes),
    onRemoteUpdate: () => {},
    onError: (reason: string) => errors.push(reason),
  } as never)
  return { snapshots, errors }
}

describe('the workspace record a BrowserBackend holds', () => {
  it('is given back when the backend disconnects', async () => {
    const handles = await watchEngineHandles()
    const backend = new BrowserBackend(TARGET, new InMemoryRecordDocs())
    const { snapshots } = connect(backend)
    await vi.waitFor(() => expect(snapshots).toHaveLength(1))
    expect(handles.minted().length).toBeGreaterThan(0)

    backend.disconnect()

    await vi.waitFor(() => expect(handles.unaccounted()).toEqual([]))
  })

  it('is given back by a reconnect, which opens another', async () => {
    const handles = await watchEngineHandles()
    const backend = new BrowserBackend(TARGET, new InMemoryRecordDocs())
    const first = connect(backend)
    await vi.waitFor(() => expect(first.snapshots).toHaveLength(1))
    const second = connect(backend)
    await vi.waitFor(() => expect(second.snapshots).toHaveLength(1))

    backend.disconnect()

    await vi.waitFor(() => expect(handles.unaccounted()).toEqual([]))
    expect(handles.minted().length).toBeGreaterThanOrEqual(2)
  })

  it('is given back when the backend is disconnected before the record arrives', async () => {
    const handles = await watchEngineHandles()
    const backend = new BrowserBackend(TARGET, new InMemoryRecordDocs())
    connect(backend)
    backend.disconnect()

    await vi.waitFor(() => expect(handles.minted().length).toBeGreaterThan(0))
    await vi.waitFor(() => expect(handles.unaccounted()).toEqual([]))
  })

  it('is given back when the document cannot be placed', async () => {
    const handles = await watchEngineHandles()
    const docs = new InMemoryRecordDocs()
    // Another document already owns the path this one wants.
    const seeded = new BrowserBackend({ ...TARGET, documentId: '01ARZ3NDEKTSV4RRFFQ69G5FAW' }, docs)
    const first = connect(seeded)
    await vi.waitFor(() => expect(first.snapshots).toHaveLength(1))
    seeded.disconnect()
    const backend = new BrowserBackend(TARGET, docs)
    const { errors } = connect(backend)
    await vi.waitFor(() => expect(errors).toEqual(['read-unavailable']))
    await expectLoggedFailure('another document owns the target path')
    backend.disconnect()

    await vi.waitFor(() => expect(handles.unaccounted()).toEqual([]))
  })

  it('stays open for a push still queued when the backend disconnects, then is given back', async () => {
    const handles = await watchEngineHandles()
    const docs = new InMemoryRecordDocs()
    const backend = new BrowserBackend(TARGET, docs)
    const { snapshots } = connect(backend)
    await vi.waitFor(() => expect(snapshots).toHaveLength(1))
    const session = new LoroDoc()
    session.import(snapshots[0] as Uint8Array)
    const from = session.oplogVersion()
    writeMarkdownBody(documentContainers(session, TARGET.documentId), 'typed before the switch')
    session.commit()

    const pushed = backend.pushLocalUpdate(session.export({ mode: 'update', from }))
    backend.disconnect()
    await pushed

    const stored = docs.openDoc()
    expect(stored && readMarkdownBody(documentContainers(stored, TARGET.documentId))).toBe(
      'typed before the switch',
    )
    await vi.waitFor(() => expect(handles.unaccounted()).toEqual([]))
  })
})
