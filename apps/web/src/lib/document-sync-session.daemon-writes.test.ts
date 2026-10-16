/**
 * "Saved" means the daemon holds everything the page shows, whichever way the
 * page's writes leave it.
 *
 * A page with no SharedWorker in front — every daemon reached through the
 * extension bridge, and any browser without SharedWorker — writes through an
 * `SseBackend` that owns its stream hub. A write the daemon answers with a
 * transient failure must still reach it, and the page must not read "saved"
 * while the daemon holds less than the page does: the session pushes one
 * commit's ops per write, so a later edit landing does not carry an earlier
 * one that failed.
 *
 * Real session, real backend, real hub; only `fetch` is a fake daemon, whose
 * document is the seed plus every update body it accepted.
 */
import { SseBackend } from '@kamiazya/whiteboard-daemon-client/sse-backend'
import type {
  DocListener,
  SseStreamSource,
} from '@kamiazya/whiteboard-daemon-client/sse-stream-hub'
import { readSpatialCanvas, writeSpatialCanvas } from '@kamiazya/whiteboard-loro-adapter'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { LoroDoc } from 'loro-crdt'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { jsonResponse } from '../test-utils/json-response.js'
import type { BrowserPersistenceState } from './browser-persistence-state.js'
import {
  COMMIT_DEBOUNCE_MS,
  createDocumentSyncSession,
  createGenerationCounters,
} from './document-sync-session.js'
import { applyCommand, type EditorCommand } from './spatial/commands.js'

const WORKSPACE = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
const canvas0: SpatialCanvas = {
  nodes: [
    textNode({ id: 'n-a', x: 0, y: 0, width: 100, height: 50, text: 'a' }),
    textNode({ id: 'n-b', x: 200, y: 0, width: 100, height: 50, text: 'b' }),
  ],
  edges: [],
}

afterEach(() => {
  vi.useRealTimers()
})

async function turns(): Promise<void> {
  for (let i = 0; i < 60; i++) await Promise.resolve()
}

/**
 * A daemon that answers the update POSTs listed in `busyPosts` (1-based,
 * counting the connect-time full-state write) with 503 database_busy and
 * Retry-After: 1, and accepts every other one — those in `heldPosts` only
 * once `answerHeld()` is called.
 */
function fakeDaemon(busyPosts: ReadonlySet<number>, heldPosts: ReadonlySet<number> = new Set()) {
  const seed = new LoroDoc()
  writeSpatialCanvas(seed, canvas0)
  const seedBytes = seed.export({ mode: 'snapshot' })
  const accepted: Uint8Array[] = []
  let posts = 0
  const held: (() => void)[] = []
  const encoder = new TextEncoder()
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('/api/sync/stream')) {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('event: ready\ndata: {"streamId":"s1"}\n\n'))
        },
      })
      return new Response(body, { status: 200 })
    }
    if (init?.method === 'POST' && url.endsWith('/update')) {
      posts += 1
      if (heldPosts.has(posts)) await new Promise<void>((resolve) => held.push(resolve))
      if (busyPosts.has(posts)) {
        const busy = jsonResponse({ error: 'database_busy' }, 503)
        busy.headers.set('Retry-After', '1')
        return busy
      }
      accepted.push(new Uint8Array(init.body as ArrayBuffer))
      return jsonResponse({})
    }
    if (init?.method === 'POST') return jsonResponse({})
    return new Response(seedBytes.slice().buffer as ArrayBuffer, { status: 200 })
  }) as typeof fetch
  return {
    fetchFn,
    answerHeld: () => {
      for (const answer of held.splice(0)) answer()
    },
    /** The daemon's document: the seed with every accepted body imported. */
    held(): SpatialCanvas {
      const doc = new LoroDoc()
      doc.import(seedBytes)
      for (const body of accepted) doc.import(body)
      return readSpatialCanvas(doc)
    },
  }
}

