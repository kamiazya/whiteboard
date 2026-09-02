/**
 * The ws routes operate through the ServerDeps they were given — the fourth
 * instance of the optional-deps-going-unread bug class (data-dir-seam,
 * handle-resolution-seam, live-doc-seam, workspace-document-seam precede
 * it): an optional `deps` parameter that nothing reads compiles clean and
 * passes every fallback-path test. The recorder on the INJECTED deps is the
 * discriminator, because going around the seam persists the same bytes.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeSpatialCanvas } from '@kamiazya/whiteboard-loro-adapter'
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
const { saveDocument, _clearWorkspaceDocCacheForTests } = await import('../store/document-store.js')
const { getDefaultServerDeps } = await import('../../di/default-server-deps.js')
const { handleWsUpgrade } = await import('./ws.js')
const { createIsolatedDb } = await import('../store/db/test-helpers.js')

let handle: Awaited<ReturnType<typeof createIsolatedDb>>

class FakeWebSocket {
  sent: Array<string | Uint8Array> = []
  closes: Array<{ code?: number; reason?: string }> = []
  private listeners = new Map<string, Array<(...args: unknown[]) => void>>()

  send(data: string | Uint8Array | ArrayBuffer): void {
    this.sent.push(typeof data === 'string' ? data : new Uint8Array(data as ArrayBuffer))
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
}

function canvasDoc(ids: string[]): LoroDoc {
  const doc = new LoroDoc()
  writeSpatialCanvas(doc, {
    nodes: ids.map((id) => ({ id, type: 'text', text: id, x: 0, y: 0, width: 10, height: 10 })),
    edges: [],
  })
  return doc
}

function updateFrame(): Buffer {
  const doc = new LoroDoc()
  const vv0 = doc.version()
  writeSpatialCanvas(doc, {
    nodes: [{ id: 'n-seam', type: 'text', text: 'seam', x: 0, y: 0, width: 10, height: 10 }],
    edges: [],
  })
  return Buffer.from(doc.export({ mode: 'update', from: vv0 }))
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'ws-seam-test-'))
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

it('a binary frame reads and writes through the INJECTED workspaceDocuments', async () => {
  const deps = await getDefaultServerDeps()
  const recorded: string[] = []
  const real = deps.workspaceDocuments
  deps.workspaceDocuments = {
    ...real,
    get: async (workspaceId) => {
      recorded.push(`get ${workspaceId}`)
      return real.get(workspaceId)
    },
    save: async (workspaceId, doc) => {
      recorded.push(`save ${workspaceId}`)
      return real.save(workspaceId, doc)
    },
  }

  const ws = new FakeWebSocket()
  await handleWsUpgrade(
    { url: '/ws/session1/c', headers: { host: 'localhost:3099' } } as never,
    ws as never,
    undefined,
    deps,
  )
  const baseline = recorded.length
  await ws.emitMessage(updateFrame(), true)

  expect(ws.closes).toEqual([])
  expect(recorded.slice(baseline)).toEqual(['get session1', 'save session1'])
})

it('a persist failure lands its 1011 recovery on the INJECTED evictions', async () => {
  const deps = await getDefaultServerDeps()
  const recorded: string[] = []
  const real = deps.workspaceDocuments
  deps.workspaceDocuments = {
    ...real,
    save: async () => {
      throw new Error('injected persist failure')
    },
    evictProjections: (workspaceId) => {
      recorded.push(`evictProjections ${workspaceId}`)
      real.evictProjections(workspaceId)
    },
    evict: (workspaceId) => {
      recorded.push(`evict ${workspaceId}`)
      real.evict(workspaceId)
    },
  }

  const ws = new FakeWebSocket()
  await handleWsUpgrade(
    { url: '/ws/session1/c', headers: { host: 'localhost:3099' } } as never,
    ws as never,
    undefined,
    deps,
  )
  await ws.emitMessage(updateFrame(), true)

  expect(recorded).toEqual(['evictProjections session1', 'evict session1'])
  expect(ws.closes).toEqual([{ code: 1011, reason: 'Failed to persist canvas update' }])
})
