/**
 * The hub against the route it talks to, both real.
 *
 * Each half is tested alone elsewhere — the hub against a fake daemon, the
 * route against hand-written requests — and neither can see what they do to
 * each other: the hub re-announces everything it follows in one request after
 * every reconnect, and the route refuses a request as a whole. A single
 * workspace the caller may no longer enter, or a count past the stream's
 * limit, then silently ended live sync for every unrelated document too.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type DocListener, SseStreamHub } from '@kamiazya/whiteboard-daemon-client/sse-stream-hub'
import { MAX_DOCS_PER_STREAM } from '@kamiazya/whiteboard-daemon-client/sync-sse-contract'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { resetDataDirForTests, setDataDirForTests } from '../../shared/data-dir-secure.js'
import type { WorkspaceAdmit } from '../security/membership-gate.js'
import { resetSyncStreamsForTests, sseClientCount } from '../sync-streams.js'
import { createSyncSseRouter } from './sync-sse.js'

// Its own data dir: resolving a workspace handle opens the store, and one
// shared with a file running in parallel waits on that file's lock.
setDataDirForTests(mkdtempSync(join(tmpdir(), 'wb-sse-hub-')))
afterAll(() => resetDataDirForTests())

const hubs: SseStreamHub[] = []
afterEach(() => {
  for (const hub of hubs.splice(0)) hub.close()
  resetSyncStreamsForTests()
})

/** A hub whose every request goes straight into the real router. */
function hubOver(admit: WorkspaceAdmit): SseStreamHub {
  const app = createSyncSseRouter({
    workspaceDocuments: { onUpdated: () => () => {} },
    admit,
  })
  const hub = new SseStreamHub({
    baseUrl: 'http://daemon.test',
    fetch: (input, init) => Promise.resolve(app.fetch(new Request(input, init))),
    retryDelayMs: () => 0,
  })
  hubs.push(hub)
  return hub
}

function listener() {
  const events = { refused: 0, connection: [] as boolean[] }
  const doc: DocListener = {
    onUpdate: () => {},
    onMessage: () => {},
    onConnectionChange: (connected) => events.connection.push(connected),
    onAuthRefused: () => {
      events.refused += 1
    },
  }
  return { doc, events }
}

// The first request resolves a workspace handle, which opens the store.
const SETTLE = { timeout: 10_000 }

const followed = (workspace: string, paths: readonly string[]) =>
  paths.filter((path) => sseClientCount(workspace, path, false) === 1)

describe('the sync hub against the sync route', () => {
  it('keeps unrelated documents live when one workspace has been revoked', async () => {
    const hub = hubOver(async (_c, workspaceId) =>
      workspaceId === 'revoked-ws' ? 'not_a_member' : 'admitted',
    )
    const live = [listener(), listener()]
    const revoked = listener()
    hub.subscribe('live-ws/a', live[0]?.doc as DocListener)
    hub.subscribe('revoked-ws/c', revoked.doc)
    hub.subscribe('live-ws/b', live[1]?.doc as DocListener)

    await vi.waitFor(() => expect(followed('live-ws', ['a', 'b'])).toEqual(['a', 'b']), SETTLE)
    expect(followed('revoked-ws', ['c'])).toEqual([])
    // Told to the documents it concerns, and to nobody else.
    await vi.waitFor(() => expect(revoked.events.refused).toBe(1), SETTLE)
    expect(live.map((l) => l.events.refused)).toEqual([0, 0])
    expect(live.map((l) => l.events.connection.at(-1))).toEqual([true, true])
  })

  it('follows what the stream may hold and reports the documents past that as not live', async () => {
    const hub = hubOver(async () => 'admitted')
    const paths = Array.from({ length: 300 }, (_, i) => `doc-${i}`)
    const listeners = paths.map(() => listener())
    paths.forEach((path, i) => {
      hub.subscribe(`big-ws/${path}`, listeners[i]?.doc as DocListener)
    })

    await vi.waitFor(
      () => expect(followed('big-ws', paths)).toHaveLength(MAX_DOCS_PER_STREAM),
      SETTLE,
    )
    const live = new Set(followed('big-ws', paths))
    // Every document is either followed or says it is not; none claims a
    // connection the daemon does not hold.
    await vi.waitFor(() => {
      paths.forEach((path, i) => {
        expect(listeners[i]?.events.connection.at(-1)).toBe(live.has(path))
      })
    }, SETTLE)
  })
})
