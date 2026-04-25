import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LoroDoc, LoroMap } from 'loro-crdt'

let tempDir: string

vi.mock('../config.js', () => ({
  get DATA_DIR() {
    return tempDir
  },
  WHITEBOARD_ROOT: '/tmp/whiteboard',
  REPO_ROOT: '/tmp',
  DIST_APP_DIR: '/tmp/whiteboard/dist/app',
}))

const { clearCache } = await import('../store/doc-cache.js')
const { loadCanvas } = await import('../store/canvas-store.js')
const { corruptStoredData } = await import('../store/corrupt-stored-data.js')
const { createAutoVersionTrigger } = await import('./canvas.js')
const { handleWsUpgrade, setAutoVersionTrigger } = await import('./ws.js')

class FakeWebSocket {
  sent: Array<string | Uint8Array> = []
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

  close(): void {}

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
}

describe('handleWsUpgrade auto-version corruption', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'whiteboard-ws-test-'))
    await mkdir(join(tempDir, 'session1'), { recursive: true })
    clearCache()
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
    clearCache()
    setAutoVersionTrigger(() => Promise.resolve(null))
  })

  it('keeps WS binary updates successful and omits version_created when auto-version save is corrupt', async () => {
    const versionStore = {
      save: vi
        .fn()
        .mockRejectedValue(corruptStoredData('/tmp/versions/v1.json', 'broken metadata')),
      load: vi.fn(),
      list: vi.fn(),
      saveThumbnail: vi.fn(),
      loadThumbnail: vi.fn(),
      earliestFrontiers: vi.fn(),
      getFrontiersBase64: vi.fn(),
      renameBranchInVersions: vi.fn(),
    }
    setAutoVersionTrigger(createAutoVersionTrigger(versionStore, 0))

    const ws = new FakeWebSocket()
    await handleWsUpgrade(
      {
        url: '/ws/session1/canvas-a',
        headers: { host: 'localhost:3099' },
      } as never,
      ws as never,
    )

    const clientDoc = new LoroDoc()
    const prevVV = clientDoc.version()
    const list = clientDoc.getMovableList('elements')
    const map = list.insertContainer(0, new LoroMap())
    map.set('id', 'ws-elem')
    map.set('type', 'rectangle')
    clientDoc.commit()

    await ws.emitMessage(
      Buffer.from(clientDoc.export({ mode: 'update', from: prevVV }) as Uint8Array),
      true,
    )
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(versionStore.save).toHaveBeenCalledTimes(1)
    expect(ws.sent.filter((message) => typeof message === 'string')).toHaveLength(0)

    clearCache()
    const saved = await loadCanvas('session1', 'canvas-a')
    const elements = saved.getMovableList('elements').toJSON() as Array<{ id: string }>
    expect(elements.map((entry) => entry.id)).toEqual(['ws-elem'])

    ws.emitClose()
  })

  it('WS version_created payload includes operator metadata', async () => {
    const doc = new LoroDoc()
    const entry = {
      id: 'v1',
      slug: 'canvas-a',
      createdAt: '2026-04-23T00:00:00.000Z',
      elementCount: 1,
      auto: true,
      hasThumbnail: false,
      operator: {
        kind: 'system' as const,
        peerId: doc.peerIdStr,
        displayName: 'auto-save',
      },
    }
    const versionStore = {
      save: vi.fn().mockResolvedValue(entry),
      load: vi.fn(),
      list: vi.fn(),
      saveThumbnail: vi.fn(),
      loadThumbnail: vi.fn(),
      earliestFrontiers: vi.fn(),
      getFrontiersBase64: vi.fn(),
      renameBranchInVersions: vi.fn(),
    }
    setAutoVersionTrigger(createAutoVersionTrigger(versionStore, 0))

    const ws = new FakeWebSocket()
    await handleWsUpgrade(
      {
        url: '/ws/session1/canvas-a',
        headers: { host: 'localhost:3099' },
      } as never,
      ws as never,
    )

    const clientDoc = new LoroDoc()
    const prevVV = clientDoc.version()
    const list = clientDoc.getMovableList('elements')
    const map = list.insertContainer(0, new LoroMap())
    map.set('id', 'ws-elem')
    map.set('type', 'rectangle')
    clientDoc.commit()

    await ws.emitMessage(
      Buffer.from(clientDoc.export({ mode: 'update', from: prevVV }) as Uint8Array),
      true,
    )
    await new Promise((resolve) => setTimeout(resolve, 50))

    const textMessages = ws.sent.filter((message): message is string => typeof message === 'string')
    expect(textMessages).toHaveLength(1)
    expect(JSON.parse(textMessages[0]!)).toMatchObject({
      type: 'version_created',
      version: {
        operator: {
          kind: 'system',
          displayName: 'auto-save',
        },
      },
    })

    ws.emitClose()
  })
})
