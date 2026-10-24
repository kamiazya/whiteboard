// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { jsonResponse } from '../test-utils/json-response.js'
import { createDaemonFilesSource } from './daemon-files-source.js'

const BASE = 'http://127.0.0.1:3099'

describe('createDaemonFilesSource writeTagLibrary', () => {
  const written = { health: { values: { ok: { color: '4' } } } }

  function libraryFetch() {
    const puts: Array<{ url: string; body: unknown }> = []
    let reads = 0
    const fetchLike = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.endsWith('/tag-library') && init?.method === 'PUT') {
        puts.push({ url, body: JSON.parse(String(init.body)) })
        return Promise.resolve(jsonResponse({ documentId: '01HZX3K9Q5V8N2M4P6R7S8T9WA' }))
      }
      if (url.endsWith('/document-tags')) {
        reads += 1
        return Promise.resolve(
          jsonResponse({
            documents: [],
            contents: [],
            inUse: [],
            library: puts.length > 0 ? written : {},
          }),
        )
      }
      return Promise.resolve(jsonResponse({ message: 'unexpected' }, 500))
    }) as unknown as typeof globalThis.fetch
    return { puts, reads: () => reads, fetchLike }
  }

  it('PUTs the whole library to the daemon route', async () => {
    const { puts, fetchLike } = libraryFetch()
    const source = createDaemonFilesSource(fetchLike, BASE, 'ws')
    await source.writeTagLibrary?.(written)
    expect(puts).toEqual([
      { url: `${BASE}/api/v1/workspaces/ws/tag-library`, body: { library: written } },
    ])
  })

  it('reads the library again after writing it, not from before', async () => {
    const { reads, fetchLike } = libraryFetch()
    const source = createDaemonFilesSource(fetchLike, BASE, 'ws')
    await expect(source.readTagLibrary?.()).resolves.toEqual({})
    await source.writeTagLibrary?.(written)
    await expect(source.readTagLibrary?.()).resolves.toEqual(written)
    expect(reads()).toBe(2)
  })
})
