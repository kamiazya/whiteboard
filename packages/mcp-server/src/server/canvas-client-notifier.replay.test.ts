/**
 * A viewport request an agent issues before any page has signalled
 * `client_ready` is held and replayed to the first page that does, against the
 * real stream registry and the real `client_ready` route. The sibling
 * `canvas-client-notifier.test.ts` replaces the audience module, so it cannot
 * see the cache the notifier has to feed.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { InMemoryDocumentIndex } from '@kamiazya/whiteboard-ports/test-utils'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { createContainer, resolveServerDeps } from '../di/container.js'
import { resetDataDirForTests, setDataDirForTests } from '../shared/data-dir-secure.js'
import { storeMemoryModule } from '../shared/test-utils/store-memory.module.js'
import { createApp } from './app.js'
import { createCanvasClientNotifier } from './canvas-client-notifier.js'
import { testDataLayout } from './routes/_test-helpers.js'
import { resetSyncStreamsForTests } from './sync-streams.js'
import { VIEWPORT_REPLAY_TTL_MS } from './viewport-requests.js'

setDataDirForTests(mkdtempSync(join(tmpdir(), 'wb-notifier-replay-')))
afterAll(() => resetDataDirForTests())
afterEach(() => {
  vi.useRealTimers()
  resetSyncStreamsForTests()
})

const TOKEN = 'notifier-replay-test-token'
const auth = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }
const WORKSPACE_ID = 'ws-replay'
const DOCUMENT_ID = '01H8XJZ9K5N4M3P2Q1R0S9T8V7'

function app() {
  return createApp({
    authMode: 'local-daemon' as const,
    token: TOKEN,
    touch: () => {},
    getStatus: () => ({ port: 3099 }) as never,
    serverDeps: resolveServerDeps(createContainer(storeMemoryModule)),
    dataLayout: testDataLayout(),
  })
}

/** A notifier over an index that knows `path`; each case has its own path, since the cache is process-wide. */
function notifierFor(path: string) {
  const index = new InMemoryDocumentIndex()
  index.seed({ workspaceId: WORKSPACE_ID, documentId: DOCUMENT_ID, path, kind: 'spatial' })
  return createCanvasClientNotifier(index)
}

async function openStream(a: ReturnType<typeof app>) {
  const res = await a.request('/api/sync/stream', { headers: auth })
  const reader = res.body?.getReader()
  if (!reader) throw new Error('no stream body')
  const decoder = new TextDecoder()
  const first = decoder.decode((await reader.read()).value)
  const data = first
    .split('\n')
    .find((l) => l.startsWith('data:'))
    ?.slice(5)
  const streamId = JSON.parse(data ?? '{}').streamId as string
  return { reader, decoder, streamId }
}

async function post(a: ReturnType<typeof app>, route: string, body: unknown) {
  return a.request(`/api/sync/${route}`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify(body),
  })
}

/** Whatever frames arrive within `ms`; read() never settles on an idle stream, so the wait is raced. */
async function framesWithin(
  { reader, decoder }: Awaited<ReturnType<typeof openStream>>,
  ms: number,
): Promise<string> {
  let text = ''
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const chunk = await Promise.race([
      reader.read(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), deadline - Date.now())),
    ])
    if (chunk === null || chunk.done) break
    text += decoder.decode(chunk.value, { stream: true })
  }
  await reader.cancel().catch(() => {})
  return text
}

const viewportFrames = (text: string) => text.split('viewport_request').length - 1

describe('a viewport request issued before any page is ready', () => {
  it('is answered delivered:false, then reaches the first page that signals client_ready exactly once', async () => {
    const a = app()
    const stream = await openStream(a)
    const doc = `${WORKSPACE_ID}/replay-fresh`
    await post(a, 'subscribe', { streamId: stream.streamId, subscribe: [doc] })

    const delivered = await notifierFor('replay-fresh').requestViewport({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      mode: 'fit',
    })
    expect(delivered).toBe(false)

    await post(a, 'message', { streamId: stream.streamId, doc, message: { type: 'client_ready' } })
    expect(viewportFrames(await framesWithin(stream, 300))).toBe(1)
  })

  it('is not replayed once it is older than the replay window', async () => {
    const a = app()
    const stream = await openStream(a)
    const doc = `${WORKSPACE_ID}/replay-stale`
    await post(a, 'subscribe', { streamId: stream.streamId, subscribe: [doc] })

    // Only the clock is faked: the SSE plumbing needs real timers.
    vi.useFakeTimers({ toFake: ['Date'] })
    await notifierFor('replay-stale').requestViewport({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      mode: 'fit',
    })
    vi.setSystemTime(Date.now() + VIEWPORT_REPLAY_TTL_MS + 1)
    await post(a, 'message', { streamId: stream.streamId, doc, message: { type: 'client_ready' } })
    vi.useRealTimers()

    expect(viewportFrames(await framesWithin(stream, 300))).toBe(0)
  })
})