function positionOf(value: SpatialCanvas, id: string) {
  const node = value.nodes.find((n) => n.id === id)
  return { x: node?.x, y: node?.y }
}

function openSession(daemon: ReturnType<typeof fakeDaemon>, shown: () => SpatialCanvas) {
  const backend = new SseBackend(WORKSPACE, 'note', 'http://d', { fetch: daemon.fetchFn })
  const states: BrowserPersistenceState['kind'][] = []
  // Every `saved` is judged at the moment it is reported: what the page shows
  // must already be what the daemon holds.
  const savedAhead: string[] = []
  const session = createDocumentSyncSession(backend, {
    getOptions: () => ({}),
    onStatusChange: () => {},
    onBackendError: () => {},
    onRestoreChange: () => {},
    dispatchIdentityEvent: () => {},
    generations: createGenerationCounters(),
    onPersistenceChange: (state) => {
      states.push(state.kind)
      if (state.kind !== 'saved') return
      const held = daemon.held()
      for (const id of ['n-a', 'n-b']) {
        const want = positionOf(shown(), id)
        const got = positionOf(held, id)
        if (want.x !== got.x || want.y !== got.y) savedAhead.push(id)
      }
    },
  })
  return { session, states, savedAhead }
}

describe('a page leaving a document straight after an edit', () => {
  // A document switch disposes the session as soon as the edit is handed
  // over. On a slow daemon the edit before it is still on the wire, so the
  // last edit waits behind it — and must still reach the daemon.
  it('delivers the last edit while the one before it is still being answered', async () => {
    vi.useFakeTimers()
    // POST 1 is the connect-time full state; POST 2 is edit 1.
    const daemon = fakeDaemon(new Set(), new Set([2]))
    let shown = canvas0
    const s = openSession(daemon, () => shown)
    s.session.connect()
    await vi.advanceTimersByTimeAsync(10)
    await turns()

    const e1: EditorCommand = { kind: 'move-node', id: 'n-a', x: 10, y: 20 }
    shown = applyCommand(shown, e1)
    s.session.onChange(shown, e1)
    await vi.advanceTimersByTimeAsync(COMMIT_DEBOUNCE_MS)
    await turns()
    const e2: EditorCommand = { kind: 'move-node', id: 'n-b', x: 555, y: 5 }
    shown = applyCommand(shown, e2)
    s.session.onChange(shown, e2)
    s.session.dispose()
    await vi.advanceTimersByTimeAsync(5_000)
    daemon.answerHeld()
    await vi.advanceTimersByTimeAsync(10)
    await turns()

    expect(positionOf(daemon.held(), 'n-a')).toEqual({ x: 10, y: 20 })
    expect(positionOf(daemon.held(), 'n-b')).toEqual({ x: 555, y: 5 })
  })
})

