import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LoroDoc, LoroMap } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
const { captureLogsForTests } = await import('../log.js')

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

  // Real `ws` sockets are EventEmitters: `emit('message', ...)` invokes the
  // listener without awaiting whatever promise it returns. `emitMessage`
  // above awaits the handler, which would hide a handler that lets its
  // returned promise reject unhandled. This mirrors the real dispatch
  // semantics so tests can prove the handler never produces an unhandled
  // rejection even when nothing awaits it.
  dispatchMessage(data: Buffer, isBinary: boolean): void {
    for (const handler of this.listeners.get('message') ?? []) {
      handler(data, isBinary)
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

describe('handleWsUpgrade per-message scope enforcement (ADR-0005)', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'whiteboard-ws-scope-test-'))
    await mkdir(join(tempDir, 'session1'), { recursive: true })
    clearCache()
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
    clearCache()
    setAutoVersionTrigger(() => Promise.resolve(null))
  })

  it('a canvas:read-only connection cannot emit a CRDT mutation over the socket', async () => {
    const { peekDoc } = await import('../store/doc-cache.js')
    setAutoVersionTrigger(() => Promise.resolve(null))
    const ws = new FakeWebSocket()
    // Grant only canvas:read — the shape a workspace:read-scoped credential
    // would hold once scoped WS credentials exist (ADR-0005).
    await handleWsUpgrade(
      { url: '/ws/session1/canvas-readonly', headers: { host: 'localhost:3099' } } as never,
      ws as never,
      ['canvas:read'],
    )

    const clientDoc = new LoroDoc()
    const prevVV = clientDoc.version()
    const list = clientDoc.getMovableList('elements')
    const map = list.insertContainer(0, new LoroMap())
    map.set('id', 'should-never-persist')
    map.set('type', 'rectangle')
    clientDoc.commit()

    await ws.emitMessage(
      Buffer.from(clientDoc.export({ mode: 'update', from: prevVV }) as Uint8Array),
      true,
    )
    await new Promise((resolve) => setTimeout(resolve, 30))

    // The update was never imported into the server's live doc.
    const liveDoc = peekDoc('session1', 'canvas-readonly')
    const elements = liveDoc?.getMovableList('elements').toJSON() as
      | Array<{ id: string }>
      | undefined
    expect(elements ?? []).toEqual([])

    // Nor was it persisted to disk: reading it back yields an empty canvas,
    // not one containing the rejected element.
    clearCache()
    const saved = await loadCanvas('session1', 'canvas-readonly')
    const savedElements = saved.getMovableList('elements').toJSON() as Array<{ id: string }>
    expect(savedElements).toEqual([])

    // And the socket is closed rather than silently swallowing further frames.
    expect(ws.closes).toEqual([{ code: 1008, reason: 'Insufficient scope' }])

    ws.emitClose()
  })

  it('a canvas:write-granted connection can still emit a CRDT mutation (no regression)', async () => {
    setAutoVersionTrigger(() => Promise.resolve(null))
    const ws = new FakeWebSocket()
    await handleWsUpgrade(
      { url: '/ws/session1/canvas-writable', headers: { host: 'localhost:3099' } } as never,
      ws as never,
      ['canvas:read', 'canvas:write'],
    )

    const clientDoc = new LoroDoc()
    const prevVV = clientDoc.version()
    const list = clientDoc.getMovableList('elements')
    const map = list.insertContainer(0, new LoroMap())
    map.set('id', 'persists-fine')
    map.set('type', 'rectangle')
    clientDoc.commit()

    await ws.emitMessage(
      Buffer.from(clientDoc.export({ mode: 'update', from: prevVV }) as Uint8Array),
      true,
    )
    await new Promise((resolve) => setTimeout(resolve, 30))

    clearCache()
    const saved = await loadCanvas('session1', 'canvas-writable')
    const elements = saved.getMovableList('elements').toJSON() as Array<{ id: string }>
    expect(elements.map((entry) => entry.id)).toEqual(['persists-fine'])

    ws.emitClose()
  })

  it('a connection with no canvas:read cannot even signal client_ready (control messages gated too)', async () => {
    const ws = new FakeWebSocket()
    await handleWsUpgrade(
      { url: '/ws/session1/canvas-noscope', headers: { host: 'localhost:3099' } } as never,
      ws as never,
      [],
    )

    const { getReadyClientCount } = await import('./ws.js')
    await ws.emitMessage(Buffer.from(JSON.stringify({ type: 'client_ready' })), false)
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(getReadyClientCount('session1', 'canvas-noscope')).toBe(0)

    // Scopes are fixed at upgrade, so a client that lacks the scope for a
    // message can never succeed by retrying. Leaving the socket open would
    // let it keep pushing rejected frames indefinitely; close it out.
    expect(ws.closes).toEqual([{ code: 1008, reason: 'Insufficient scope' }])
    ws.emitClose()
  })

  it('a frame already in flight when the socket was closed for scope takes no effect', async () => {
    const ws = new FakeWebSocket()
    await handleWsUpgrade(
      { url: '/ws/session1/canvas-inflight', headers: { host: 'localhost:3099' } } as never,
      ws as never,
      ['canvas:read'],
    )

    const clientDoc = new LoroDoc()
    const prevVV = clientDoc.version()
    clientDoc.getMovableList('elements').insertContainer(0, new LoroMap())
    clientDoc.commit()

    // The mutation trips the scope gate and starts the closing handshake...
    await ws.emitMessage(
      Buffer.from(clientDoc.export({ mode: 'update', from: prevVV }) as Uint8Array),
      true,
    )
    // ...but `close()` only *starts* it, so a frame the client had already put
    // on the wire still arrives. Even though canvas:read alone would normally
    // authorize client_ready, it must not register a socket that is closing.
    const { getReadyClientCount } = await import('./ws.js')
    await ws.emitMessage(Buffer.from(JSON.stringify({ type: 'client_ready' })), false)
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(getReadyClientCount('session1', 'canvas-inflight')).toBe(0)
    ws.emitClose()
  })
})

