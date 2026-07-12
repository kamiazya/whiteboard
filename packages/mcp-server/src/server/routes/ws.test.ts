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
}))

const { clearCache } = await import('../store/doc-cache.js')
const { loadCanvas } = await import('../store/canvas-store.js')
const { corruptStoredData } = await import('../store/corrupt-stored-data.js')
const { createAutoVersionTrigger } = await import('./canvas.js')
const { handleWsUpgrade, setAutoVersionTrigger, sendViewportRequest } = await import('./ws.js')

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

// `viewport_request` is broadcast to currently-connected clients, but it also
// represents the latest "where the viewport should be" intent for this canvas.
// A client that connects AFTER the broadcast (e.g. Playwright opening the same
// canvas while a daemon-Chromium tab already received the fit) used to land
// with default zoom/scroll, masking that the MCP viewport_set worked at all.
// The expected behaviour: the daemon caches the latest viewport_request and
// replays it to each new client when it sends `client_ready`.
describe('handleWsUpgrade viewport replay', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'whiteboard-ws-viewport-replay-'))
    await mkdir(join(tempDir, 'session1'), { recursive: true })
    clearCache()
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
    clearCache()
  })

  function textFrames(ws: FakeWebSocket): unknown[] {
    return ws.sent.filter((m): m is string => typeof m === 'string').map((m) => JSON.parse(m))
  }

  it('replays the most recent viewport_request to a client that connects after the broadcast', async () => {
    // Client A connects first, becomes ready.
    const a = new FakeWebSocket()
    await handleWsUpgrade(
      { url: '/ws/session1/canvas-a', headers: { host: 'localhost:3099' } } as never,
      a as never,
    )
    await a.emitMessage(Buffer.from(JSON.stringify({ type: 'client_ready' })), false)

    // viewport_set fires while only A is connected.
    sendViewportRequest('session1', 'canvas-a', 'req-1', { mode: 'fit', padding: 24 })

    expect(
      textFrames(a).filter((m) => (m as { type?: string }).type === 'viewport_request'),
    ).toEqual([
      expect.objectContaining({
        type: 'viewport_request',
        requestId: 'req-1',
        mode: 'fit',
        padding: 24,
      }),
    ])

    // Client B connects later, has not yet emitted client_ready. Until ready,
    // it should NOT have received the cached viewport_request — that would
    // race with Excalidraw's mount and the client-side init flow.
    const b = new FakeWebSocket()
    await handleWsUpgrade(
      { url: '/ws/session1/canvas-a', headers: { host: 'localhost:3099' } } as never,
      b as never,
    )
    expect(
      textFrames(b).filter((m) => (m as { type?: string }).type === 'viewport_request'),
    ).toEqual([])

    // client_ready triggers the replay, addressed only to B.
    await b.emitMessage(Buffer.from(JSON.stringify({ type: 'client_ready' })), false)
    expect(
      textFrames(b).filter((m) => (m as { type?: string }).type === 'viewport_request'),
    ).toEqual([
      expect.objectContaining({
        type: 'viewport_request',
        requestId: 'req-1',
        mode: 'fit',
        padding: 24,
      }),
    ])
    // A is not re-spammed by B's connect.
    expect(
      textFrames(a).filter((m) => (m as { type?: string }).type === 'viewport_request'),
    ).toHaveLength(1)

    a.emitClose()
    b.emitClose()
  })

  it('caches only the latest viewport_request per canvas', async () => {
    const a = new FakeWebSocket()
    await handleWsUpgrade(
      { url: '/ws/session1/canvas-b', headers: { host: 'localhost:3099' } } as never,
      a as never,
    )
    await a.emitMessage(Buffer.from(JSON.stringify({ type: 'client_ready' })), false)

    sendViewportRequest('session1', 'canvas-b', 'req-1', { mode: 'fit' })
    sendViewportRequest('session1', 'canvas-b', 'req-2', {
      mode: 'move',
      scrollX: 100,
      scrollY: 200,
      zoom: 1.5,
    })

    const b = new FakeWebSocket()
    await handleWsUpgrade(
      { url: '/ws/session1/canvas-b', headers: { host: 'localhost:3099' } } as never,
      b as never,
    )
    await b.emitMessage(Buffer.from(JSON.stringify({ type: 'client_ready' })), false)

    const replays = textFrames(b).filter(
      (m) => (m as { type?: string }).type === 'viewport_request',
    )
    expect(replays).toEqual([
      expect.objectContaining({
        requestId: 'req-2',
        mode: 'move',
        scrollX: 100,
        scrollY: 200,
        zoom: 1.5,
      }),
    ])

    a.emitClose()
    b.emitClose()
  })
})

