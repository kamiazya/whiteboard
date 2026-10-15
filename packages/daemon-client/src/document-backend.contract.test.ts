// @vitest-environment node
// The SSE backend against the shared DocumentBackend contract. The backend
// over a workspace kept in the browser runs the same cases from apps/web,
// where its store lives, and so does this backend over the SharedWorker.
import { bytesToBase64 } from '@kamiazya/whiteboard-model'
import { LoroDoc } from 'loro-crdt'
import { describe, vi } from 'vitest'
import { SseBackend } from './sse-backend.js'
import type { DocumentBackendHarness } from './test-utils/document-backend-contract.js'
import { documentBackendContract } from './test-utils/document-backend-contract.js'

const BASE = 'http://127.0.0.1:3099'

/**
 * The daemon's side of one harness: a real Loro document it serves snapshots
 * of and broadcasts the updates of, so "caught up" is a CRDT's answer rather
 * than a count of frames.
 */
function keeper() {
  const doc = new LoroDoc()
  doc.getText('t').insert(0, 'seed')
  doc.commit()
  let broadcast = doc.oplogVersion()
  let seq = 0
  return {
    doc,
    /** Commits a change; answers the update bytes since the last broadcast. */
    write(): Uint8Array {
      const text = doc.getText('t')
      text.insert(text.length, `+${++seq}`)
      doc.commit()
      const update = doc.export({ mode: 'update', from: broadcast })
      broadcast = doc.oplogVersion()
      return update
    },
  }
}

const sseFrame = (event: string, data: unknown) =>
  new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)

/** What the fake daemon's routes see and hold, per harness. */
interface Daemon {
  keeper: ReturnType<typeof keeper>
  sent: Uint8Array[]
  stream: ReadableStreamDefaultController<Uint8Array> | null
  /**
   * Whether the open stream carries the workspace: set when a subscribe for
   * it is taken, cleared with the stream, as the daemon's routing is. A
   * frame reaches only a routed stream, and nothing is replayed.
   */
  routed: boolean
  refuseStreams: boolean
  /** Whether the keeper commits a write of its own once it has served a snapshot. */
  writeAfterSnapshot: boolean
  /** How the stream fails to carry the workspace, when it does. */
  unroutable: 'refused' | 'silent' | null
  /** Whether the next snapshot read answers 503. */
  failNextSnapshot: boolean
}

const WORKSPACE_KEY = 'workspace:ws-1'

/** A keeper write, broadcast as a frame when the stream carries the workspace. */
function keeperWrite(daemon: Daemon): void {
  const update = daemon.keeper.write()
  if (!daemon.routed) return
  const frame = { doc: WORKSPACE_KEY, update: bytesToBase64(update) }
  daemon.stream?.enqueue(sseFrame('update', frame))
}

/** The daemon's snapshot route: the keeper's state, unless it is set to fail this read. */
function snapshotAnswer(daemon: Daemon): Response {
  if (daemon.failNextSnapshot) {
    daemon.failNextSnapshot = false
    return new Response('{"title":"unavailable"}', { status: 503 })
  }
  const snapshot = daemon.keeper.doc.export({ mode: 'snapshot' })
  if (daemon.writeAfterSnapshot) {
    daemon.writeAfterSnapshot = false
    keeperWrite(daemon)
  }
  return new Response(snapshot.slice().buffer as ArrayBuffer, { status: 200 })
}

function daemonFetch(daemon: Daemon): typeof globalThis.fetch {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('/api/sync/stream') && daemon.refuseStreams) {
      return new Response('{"title":"unauthorized"}', { status: 401 })
    }
    if (url.includes('/snapshot')) return snapshotAnswer(daemon)
    if (url.includes('/update')) {
      const body = init?.body
      if (body instanceof ArrayBuffer) daemon.sent.push(new Uint8Array(body))
      return new Response('{}', { status: 200 })
    }
    if (url.includes('/api/sync/subscribe')) {
      const body = JSON.parse(String(init?.body)) as { subscribe?: string[] }
      if (body.subscribe?.includes(WORKSPACE_KEY)) {
        if (daemon.unroutable === 'refused') {
          return new Response('{"error":"unknown_stream"}', { status: 404 })
        }
        daemon.routed = true
      }
      return new Response('{}', { status: 200 })
    }
    if (url.includes('/api/sync/stream')) {
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            // A buffering proxy holds the small `ready` frame back, so no
            // subscribe is ever sent on this stream.
            if (daemon.unroutable !== 'silent') {
              controller.enqueue(sseFrame('ready', { streamId: 'contract-stream' }))
            }
            daemon.stream = controller
          },
        }),
        { status: 200 },
      )
    }
    // A file the canvas does not have. 404 is what the daemon answers.
    if (url.includes('/file/')) return new Response('not found', { status: 404 })
    return new Response('{}', { status: 200 })
  }) as unknown as typeof globalThis.fetch
}

/** Whether `delivered`, applied in order to an empty document, reads as the keeper's. */
function reproduces(delivered: readonly Uint8Array[], keeperDoc: LoroDoc): boolean {
  const replica = new LoroDoc()
  for (const bytes of delivered) {
    try {
      replica.import(bytes)
    } catch {
      // Bytes that are not Loro's say nothing about what was caught up.
    }
  }
  return replica.getText('t').toString() === keeperDoc.getText('t').toString()
}

function harness(): DocumentBackendHarness {
  const daemon: Daemon = {
    keeper: keeper(),
    sent: [],
    stream: null,
    routed: false,
    refuseStreams: false,
    writeAfterSnapshot: false,
    unroutable: null,
    failNextSnapshot: false,
  }
  const backend = new SseBackend('ws-1', 'canvas-a', BASE, { fetch: daemonFetch(daemon) })
  return {
    backend,
    sentUpdates: () => daemon.sent,
    dropTransport: () => {
      daemon.stream?.close()
      daemon.stream = null
      daemon.routed = false
    },
    refuseAuth: () => {
      daemon.refuseStreams = true
    },
    keeperWrites: (live) => {
      if (live) keeperWrite(daemon)
      else daemon.keeper.write()
    },
    keeperWritesAfterNextSnapshot: () => {
      daemon.writeAfterSnapshot = true
    },
    neverRoutes: (how) => {
      daemon.unroutable = how
    },
    failsOpeningRead: () => {
      daemon.failNextSnapshot = true
    },
    caughtUp: (delivered) => reproduces(delivered, daemon.keeper.doc),
    cleanup: () => backend.disconnect(),
  }
}

describe('DocumentBackend contract: SseBackend', () => {
  documentBackendContract(harness)
})