describe('handleWsUpgrade malformed binary frame (DoS hardening)', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'whiteboard-ws-malformed-'))
    await mkdir(join(tempDir, 'session1'), { recursive: true })
    clearCache()
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
    clearCache()
    setAutoVersionTrigger(() => Promise.resolve(null))
  })

  it('never lets an undecodable binary frame become an unhandled promise rejection', async () => {
    setAutoVersionTrigger(() => Promise.resolve(null))
    let unhandled: unknown = null
    const onUnhandledRejection = (reason: unknown) => {
      unhandled = reason
    }
    process.on('unhandledRejection', onUnhandledRejection)

    try {
      const ws = new FakeWebSocket()
      await handleWsUpgrade(
        { url: '/ws/session1/canvas-malformed', headers: { host: 'localhost:3099' } } as never,
        ws as never,
        ['canvas:read', 'canvas:write'],
      )

      // Dispatch without awaiting, mirroring real `ws` EventEmitter
      // semantics: the 'message' listener's returned promise is never
      // awaited by the caller.
      ws.dispatchMessage(Buffer.from([1, 2, 3]), true)

      // Flush microtasks and the macrotask queue so any unhandled
      // rejection from the dispatched (but un-awaited) handler surfaces.
      await new Promise((resolve) => setImmediate(resolve))
      await new Promise((resolve) => setImmediate(resolve))

      expect(unhandled).toBeNull()
      expect(ws.closes).toEqual([{ code: 1003, reason: 'Malformed canvas update' }])

      ws.emitClose()
    } finally {
      process.off('unhandledRejection', onUnhandledRejection)
    }
  })

  it('discards the malformed frame, closes 1003, and logs a structured warning without frame bytes or tokens', async () => {
    setAutoVersionTrigger(() => Promise.resolve(null))
    const logs = captureLogsForTests()
    try {
      const ws = new FakeWebSocket()
      await handleWsUpgrade(
        { url: '/ws/session1/canvas-malformed-2', headers: { host: 'localhost:3099' } } as never,
        ws as never,
        ['canvas:read', 'canvas:write'],
      )

      // Embed a canary in the frame's raw bytes rather than asserting on the
      // literal `[1, 2, 3]` payload: this frame is still garbage from Loro's
      // perspective (fails to decode), so it still exercises the malformed-
      // import branch, but if a future change ever logged the raw frame
      // bytes (or a field literally named "token" that happened to hold
      // this payload), the canary would surface in the serialized log and
      // the assertions below would catch it. Asserting on `[1, 2, 3]` alone
      // could never fail this way since that payload contains no string a
      // token/secret redaction concern would ever match.
      const canary = 'token-canary-must-not-be-logged'
      await ws.emitMessage(Buffer.from(canary, 'utf8'), true)

      expect(ws.closes).toEqual([{ code: 1003, reason: 'Malformed canvas update' }])

      clearCache()
      const saved = await loadCanvas('session1', 'canvas-malformed-2')
      expect(saved.getMovableList('elements').toJSON()).toEqual([])

      const warnRecord = logs.records.find((r) => r.level === 'warning' && r.scope === 'ws')
      expect(warnRecord).toBeDefined()
      expect(warnRecord?.data?.workspaceId).toBe('session1')
      expect(warnRecord?.data?.slug).toBe('canvas-malformed-2')
      expect(typeof warnRecord?.data?.updateBytes).toBe('number')
      const serialized = JSON.stringify(warnRecord)
      expect(serialized).not.toContain(canary)
      expect(serialized.toLowerCase()).not.toContain('token')

      ws.emitClose()
    } finally {
      logs.restore()
    }
  })

  it('a read-only connection sending malformed bytes still closes 1008, never 1003 (scope precedes import)', async () => {
    const ws = new FakeWebSocket()
    await handleWsUpgrade(
      { url: '/ws/session1/canvas-malformed-ro', headers: { host: 'localhost:3099' } } as never,
      ws as never,
      ['canvas:read'],
    )

    await ws.emitMessage(Buffer.from([1, 2, 3]), true)

    expect(ws.closes).toEqual([{ code: 1008, reason: 'Insufficient scope' }])
    ws.emitClose()
  })

  it('two malformed frames back-to-back cause exactly one close and no crash', async () => {
    setAutoVersionTrigger(() => Promise.resolve(null))
    const ws = new FakeWebSocket()
    await handleWsUpgrade(
      { url: '/ws/session1/canvas-malformed-3', headers: { host: 'localhost:3099' } } as never,
      ws as never,
      ['canvas:read', 'canvas:write'],
    )

    await ws.emitMessage(Buffer.from([1, 2, 3]), true)
    await ws.emitMessage(Buffer.from([4, 5, 6]), true)

    expect(ws.closes).toEqual([{ code: 1003, reason: 'Malformed canvas update' }])
    ws.emitClose()
  })

  it('two malformed frames dispatched concurrently (neither awaited before the next starts) still cause exactly one close', async () => {
    setAutoVersionTrigger(() => Promise.resolve(null))
    const { getDoc } = await import('../store/doc-cache.js')
    // Prime the cache so both concurrent `getDoc` calls below resolve off the
    // cache-hit branch instead of racing two independent fs reads, whose
    // completion order the test cannot control.
    await getDoc('session1', 'canvas-malformed-race')

    const ws = new FakeWebSocket()
    await handleWsUpgrade(
      { url: '/ws/session1/canvas-malformed-race', headers: { host: 'localhost:3099' } } as never,
      ws as never,
      ['canvas:read', 'canvas:write'],
    )

    // Dispatch both frames without awaiting in between, mirroring real `ws`
    // EventEmitter semantics: both handler invocations pass the top-of-handler
    // `isClosing` check before either's `await getDoc(...)` resolves, so only
    // a recheck immediately after that await can stop the second one from
    // also treating its frame as fresh and closing again.
    ws.dispatchMessage(Buffer.from([1, 2, 3]), true)
    ws.dispatchMessage(Buffer.from([4, 5, 6]), true)

    await new Promise((resolve) => setImmediate(resolve))
    await new Promise((resolve) => setImmediate(resolve))

    expect(ws.closes).toEqual([{ code: 1003, reason: 'Malformed canvas update' }])
    ws.emitClose()
  })
})

