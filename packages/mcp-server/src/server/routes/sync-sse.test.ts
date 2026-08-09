// The SSE sync transport exists because a secure (https) page cannot open a
// ws:// socket to the loopback daemon — mixed content blocks it before any
// auth, so the hosted app has no WebSocket path to a local daemon at all.
// Plain http fetch to loopback IS allowed from a secure page, so the same
// sync protocol rides SSE downstream and POST upstream.
//
// The initial snapshot is NOT carried here: GET /api/canvas/:ws/:slug/snapshot
// already serves it as binary, and routing the largest payload through SSE
// would only add base64 inflation. This stream carries incremental updates.
import { describe, expect, it } from 'vitest'
import { createApp } from '../app.js'
import {
  broadcastLoroUpdate,
  sendHeadChanged,
  sendViewportRequest,
  setResolveViewportFn,
} from './ws.js'

const TOKEN = 'sse-sync-test-token'

function createRuntimeOptions() {
  return {
    authMode: 'local-daemon' as const,
    token: TOKEN,
    touch: () => {},
    getStatus: () => ({ port: 3099 }) as never,
  }
}

const auth = { Authorization: `Bearer ${TOKEN}` }

/** Read decoded SSE frames off the stream until `count` events arrive. */
async function readEvents(res: Response, count: number, timeoutMs = 2000): Promise<string[]> {
  const reader = res.body?.getReader()
  if (!reader) throw new Error('no stream body')
  const decoder = new TextDecoder()
  const frames: string[] = []
  let buffer = ''
  const deadline = Date.now() + timeoutMs
  while (frames.length < count && Date.now() < deadline) {
    // read() never resolves while the stream is open and idle, so the deadline
    // has to race it — otherwise asserting that NOTHING arrives hangs forever.
    const chunk = await Promise.race([
      reader.read(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), deadline - Date.now())),
    ])
    if (chunk === null) break
    const { value, done } = chunk
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const parts = buffer.split('\n\n')
    buffer = parts.pop() ?? ''
    for (const part of parts) {
      if (part.trim().length > 0) frames.push(part)
    }
  }
  await reader.cancel().catch(() => {})
  return frames
}

