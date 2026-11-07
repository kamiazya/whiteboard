// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { otherReadBody } from '../test-utils/fake-daemon-fetch.js'
import { jsonResponse } from '../test-utils/json-response.js'
import { createDaemonFilesSource } from './daemon-files-source.js'

const BASE = 'http://127.0.0.1:3099'

describe('createDaemonFilesSource addressing a document by its id', () => {
  const listed = {
    documents: [{ documentId: '01ARZ3NDEKTSV4RRFFQ69G5FAV', path: 'boards/mood', kind: 'spatial' }],
  }

  function recordingFetch() {
    const writes: Array<{ method: string; url: string; body: unknown }> = []
    const fetchLike = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (init?.method === 'PUT') {
        writes.push({ method: 'PUT', url, body: JSON.parse(String(init.body)) })
        return Promise.resolve(
          jsonResponse(url.endsWith('/path') ? { path: 'x' } : { documents: {}, pinned: [] }),
        )
      }
      if (url.endsWith('/documents')) return Promise.resolve(jsonResponse(listed))
      return Promise.resolve(otherReadBody(url))
    }) as unknown as typeof globalThis.fetch
    return { writes, fetchLike }
  }

  it('moves the document its path names through the listing, by id', async () => {
    const { writes, fetchLike } = recordingFetch()
    await createDaemonFilesSource(fetchLike, BASE, 'ws').renameDocumentPath('boards/mood', 'x')
    expect(writes).toEqual([
      {
        method: 'PUT',
        url: `${BASE}/api/workspaces/ws/documents/01ARZ3NDEKTSV4RRFFQ69G5FAV/path`,
        body: { path: 'x' },
      },
    ])
  })

  it('refuses to move a path the listing does not hold, sending nothing', async () => {
    const { writes, fetchLike } = recordingFetch()
    await expect(
      createDaemonFilesSource(fetchLike, BASE, 'ws').renameDocumentPath('boards/gone', 'x'),
    ).rejects.toThrow('No document at "boards/gone" to move')
    expect(writes).toEqual([])
  })

  it('pins by the row id, and resolves a path-only entry through the listing', async () => {
    const { writes, fetchLike } = recordingFetch()
    const source = createDaemonFilesSource(fetchLike, BASE, 'ws')
    await source.setPinned?.({ path: 'boards/mood' }, true)
    await source.setPinned?.({ documentId: 'other', path: 'boards/mood' }, true)
    expect(writes.map((each) => each.url)).toEqual([
      `${BASE}/api/workspaces/ws/documents/01ARZ3NDEKTSV4RRFFQ69G5FAV/pin`,
      `${BASE}/api/workspaces/ws/documents/other/pin`,
    ])
  })

  it('reads a spatial snapshot by the row id', async () => {
    const fetchLike = vi.fn(
      async () => new Response(new Uint8Array([1])),
    ) as unknown as typeof fetch & ReturnType<typeof vi.fn>
    await createDaemonFilesSource(fetchLike, BASE, 'ws').loadSpatialSnapshot?.({
      documentId: 'd',
      path: 'boards/mood',
      kind: 'spatial',
    })
    expect(String(fetchLike.mock.calls[0]?.[0])).toBe(
      `${BASE}/api/workspaces/ws/documents/d/snapshot`,
    )
  })
})
