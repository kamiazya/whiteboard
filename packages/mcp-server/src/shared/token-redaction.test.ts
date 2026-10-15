// @vitest-environment node
//
// Regression guard: the daemon auth token must never surface in a log
// record while flowing through apiFetch -> SseBackend.
// None of these modules call getLogger today, so this test is a tripwire —
// it fails the moment a future log call captures the token value anywhere
// in a record's message or structured fields.

import { apiFetch } from '@kamiazya/whiteboard-daemon-client/api-client'
import { SseBackend } from '@kamiazya/whiteboard-daemon-client/sse-backend'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { captureLogsForTests } from '../server/log.js'

const SENTINEL_TOKEN = 'sentinel-do-not-log-9f3c2a'

function recordsContainSentinel(
  records: ReturnType<typeof captureLogsForTests>['records'],
): boolean {
  return records.some((record) => {
    const haystack = `${record.msg} ${JSON.stringify(record.data ?? {})}`
    return haystack.includes(SENTINEL_TOKEN)
  })
}

describe('token redaction: sentinel never reaches a log record', () => {
  let originalWindow: unknown
  let originalFetch: typeof fetch

  beforeEach(() => {
    originalWindow = (globalThis as Record<string, unknown>).window
    originalFetch = globalThis.fetch
    ;(globalThis as Record<string, unknown>).window = {
      location: { origin: 'http://localhost' },
      __WHITEBOARD_DAEMON_TOKEN__: SENTINEL_TOKEN,
    }
    globalThis.fetch = (async () => new Response('ok')) as typeof fetch
  })

  afterEach(() => {
    ;(globalThis as Record<string, unknown>).window = originalWindow
    globalThis.fetch = originalFetch
  })

  it('apiFetch auth-header attachment does not log the sentinel', async () => {
    const capture = captureLogsForTests()
    try {
      await apiFetch('http://localhost/api/workspaces')
      expect(recordsContainSentinel(capture.records)).toBe(false)
    } finally {
      capture.restore()
    }
  })

  it('SseBackend (incl. a refused stream) does not log the sentinel', async () => {
    const capture = captureLogsForTests()
    // The keeper refuses every request, so the stream takes its failure path —
    // the one a careless log line would sit on. No snapshot is asked for: the
    // backend reads state only once the stream carries the document.
    const refused = vi.fn(async () => new Response('denied', { status: 401 }))
    const onAuthError = vi.fn()
    globalThis.fetch = refused as unknown as typeof fetch
    try {
      const backend = new SseBackend('ws-id', 'path', 'http://localhost/')
      backend.connect({
        onSnapshot: () => {},
        onRemoteUpdate: () => {},
        onVersionCreated: () => {},
        onRestoreStarted: () => {},
        onRestoreComplete: () => {},
        onViewportRequest: () => {},
        onConnected: () => {},
        onAuthError,
      })
      // The refusal reported: the failure path has run.
      await vi.waitFor(() => expect(onAuthError).toHaveBeenCalled())
      expect(refused).toHaveBeenCalled()
      backend.disconnect()
      expect(recordsContainSentinel(capture.records)).toBe(false)
    } finally {
      capture.restore()
    }
  })
})