describe('SSE sync transport', () => {
  it('opens an event stream with the SSE content type', async () => {
    const app = createApp(createRuntimeOptions())

    const res = await app.request('/api/sync/stream?streamId=s1', { headers: auth })

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/)
    // A proxy or the browser buffering this stream would defeat its purpose.
    expect(res.headers.get('cache-control')).toMatch(/no-cache/)
    await res.body?.cancel().catch(() => {})
  })

  it('requires auth like every other /api route', async () => {
    const app = createApp(createRuntimeOptions())

    const res = await app.request('/api/sync/stream?streamId=s1')

    expect(res.status).toBe(401)
  })

  it('delivers a broadcast update to a stream subscribed to that doc', async () => {
    const app = createApp(createRuntimeOptions())
    const res = await app.request('/api/sync/stream?streamId=s2', { headers: auth })
    expect(res.status).toBe(200)

    const subscribed = await app.request('/api/sync/subscribe', {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ streamId: 's2', subscribe: ['ws-1/canvas-a'] }),
    })
    expect(subscribed.status).toBe(200)

    broadcastLoroUpdate('ws-1', 'canvas-a', new Uint8Array([1, 2, 3]))

    const frames = await readEvents(res, 1)
    const updateFrame = frames.find((f) => f.includes('event: update'))
    expect(updateFrame).toBeDefined()
    // SSE is a text protocol, so Loro update bytes travel base64-encoded.
    expect(updateFrame).toContain(`"doc":"ws-1/canvas-a"`)
    expect(updateFrame).toContain(`"update":"${btoa('\x01\x02\x03')}"`)
  })

  it('does not deliver a doc the stream never subscribed to', async () => {
    const app = createApp(createRuntimeOptions())
    const res = await app.request('/api/sync/stream?streamId=s3', { headers: auth })
    await app.request('/api/sync/subscribe', {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ streamId: 's3', subscribe: ['ws-1/subscribed'] }),
    })

    broadcastLoroUpdate('ws-1', 'not-subscribed', new Uint8Array([9]))

    const frames = await readEvents(res, 1, 300)
    expect(frames.filter((f) => f.includes('event: update'))).toEqual([])
  })

  // A viewport request goes only to clients that have signalled client_ready,
  // and is replayed from cache when a late client becomes ready. Mirroring
  // both halves is what keeps an SSE client from either missing the request
  // or receiving it twice.
  it('withholds a viewport request from a stream that has not signalled client_ready', async () => {
    const app = createApp(createRuntimeOptions())
    const res = await app.request('/api/sync/stream?streamId=vp1', { headers: auth })
    await app.request('/api/sync/subscribe', {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ streamId: 'vp1', subscribe: ['ws-1/vp-canvas'] }),
    })

    sendViewportRequest('ws-1', 'vp-canvas', 'req-1', { mode: 'fit' })

    const frames = await readEvents(res, 1, 300)
    expect(frames.filter((f) => f.includes('viewport_request'))).toEqual([])
  })

  it('replays the cached viewport request when the stream signals client_ready', async () => {
    const app = createApp(createRuntimeOptions())
    const res = await app.request('/api/sync/stream?streamId=vp2', { headers: auth })
    await app.request('/api/sync/subscribe', {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ streamId: 'vp2', subscribe: ['ws-1/vp-late'] }),
    })

    sendViewportRequest('ws-1', 'vp-late', 'req-2', { mode: 'fit' })

    const ready = await app.request('/api/sync/message', {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        streamId: 'vp2',
        doc: 'ws-1/vp-late',
        message: { type: 'client_ready' },
      }),
    })
    expect(ready.status).toBe(200)

    const frames = await readEvents(res, 1)
    expect(frames.some((f) => f.includes('viewport_request') && f.includes('req-2'))).toBe(true)
  })

  it('resolves a pending viewport request from a viewport_response', async () => {
    const app = createApp(createRuntimeOptions())
    await app.request('/api/sync/stream?streamId=vp3', { headers: auth })
    const resolved: string[] = []
    setResolveViewportFn((requestId) => resolved.push(requestId))

    const res = await app.request('/api/sync/message', {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        streamId: 'vp3',
        doc: 'ws-1/vp-canvas',
        message: { type: 'viewport_response', requestId: 'req-3' },
      }),
    })

    expect(res.status).toBe(200)
    expect(resolved).toContain('req-3')
  })

  // A WebSocket is per-canvas so its text frames need no addressing. One SSE
  // stream serves many canvases, so an unaddressed frame would be applied to
  // whichever canvas happened to be listening.
  it('addresses a text message to the document it belongs to', async () => {
    const app = createApp(createRuntimeOptions())
    const res = await app.request('/api/sync/stream?streamId=txt1', { headers: auth })
    await app.request('/api/sync/subscribe', {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ streamId: 'txt1', subscribe: ['ws-1/a', 'ws-1/b'] }),
    })

    sendHeadChanged('ws-1', 'b', 'head-xyz')

    const frames = await readEvents(res, 1)
    const frame = frames.find((f) => f.includes('head_changed'))
    expect(frame).toBeDefined()
    const data = JSON.parse(
      frame
        ?.split('\n')
        .find((l) => l.startsWith('data:'))
        ?.slice(5) ?? '{}',
    )
    expect(data.doc).toBe('ws-1/b')
    expect(JSON.parse(data.raw).head).toBe('head-xyz')
  })

  it('rejects a subscribe for an unknown stream instead of silently succeeding', async () => {
    const app = createApp(createRuntimeOptions())

    const res = await app.request('/api/sync/subscribe', {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ streamId: 'never-opened', subscribe: ['ws-1/a'] }),
    })

    expect(res.status).toBe(404)
  })
})