describe('handleWsUpgrade binary update persistence failure', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'whiteboard-ws-persist-fail-'))
    await mkdir(join(tempDir, 'session1'), { recursive: true })
    clearCache()
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
    clearCache()
    setAutoVersionTrigger(() => Promise.resolve(null))
  })

  it('closes 1011 and evicts the cache when saveCanvas fails after a valid import, without crashing', async () => {
    setAutoVersionTrigger(() => Promise.resolve(null))
    const { peekDoc } = await import('../store/doc-cache.js')
    const logs = captureLogsForTests()
    try {
      const ws = new FakeWebSocket()
      await handleWsUpgrade(
        { url: '/ws/session1/canvas-persist-fail', headers: { host: 'localhost:3099' } } as never,
        ws as never,
        ['canvas:read', 'canvas:write'],
      )

      const clientDoc = new LoroDoc()
      const prevVV = clientDoc.version()
      const list = clientDoc.getMovableList('elements')
      const map = list.insertContainer(0, new LoroMap())
      map.set('id', 'ws-elem')
      clientDoc.commit()
      const update = clientDoc.export({ mode: 'update', from: prevVV }) as Uint8Array

      // `currentDoc.import(bytes)` must succeed so the cached in-memory doc
      // already absorbed the mutation; only the persistence step (which
      // calls `doc.export` internally) fails.
      const exportSpy = vi.spyOn(LoroDoc.prototype, 'export').mockImplementationOnce(() => {
        throw new Error('simulated snapshot failure')
      })

      await ws.emitMessage(Buffer.from(update), true)

      exportSpy.mockRestore()

      expect(ws.closes).toEqual([{ code: 1011, reason: 'Failed to persist canvas update' }])
      expect(peekDoc('session1', 'canvas-persist-fail')).toBeUndefined()

      const saved = await loadCanvas('session1', 'canvas-persist-fail')
      expect(saved.getMovableList('elements').toJSON()).toEqual([])

      const errorRecord = logs.records.find((r) => r.level === 'error' && r.scope === 'ws')
      expect(errorRecord).toBeDefined()
      expect(errorRecord?.data?.workspaceId).toBe('session1')
      expect(errorRecord?.data?.slug).toBe('canvas-persist-fail')
      const serialized = JSON.stringify(errorRecord)
      expect(serialized).not.toContain('ws-elem')
      expect(serialized.toLowerCase()).not.toContain('token')

      ws.emitClose()
    } finally {
      logs.restore()
    }
  })
})
