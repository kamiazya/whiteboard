/**
 * A viewport request an agent issues before any page has signalled
 * `client_ready` is held and replayed to the first page that does, against the
 * real stream registry and the real `client_ready` route. The sibling
 * `canvas-client-notifier.test.ts` replaces the audience module, so it cannot
 * see the cache the notifier has to feed.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type SyncMessageEvent,
  syncMessageEventSchema,
} from '@kamiazya/whiteboard-daemon-client/sync-sse-contract'
import { InMemoryDocumentIndex } from '@kamiazya/whiteboard-ports/test-utils'
import type { ServerDeps } from '@kamiazya/whiteboard-server-core'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { resetDataDirForTests, setDataDirForTests } from '../shared/data-dir-secure.js'
import { createApp } from './app.js'
import { createCanvasClientNotifier } from './canvas-client-notifier.js'
import { resolveTestServerDeps, testDataLayout } from './routes/_test-helpers.js'
import { resetSyncStreamsForTests } from './sync-streams.js'
import { VIEWPORT_REPLAY_TTL_MS } from './viewport-requests.js'

const dataDir = mkdtempSync(join(tmpdir(), 'wb-notifier-replay-'))
setDataDirForTests(dataDir)
afterAll(() => {
  resetDataDirForTests()
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})
// The real wiring over this file's data dir: a segment the subscribe route
// resolves has to name a workspace in the registry it reads.
let serverDeps: ServerDeps
beforeAll(async () => {
  serverDeps = await resolveTestServerDeps(dataDir)
})
afterEach(() => {
  vi.useRealTimers()
  resetSyncStreamsForTests()
})

const TOKEN = 'notifier-replay-test-token'
const auth = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }
const DOCUMENT_ID = '01H8XJZ9K5N4M3P2Q1R0S9T8V7'

function app() {
  return createApp({
    authMode: 'local-daemon' as const,
    token: TOKEN,
    touch: () => {},
    getStatus: () => ({ port: 3099 }) as never,
    serverDeps,
    dataLayout: testDataLayout(),
  })
}

/**
 * A workspace whose segment differs from its id, so a page subscribed by
 * segment holds a key the canonical, id-keyed cache does not spell.
 */
async function createWorkspace(a: ReturnType<typeof app>) {
  const res = await a.request('/api/workspaces', {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ displayName: 'Viewport Replay' }),
  })
  const { workspaceId, segment } = (await res.json()) as { workspaceId: string; segment: string }
  expect(segment).not.toBe(workspaceId)
  return { workspaceId, segment }
}

/** A notifier over an index that knows `path`; each case has its own path, since the cache is process-wide. */
function notifierFor(workspaceId: string, path: string) {
  const index = new InMemoryDocumentIndex()
  index.seed({ workspaceId, documentId: DOCUMENT_ID, path, kind: 'spatial' })
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

/**
 * The viewport requests among the frames, each parsed by the contract the page
 * parses it with — a frame that schema rejects throws here, where the page
 * would drop it — and answered as the document it is addressed to.
 */
function viewportRequestDocs(text: string): string[] {
  return text
    .split('\n\n')
    .filter((f) => f.split('\n').includes('event: message'))
    .map(
      (f): SyncMessageEvent =>
        syncMessageEventSchema.parse(
          JSON.parse(
            f
              .split('\n')
              .find((l) => l.startsWith('data:'))
              ?.slice(5) ?? '',
          ),
        ),
    )
    .filter((m) => JSON.parse(m.raw).type === 'viewport_request')
    .map((m) => m.doc)
}

describe('a viewport request issued before any page is ready', () => {
  it('is answered delivered:false, then reaches the first page that signals client_ready exactly once', async () => {
    const a = app()
    const { workspaceId, segment } = await createWorkspace(a)
    const stream = await openStream(a)
    const doc = `${segment}/replay-fresh`
    await post(a, 'subscribe', { streamId: stream.streamId, subscribe: [doc] })

    const delivered = await notifierFor(workspaceId, 'replay-fresh').requestViewport({
      workspaceId,
      documentId: DOCUMENT_ID,
      mode: 'fit',
    })
    expect(delivered).toBe(false)

    await post(a, 'message', { streamId: stream.streamId, doc, message: { type: 'client_ready' } })
    expect(viewportRequestDocs(await framesWithin(stream, 300))).toEqual([doc])
  })

  it('is not replayed once it is older than the replay window', async () => {
    const a = app()
    const { workspaceId, segment } = await createWorkspace(a)
    const stream = await openStream(a)
    const doc = `${segment}/replay-stale`
    await post(a, 'subscribe', { streamId: stream.streamId, subscribe: [doc] })

    // Only the clock is faked: the SSE plumbing needs real timers.
    vi.useFakeTimers({ toFake: ['Date'] })
    await notifierFor(workspaceId, 'replay-stale').requestViewport({
      workspaceId,
      documentId: DOCUMENT_ID,
      mode: 'fit',
    })
    vi.setSystemTime(Date.now() + VIEWPORT_REPLAY_TTL_MS + 1)
    await post(a, 'message', { streamId: stream.streamId, doc, message: { type: 'client_ready' } })
    vi.useRealTimers()

    expect(viewportRequestDocs(await framesWithin(stream, 300))).toEqual([])
  })
})
