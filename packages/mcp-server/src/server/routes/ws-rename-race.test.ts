import { LoroDoc } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { withTempDataDir } from './_test-helpers.js'

const tmp = withTempDataDir('whiteboard-ws-rename-race-')

vi.mock('../config.js', () => ({
  get DATA_DIR() {
    return tmp.dir
  },
  getDataDir: () => tmp.dir,
  WHITEBOARD_ROOT: '/tmp/whiteboard',
  REPO_ROOT: '/tmp',
}))

// Mock doc-cache so getDoc can be gated to control interleaving against a
// concurrent rename, mirroring canvas.test.ts's phantom-duplicate pin.
vi.mock('../store/doc-cache.js', async () => {
  const actual =
    await vi.importActual<typeof import('../store/doc-cache.js')>('../store/doc-cache.js')
  return { ...actual, getDoc: vi.fn(actual.getDoc) }
})

const { clearCache, getDoc } = await import('../store/doc-cache.js')
const { saveDocument, renameDocumentPath, listDocuments } = await import(
  '../store/document-store.js'
)
const { handleWsUpgrade } = await import('./ws.js')

class FakeWebSocket {
  sent: Array<string | Uint8Array> = []
  closes: Array<{ code?: number; reason?: string }> = []
  private listeners = new Map<string, Array<(...args: unknown[]) => void>>()

  send(data: string | Uint8Array | ArrayBuffer): void {
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
}

describe('handleWsUpgrade binary update vs rename race', () => {
  beforeEach(() => {
    clearCache()
  })

  afterEach(() => {
    clearCache()
  })

  it('does not fork a phantom duplicate canvas when a rename races an in-flight binary update that already resolved a doc reference through the old path', async () => {
    const baseDoc = new LoroDoc()
    baseDoc.getText('content').insert(0, 'original')
    baseDoc.commit()
    await saveDocument('session1', 'a', baseDoc)

    // A client update built against the pre-rename base.
    const clientDoc = LoroDoc.fromSnapshot(baseDoc.export({ mode: 'snapshot' }))
    const fromVV = clientDoc.version()
    clientDoc.getText('content').insert('original'.length, ' + edit')
    clientDoc.commit()
    const update = clientDoc.export({ mode: 'update', from: fromVV }) as Uint8Array

    // Stall the WS handler's getDoc() call so a rename can be fired while
    // the frame is paused mid-flight, matching the real race: the read
    // resolves before the rename runs, the write happens after.
    const { promise: getDocGate, resolve: releaseGetDoc } = Promise.withResolvers<void>()
    const { promise: getDocCalled, resolve: signalGetDocCalled } = Promise.withResolvers<void>()
    const actual =
      await vi.importActual<typeof import('../store/doc-cache.js')>('../store/doc-cache.js')
    vi.mocked(getDoc)
      .mockImplementationOnce(async (workspaceId, path) => {
        // First call: the WS upgrade's initial snapshot send. Resolve normally.
        return actual.getDoc(workspaceId, path)
      })
      .mockImplementationOnce(async (workspaceId, path) => {
        signalGetDocCalled()
        await getDocGate
        return actual.getDoc(workspaceId, path)
      })

    const ws = new FakeWebSocket()
    await handleWsUpgrade(
      { url: '/ws/session1/a', headers: { host: 'localhost:3099' } } as never,
      ws as never,
    )

    const updatePromise = ws.emitMessage(Buffer.from(update), true)

    await getDocCalled

    // Fire the rename while the binary frame is stalled mid-flight.
    const renamePromise = renameDocumentPath('session1', 'a', 'b')
    // Give the rename a chance to run before letting the stalled read continue.
    await new Promise((r) => setTimeout(r, 20))
    releaseGetDoc()

    await Promise.all([updatePromise, renamePromise])

    // Exactly one canvas must survive -- the update must not have silently
    // inserted a phantom duplicate back at the old path.
    const documents = await listDocuments('session1')
    expect(documents.map((c) => c.path)).toEqual(['b'])
  })
})