describe('handleWsUpgrade ws_trace propagation', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'whiteboard-ws-trace-'))
    await mkdir(join(tempDir, 'session1'), { recursive: true })
    clearCache()
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
    clearCache()
    setAutoVersionTrigger(() => Promise.resolve(null))
  })

  it('parents ws.message.binary on the traceparent the client sent ahead of the binary frame', async () => {
    const { trace } = await import('@opentelemetry/api')
    const { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } = await import(
      '@opentelemetry/sdk-trace-base'
    )
    const exporter = new InMemorySpanExporter()
    const provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    })
    trace.setGlobalTracerProvider(provider)
    try {
      setAutoVersionTrigger(() => Promise.resolve(null))
      const ws = new FakeWebSocket()
      await handleWsUpgrade(
        { url: '/ws/session1/canvas-a', headers: { host: 'localhost:3099' } } as never,
        ws as never,
      )

      // Client announces a traceparent (e.g. an apiFetch client span the
      // browser already opened). Span-id "deadbeefdeadbeef" is the
      // parent we expect on the server side.
      const tp = '00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-deadbeefdeadbeef-01'
      await ws.emitMessage(
        Buffer.from(JSON.stringify({ type: 'ws_trace', traceparent: tp })),
        false,
      )

      const clientDoc = new LoroDoc()
      const prevVV = clientDoc.version()
      const list = clientDoc.getMovableList('elements')
      const map = list.insertContainer(0, new LoroMap())
      map.set('id', 'el')
      map.set('type', 'rectangle')
      clientDoc.commit()
      await ws.emitMessage(
        Buffer.from(clientDoc.export({ mode: 'update', from: prevVV }) as Uint8Array),
        true,
      )
      await new Promise((r) => setTimeout(r, 30))

      const wsSpan = exporter.getFinishedSpans().find((s) => s.name === 'ws.message.binary')
      expect(wsSpan).toBeDefined()
      // Locked: ws.message.binary must inherit the W3C trace_id and
      // adopt the client span as its parent.
      expect(wsSpan!.spanContext().traceId).toBe('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
      expect(wsSpan!.parentSpanContext?.spanId).toBe('deadbeefdeadbeef')
      ws.emitClose()
    } finally {
      await provider.shutdown()
      trace.disable()
    }
  })

  it('falls back to a parentless span when no ws_trace was sent', async () => {
    const { trace } = await import('@opentelemetry/api')
    const { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } = await import(
      '@opentelemetry/sdk-trace-base'
    )
    const exporter = new InMemorySpanExporter()
    const provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    })
    trace.setGlobalTracerProvider(provider)
    try {
      setAutoVersionTrigger(() => Promise.resolve(null))
      const ws = new FakeWebSocket()
      await handleWsUpgrade(
        { url: '/ws/session1/canvas-c', headers: { host: 'localhost:3099' } } as never,
        ws as never,
      )

      const clientDoc = new LoroDoc()
      const prevVV = clientDoc.version()
      const list = clientDoc.getMovableList('elements')
      const map = list.insertContainer(0, new LoroMap())
      map.set('id', 'el')
      map.set('type', 'rectangle')
      clientDoc.commit()
      await ws.emitMessage(
        Buffer.from(clientDoc.export({ mode: 'update', from: prevVV }) as Uint8Array),
        true,
      )
      await new Promise((r) => setTimeout(r, 30))

      const wsSpan = exporter.getFinishedSpans().find((s) => s.name === 'ws.message.binary')
      expect(wsSpan).toBeDefined()
      expect(wsSpan!.parentSpanContext?.spanId).toBeUndefined()
      ws.emitClose()
    } finally {
      await provider.shutdown()
      trace.disable()
    }
  })
})
