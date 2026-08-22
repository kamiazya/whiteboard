import { describe, expect, it, vi } from 'vitest'
import { createDaemonFilesSource } from './daemon-files-source.js'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

const BASE = 'http://127.0.0.1:3099'

function fetchStub(handlers: {
  documents?: () => Response
  names?: () => Response
}): typeof globalThis.fetch {
  return vi.fn((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString()
    if (url.endsWith('/names')) {
      return Promise.resolve(handlers.names?.() ?? jsonResponse({ documents: {}, pinned: [] }))
    }
    if (url.endsWith('/documents')) {
      return Promise.resolve(handlers.documents?.() ?? jsonResponse({ documents: [] }))
    }
    return Promise.resolve(jsonResponse({ message: 'unexpected' }, 500))
  }) as unknown as typeof globalThis.fetch
}

describe('createDaemonFilesSource pinned mapping', () => {
  it('marks entries pinned from the names response, in pin order', async () => {
    const source = createDaemonFilesSource(
      fetchStub({
        documents: () =>
          jsonResponse({
            documents: [
              { path: 'alpha', updatedAt: '2026-08-01T00:00:00Z' },
              { path: 'beta', updatedAt: '2026-08-02T00:00:00Z' },
              { path: 'gamma', updatedAt: '2026-08-03T00:00:00Z' },
            ],
          }),
        names: () => jsonResponse({ documents: {}, pinned: ['gamma', 'beta'] }),
      }),
      BASE,
      'ws',
    )
    const entries = await source.listDocuments()
    const byPath = new Map(entries.map((e) => [e.path, e.pinOrder]))
    expect(byPath.get('gamma')).toBe(0)
    expect(byPath.get('beta')).toBe(1)
    expect(byPath.get('alpha')).toBeUndefined()
  })

  // The grid page treated a failed names fetch as "nothing pinned" rather
  // than a failed list — the panel keeps that degradation.
  it('lists unpinned when the names fetch fails', async () => {
    const source = createDaemonFilesSource(
      fetchStub({
        documents: () =>
          jsonResponse({ documents: [{ path: 'alpha', updatedAt: '2026-08-01T00:00:00Z' }] }),
        names: () => jsonResponse({ message: 'boom' }, 500),
      }),
      BASE,
      'ws',
    )
    const entries = await source.listDocuments()
    expect(entries).toHaveLength(1)
    expect(entries[0]?.pinOrder).toBeUndefined()
  })
})
