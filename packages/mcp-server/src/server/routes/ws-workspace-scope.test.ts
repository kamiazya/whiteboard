/**
 * `?scope=workspace` sockets: same URL and auth as a per-document socket,
 * different subscription granularity. The initial frame is the WORKSPACE
 * document's snapshot; binary frames import into it; fan-out delivers
 * workspace-document updates — never raw per-document-lineage frames, which
 * a workspace replica cannot import (a projection's ops live in a different
 * per-process lineage).
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  documentContainers,
  readSpatialCanvas,
  resolveWorkspaceDocument,
  writeSpatialCanvas,
} from '@kamiazya/whiteboard-loro-adapter'
import { LoroDoc } from 'loro-crdt'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

let tempDir: string

vi.mock('../config.js', () => ({
  get DATA_DIR() {
    return tempDir
  },
  getDataDir: () => tempDir,
  WHITEBOARD_ROOT: '/tmp/whiteboard',
  REPO_ROOT: '/tmp',
}))

const { clearCache } = await import('../store/doc-cache.js')
const { loadDocument, saveDocument, _clearWorkspaceDocCacheForTests } = await import(
  '../store/document-store.js'
)
const { handleWsUpgrade } = await import('./ws.js')
const { createIsolatedDb } = await import('../store/db/test-helpers.js')

let handle: Awaited<ReturnType<typeof createIsolatedDb>>

class FakeWebSocket {
  sent: Array<string | Uint8Array> = []
  closes: Array<{ code?: number; reason?: string }> = []
  private listeners = new Map<string, Array<(...args: unknown[]) => void>>()

  send(data: string | Uint8Array | ArrayBuffer): void {
    if (typeof data === 'string') {
      this.sent.push(data)
      return
    }
    if (data instanceof ArrayBuffer) {
      this.sent.push(new Uint8Array(data))
      return
    }
    this.sent.push(data)
  }

  on(event: string, handler: (...args: unknown[]) => void): void {
    const handlers = this.listeners.get(event) ?? []
    handlers.push(handler)
    this.listeners.set(event, handlers)
  }

  close(code?: number, reason?: string): void {
    this.closes.push({ code, reason })
  }

  async emitMessage(data: Buffer, isBinary: boolean): Promise<void> {
    for (const handler of this.listeners.get('message') ?? []) {
      await handler(data, isBinary)
    }
  }

  emitClose(): void {
    for (const handler of this.listeners.get('close') ?? []) {
      handler()
    }
  }

  binaryFrames(): Uint8Array[] {
    return this.sent.filter((f): f is Uint8Array => typeof f !== 'string')
  }
}

function canvasDoc(ids: string[]): LoroDoc {
  const doc = new LoroDoc()
  writeSpatialCanvas(doc, {
    nodes: ids.map((id) => ({ id, type: 'text', text: id, x: 0, y: 0, width: 10, height: 10 })),
    edges: [],
  })
  return doc
}

async function connect(url: string): Promise<FakeWebSocket> {
  const ws = new FakeWebSocket()
  await handleWsUpgrade({ url, headers: { host: 'localhost:3099' } } as never, ws as never)
  return ws
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'ws-scope-test-'))
  handle = await createIsolatedDb({ dataDir: tempDir })
  clearCache()
  _clearWorkspaceDocCacheForTests()
  await saveDocument('session1', 'c', canvasDoc(['n-a']), { kind: 'spatial' })
})
afterEach(async () => {
  await handle.dispose()
  await rm(tempDir, { recursive: true, force: true })
  clearCache()
  _clearWorkspaceDocCacheForTests()
})

it('a scope=workspace connect answers the WORKSPACE document snapshot', async () => {
  const ws = await connect('/ws/session1/c?scope=workspace')
  expect(ws.closes).toEqual([])
  const frames = ws.binaryFrames()
  expect(frames.length).toBe(1)

  const replica = new LoroDoc()
  replica.import(frames[0] as Uint8Array)
  const entry = resolveWorkspaceDocument(replica, 'c')
  expect(entry).not.toBeNull()
  if (entry === null) return
  const canvas = readSpatialCanvas(documentContainers(replica, entry.documentId))
  expect(canvas.nodes.map((n) => n.id)).toEqual(['n-a'])
})

it('a workspace-scope binary frame persists and reaches the other workspace-scope socket', async () => {
  const sender = await connect('/ws/session1/c?scope=workspace')
  const receiver = await connect('/ws/session1/c?scope=workspace')

  const replica = new LoroDoc()
  replica.import(sender.binaryFrames()[0] as Uint8Array)
  const entry = resolveWorkspaceDocument(replica, 'c')
  expect(entry).not.toBeNull()
  if (entry === null) return
  const from = replica.version()
  writeSpatialCanvas(documentContainers(replica, entry.documentId), {
    nodes: [
      { id: 'n-a', type: 'text', text: 'n-a', x: 0, y: 0, width: 10, height: 10 },
      { id: 'n-b', type: 'text', text: 'n-b', x: 0, y: 0, width: 10, height: 10 },
    ],
    edges: [],
  })
  replica.commit()
  const update = new Uint8Array(replica.export({ mode: 'update', from }))

  const receiverBaseline = receiver.binaryFrames().length
  await sender.emitMessage(Buffer.from(update), true)

  // Persisted: the per-document read serves the imported edit.
  expect(readSpatialCanvas(await loadDocument('session1', 'c')).nodes.map((n) => n.id)).toEqual([
    'n-a',
    'n-b',
  ])

  // The other workspace-scope socket converges by importing what it was sent.
  const received = receiver.binaryFrames().slice(receiverBaseline)
  expect(received.length).toBeGreaterThan(0)
  const receiverReplica = new LoroDoc()
  receiverReplica.import(receiver.binaryFrames()[0] as Uint8Array)
  for (const frame of received) receiverReplica.import(frame)
  const receiverEntry = resolveWorkspaceDocument(receiverReplica, 'c')
  expect(receiverEntry).not.toBeNull()
  if (receiverEntry === null) return
  expect(
    readSpatialCanvas(documentContainers(receiverReplica, receiverEntry.documentId)).nodes.map(
      (n) => n.id,
    ),
  ).toEqual(['n-a', 'n-b'])
})

it('a per-document frame is never raw-forwarded to a workspace-scope socket, which converges anyway', async () => {
  const wsScope = await connect('/ws/session1/c?scope=workspace')
  const plainSender = await connect('/ws/session1/c')
  const plainReceiver = await connect('/ws/session1/c')

  // The per-document client edits in the projection's lineage.
  const perDocReplica = new LoroDoc()
  perDocReplica.import(plainSender.binaryFrames()[0] as Uint8Array)
  const from = perDocReplica.version()
  writeSpatialCanvas(perDocReplica, {
    nodes: [
      { id: 'n-a', type: 'text', text: 'n-a', x: 0, y: 0, width: 10, height: 10 },
      { id: 'n-b', type: 'text', text: 'n-b', x: 0, y: 0, width: 10, height: 10 },
    ],
    edges: [],
  })
  perDocReplica.commit()
  const rawFrame = new Uint8Array(perDocReplica.export({ mode: 'update', from }))

  const wsScopeBaseline = wsScope.binaryFrames().length
  const plainBaseline = plainReceiver.binaryFrames().length
  await plainSender.emitMessage(Buffer.from(rawFrame), true)

  // The plain peer got the raw frame; the workspace-scope socket did not.
  const plainReceived = plainReceiver.binaryFrames().slice(plainBaseline)
  expect(plainReceived.map((f) => Buffer.from(f).toString('base64'))).toContain(
    Buffer.from(rawFrame).toString('base64'),
  )
  const wsScopeReceived = wsScope.binaryFrames().slice(wsScopeBaseline)
  expect(wsScopeReceived.map((f) => Buffer.from(f).toString('base64'))).not.toContain(
    Buffer.from(rawFrame).toString('base64'),
  )

  // And still converges: the workspace-document fan-out carried the edit.
  expect(wsScopeReceived.length).toBeGreaterThan(0)
  const replica = new LoroDoc()
  replica.import(wsScope.binaryFrames()[0] as Uint8Array)
  for (const frame of wsScopeReceived) replica.import(frame)
  const entry = resolveWorkspaceDocument(replica, 'c')
  expect(entry).not.toBeNull()
  if (entry === null) return
  expect(
    readSpatialCanvas(documentContainers(replica, entry.documentId)).nodes.map((n) => n.id),
  ).toEqual(['n-a', 'n-b'])
})

it('a per-document save reaches an SSE stream subscribed at workspace granularity', async () => {
  // End-to-end through the funnel: saveDocument -> saveWorkspaceDoc ->
  // onWorkspaceDocUpdated (ws.ts's module listener) -> SSE fan-out.
  const { createSyncSseRouter, resetSyncStreamsForTests } = await import('./sync-sse.js')
  const app = createSyncSseRouter()
  const res = await app.request('/api/sync/stream')
  const reader = res.body?.getReader()
  if (!reader) throw new Error('no stream body')
  const decoder = new TextDecoder()
  const first = await reader.read()
  const streamId = JSON.parse(
    decoder
      .decode(first.value)
      .split('\n')
      .find((l) => l.startsWith('data:'))
      ?.slice(5) ?? '{}',
  ).streamId as string
  try {
    await app.request('/api/sync/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ streamId, subscribe: ['workspace:session1'] }),
    })

    const edited = canvasDoc(['n-a', 'n-sse'])
    await saveDocument('session1', 'c', edited, { kind: 'spatial', overwrite: true })

    const chunk = await Promise.race([
      reader.read(),
      new Promise<null>((r) => setTimeout(() => r(null), 2000)),
    ])
    expect(chunk).not.toBeNull()
    const frame = decoder.decode(chunk?.value)
    expect(frame).toContain('event: update')
    expect(frame).toContain('"doc":"workspace:session1"')
  } finally {
    await reader.cancel().catch(() => {})
    resetSyncStreamsForTests()
  }
})
