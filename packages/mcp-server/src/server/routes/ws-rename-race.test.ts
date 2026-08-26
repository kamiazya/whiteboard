import {
  documentContainers,
  readMarkdownBody,
  resolveWorkspaceDocument,
  writeMarkdownBody,
} from '@kamiazya/whiteboard-loro-adapter'
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

// Mock the store so `getWorkspaceDoc` can be gated to control interleaving
// against a concurrent rename. It must be THIS module: mocking the wrong one
// is silent — a factory spreading `...actual` just adds a property nobody
// imports, and the race never stages.
vi.mock('../store/document-store.js', async () => {
  const actual = await vi.importActual<typeof import('../store/document-store.js')>(
    '../store/document-store.js',
  )
  return { ...actual, getWorkspaceDoc: vi.fn(actual.getWorkspaceDoc) }
})

const { clearCache } = await import('../store/doc-cache.js')

const { getWorkspaceDoc, saveDocument, renameDocumentPath, listDocuments, loadDocument } =
  await import('../store/document-store.js')
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

  // The old per-document contract could FORK here: the write path resolved a
  // doc reference through the old path, so a rename landing mid-flight left
  // the update to insert a phantom duplicate row back at it. The workspace
  // contract has no path-addressed write to fork — the frame imports into
  // the workspace record under the same lock the rename takes — so this pins
  // the converged outcome: one document, at the new path, with the edit.
  it('does not fork a phantom duplicate canvas when a rename races an in-flight binary update', async () => {
    const baseDoc = new LoroDoc()
    writeMarkdownBody(baseDoc, 'original')
    await saveDocument('session1', 'a', baseDoc, { kind: 'markdown' })

    const ws = new FakeWebSocket()
    await handleWsUpgrade(
      { url: '/ws/session1/a', headers: { host: 'localhost:3099' } } as never,
      ws as never,
    )

    // A client update built against the pre-rename workspace snapshot,
    // editing the document's containers inside the workspace lineage.
    const clientDoc = new LoroDoc()
    clientDoc.import(ws.sent[0] as Uint8Array)
    const fromVV = clientDoc.version()
    const entry = resolveWorkspaceDocument(clientDoc, 'a')
    expect(entry).not.toBeNull()
    if (entry === null) return
    writeMarkdownBody(documentContainers(clientDoc, entry.documentId), 'original + edit')
    clientDoc.commit()
    const update = clientDoc.export({ mode: 'update', from: fromVV }) as Uint8Array

    // Stall the WS handler's getWorkspaceDoc() call so the rename can be
    // fired while the frame is paused mid-flight: the frame's lock hold has
    // begun, the rename queues on the same workspace lock behind it.
    const { promise: gate, resolve: releaseGate } = Promise.withResolvers<void>()
    const { promise: called, resolve: signalCalled } = Promise.withResolvers<void>()
    const actual = await vi.importActual<typeof import('../store/document-store.js')>(
      '../store/document-store.js',
    )
    vi.mocked(getWorkspaceDoc).mockImplementationOnce(async (workspaceId) => {
      signalCalled()
      await gate
      return actual.getWorkspaceDoc(workspaceId)
    })

    const updatePromise = ws.emitMessage(Buffer.from(update), true)

    await called

    // Fire the rename while the binary frame is stalled mid-flight.
    const renamePromise = renameDocumentPath('session1', 'a', 'b')
    // Give the rename a chance to run before letting the stalled read continue.
    await new Promise((r) => setTimeout(r, 20))
    releaseGate()

    await Promise.all([updatePromise, renamePromise])

    // Exactly one canvas survives — no phantom duplicate at the old path —
    // and the in-flight edit landed on the renamed document.
    expect(ws.closes).toEqual([])
    const documents = await listDocuments('session1')
    expect(documents.map((c) => c.path)).toEqual(['b'])
    const saved = await loadDocument('session1', 'b')
    expect(readMarkdownBody(saved)).toBe('original + edit')
  })
})