describe('a page writing straight to the daemon', () => {
  it('delivers an edit the daemon was too busy to take, with the edit after it', async () => {
    vi.useFakeTimers()
    // POST 1 is the connect-time full state; POST 2 is edit 1.
    const daemon = fakeDaemon(new Set([2]))
    let shown = canvas0
    const s = openSession(daemon, () => shown)
    s.session.connect()
    await vi.advanceTimersByTimeAsync(10)
    await turns()

    const e1: EditorCommand = { kind: 'move-node', id: 'n-a', x: 10, y: 20 }
    shown = applyCommand(shown, e1)
    s.session.onChange(shown, e1)
    await vi.advanceTimersByTimeAsync(COMMIT_DEBOUNCE_MS)
    await turns()

    const e2: EditorCommand = { kind: 'move-node', id: 'n-b', x: 555, y: 5 }
    shown = applyCommand(shown, e2)
    s.session.onChange(shown, e2)
    await vi.advanceTimersByTimeAsync(COMMIT_DEBOUNCE_MS)
    await turns()

    await vi.advanceTimersByTimeAsync(60_000)
    await turns()

    const held = daemon.held()
    expect(positionOf(held, 'n-a')).toEqual({ x: 10, y: 20 })
    expect(positionOf(held, 'n-b')).toEqual({ x: 555, y: 5 })
    expect(s.savedAhead).toEqual([])
    expect(s.states.at(-1)).toBe('saved')
    s.session.dispose()
  })

  it('delivers a lone edit the daemon was too busy to take, with no later edit to carry it', async () => {
    vi.useFakeTimers()
    const daemon = fakeDaemon(new Set([2]))
    let shown = canvas0
    const s = openSession(daemon, () => shown)
    s.session.connect()
    await vi.advanceTimersByTimeAsync(10)
    await turns()

    const e1: EditorCommand = { kind: 'move-node', id: 'n-a', x: 10, y: 20 }
    shown = applyCommand(shown, e1)
    s.session.onChange(shown, e1)
    await vi.advanceTimersByTimeAsync(COMMIT_DEBOUNCE_MS)
    await turns()
    expect(s.states).toContain('degraded')

    await vi.advanceTimersByTimeAsync(60_000)
    await turns()

    expect(positionOf(daemon.held(), 'n-a')).toEqual({ x: 10, y: 20 })
    expect(s.savedAhead).toEqual([])
    expect(s.states.at(-1)).toBe('saved')
    s.session.dispose()
  })
})

/**
 * The SharedWorker-backed source takes a push at once and writes onward
 * itself, retrying; it tells the page a write failed, and later that
 * everything landed. A later edit handed over in between has not landed
 * anything — the worker reports only the first failure of a run, so the page
 * would read "saved" over a retry that is still failing.
 */
describe('a page writing through the SharedWorker', () => {
  function workerSource() {
    const seed = new LoroDoc()
    writeSpatialCanvas(seed, canvas0)
    const listeners: DocListener[] = []
    const source: SseStreamSource = {
      subscribe: (_doc, listener) => {
        listeners.push(listener)
        listener.onConnectionChange?.(true)
        return () => {}
      },
      sendMessage: () => {},
      push: () => {},
      snapshot: async () => seed.export({ mode: 'snapshot' }),
    }
    return {
      source,
      writeState: (landed: boolean) => {
        for (const l of listeners) l.onWriteState?.(landed)
      },
    }
  }

  it('reads saved only once the worker says the failed write landed, not when a later edit is handed over', async () => {
    vi.useFakeTimers()
    const worker = workerSource()
    const backend = new SseBackend(WORKSPACE, 'note', 'http://d', undefined, worker.source)
    const states: BrowserPersistenceState['kind'][] = []
    const session = createDocumentSyncSession(backend, {
      getOptions: () => ({}),
      onStatusChange: () => {},
      onBackendError: () => {},
      onRestoreChange: () => {},
      dispatchIdentityEvent: () => {},
      generations: createGenerationCounters(),
      onPersistenceChange: (state) => states.push(state.kind),
    })
    session.connect()
    await vi.advanceTimersByTimeAsync(10)
    await turns()

    const e1: EditorCommand = { kind: 'move-node', id: 'n-a', x: 10, y: 20 }
    const c1 = applyCommand(canvas0, e1)
    session.onChange(c1, e1)
    await vi.advanceTimersByTimeAsync(COMMIT_DEBOUNCE_MS)
    await turns()
    worker.writeState(false)
    await turns()
    expect(states.at(-1)).toBe('degraded')

    const e2: EditorCommand = { kind: 'move-node', id: 'n-b', x: 555, y: 5 }
    session.onChange(applyCommand(c1, e2), e2)
    await vi.advanceTimersByTimeAsync(COMMIT_DEBOUNCE_MS)
    await turns()
    expect(states.at(-1)).toBe('degraded')

    worker.writeState(true)
    await turns()
    expect(states.at(-1)).toBe('saved')
    session.dispose()
  })
})
