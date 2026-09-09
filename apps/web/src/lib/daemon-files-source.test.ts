// @vitest-environment node
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

describe('createDaemonFilesSource trash', () => {
  it('lists the trash and restores through the daemon routes', async () => {
    const calls: string[] = []
    const fetchLike = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      calls.push(`${init?.method ?? 'GET'} ${url}`)
      if (url.endsWith('/trash')) {
        return Promise.resolve(
          jsonResponse({
            entries: [{ documentId: 'id-gone', path: 'old/plan', deletedAt: 1_700_000 }],
          }),
        )
      }
      if (url.endsWith('/restore') && init?.method === 'POST') {
        return Promise.resolve(
          jsonResponse({ restored: { documentId: 'id-gone', path: 'old/plan' } }),
        )
      }
      return Promise.resolve(jsonResponse({ message: 'unexpected' }, 500))
    }) as unknown as typeof globalThis.fetch
    const source = createDaemonFilesSource(fetchLike, BASE, 'ws')

    const entries = await source.listTrash?.()
    expect(entries).toEqual([{ documentId: 'id-gone', path: 'old/plan', deletedAt: 1_700_000 }])

    await source.restoreFromTrash?.('id-gone')
    expect(
      calls.some((line) => line === `POST ${BASE}/api/workspaces/ws/trash/id-gone/restore`),
    ).toBe(true)
  })
})

describe('createDaemonFilesSource setDocumentName', () => {
  function nameFetchStub(calls: Array<{ url: string; body: unknown }>): typeof globalThis.fetch {
    return vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.endsWith('/name') && init?.method === 'PUT') {
        calls.push({ url, body: JSON.parse(String(init.body)) })
        return Promise.resolve(jsonResponse({ documents: {}, pinned: [] }))
      }
      return Promise.resolve(jsonResponse({ message: 'unexpected' }, 500))
    }) as unknown as typeof globalThis.fetch
  }

  it('PUTs the new display name for the entry path', async () => {
    const calls: Array<{ url: string; body: unknown }> = []
    const source = createDaemonFilesSource(nameFetchStub(calls), BASE, 'ws')
    await source.setDocumentName({ documentId: 'id1', path: 'plans/roadmap' }, 'Roadmap')
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toContain('roadmap')
    expect(calls[0]?.body).toEqual({ name: 'Roadmap' })
  })

  it("clears with the API's delete spelling: an empty string", async () => {
    const calls: Array<{ url: string; body: unknown }> = []
    const source = createDaemonFilesSource(nameFetchStub(calls), BASE, 'ws')
    await source.setDocumentName({ documentId: 'id1', path: 'plans/roadmap' }, undefined)
    expect(calls[0]?.body).toEqual({ name: '' })
  })
})

describe('createDaemonFilesSource shadowed mapping', () => {
  it('carries the shadowed collision marker into the panel entry', async () => {
    const source = createDaemonFilesSource(
      fetchStub({
        documents: () =>
          jsonResponse({
            documents: [
              {
                path: 'contested',
                id: 'id-a',
                updatedAt: '2026-08-01T00:00:00Z',
                kind: 'spatial',
                shadowed: true,
              },
              { path: 'plain', id: 'id-b', updatedAt: '2026-08-02T00:00:00Z', kind: 'spatial' },
            ],
          }),
      }),
      BASE,
      'ws',
    )
    const entries = await source.listDocuments()
    const byPath = new Map(entries.map((e) => [e.path, e.shadowed]))
    expect(byPath.get('contested')).toBe(true)
    expect(byPath.get('plain')).toBeUndefined()
  })
})

describe('createDaemonFilesSource pinned mapping', () => {
  it('marks entries pinned from the names response, in pin order', async () => {
    const source = createDaemonFilesSource(
      fetchStub({
        documents: () =>
          jsonResponse({
            documents: [
              { path: 'alpha', id: 'id-alpha', updatedAt: '2026-08-01T00:00:00Z', kind: 'spatial' },
              { path: 'beta', id: 'id-beta', updatedAt: '2026-08-02T00:00:00Z', kind: 'spatial' },
              { path: 'gamma', id: 'id-gamma', updatedAt: '2026-08-03T00:00:00Z', kind: 'spatial' },
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
          jsonResponse({
            documents: [
              { path: 'alpha', id: 'id-alpha', updatedAt: '2026-08-01T00:00:00Z', kind: 'spatial' },
            ],
          }),
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

describe('createDaemonFilesSource tags', () => {
  it('merges the tag projection into entries and degrades to tagless on failure', async () => {
    const withTags = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.endsWith('/names'))
        return Promise.resolve(jsonResponse({ documents: {}, pinned: [] }))
      if (url.endsWith('/document-tags'))
        return Promise.resolve(
          jsonResponse({
            documents: [{ documentId: '01ARZ3NDEKTSV4RRFFQ69G5FAV', tags: ['release', 'q3'] }],
          }),
        )
      if (url.endsWith('/documents'))
        return Promise.resolve(
          jsonResponse({
            documents: [
              {
                path: 'tagged',
                id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
                updatedAt: '2026-08-01T00:00:00Z',
                kind: 'spatial',
              },
              {
                path: 'plain',
                id: '01BX5ZZKBKACTAV9WEVGEMMVRZ',
                updatedAt: '2026-08-01T00:00:00Z',
                kind: 'spatial',
              },
            ],
          }),
        )
      return Promise.resolve(jsonResponse({ message: 'unexpected' }, 500))
    }) as unknown as typeof globalThis.fetch

    const source = createDaemonFilesSource(withTags, BASE, 'ws')
    const entries = await source.listDocuments()
    expect(entries.find((e) => e.path === 'tagged')?.tags).toEqual(['release', 'q3'])
    expect(entries.find((e) => e.path === 'plain')?.tags).toBeUndefined()

    // A failed tag fetch never fails the LIST — the browser still opens.
    const tagsDown = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.endsWith('/names'))
        return Promise.resolve(jsonResponse({ documents: {}, pinned: [] }))
      if (url.endsWith('/document-tags')) return Promise.resolve(jsonResponse({ error: 'x' }, 500))
      if (url.endsWith('/documents'))
        return Promise.resolve(
          jsonResponse({
            documents: [
              {
                path: 'tagged',
                id: 'id-tagged',
                updatedAt: '2026-08-01T00:00:00Z',
                kind: 'spatial',
              },
            ],
          }),
        )
      return Promise.resolve(jsonResponse({ message: 'unexpected' }, 500))
    }) as unknown as typeof globalThis.fetch
    const degraded = await createDaemonFilesSource(tagsDown, BASE, 'ws').listDocuments()
    expect(degraded).toHaveLength(1)
    expect(degraded[0]?.tags).toBeUndefined()
  })
})

describe('createDaemonFilesSource searchDocuments', () => {
  function searchFetchStub(results: unknown[]): typeof globalThis.fetch {
    return vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.includes('/search')) return Promise.resolve(jsonResponse({ results }))
      return Promise.resolve(jsonResponse({ message: 'unexpected' }, 500))
    }) as unknown as typeof globalThis.fetch
  }

  it('carries the ranks through, so a semantic-only hit can be told apart', async () => {
    const source = createDaemonFilesSource(
      searchFetchStub([
        {
          documentId: '01M0P7D8CDZ5TP3C8ZYM8G275W',
          path: 'plans/roadmap',
          score: 2.5,
          contexts: ['…the quota exceeded error…'],
          lexicalRank: 1,
          semanticRank: 3,
        },
        // Found by meaning alone: its excerpt is the document's opening, and
        // there is no keyword in it to mark.
        {
          documentId: '01M0P7D8CDZ5TP3C8ZYM8G276X',
          path: 'notes/storage',
          score: 1.1,
          contexts: ['An opening line.'],
          semanticRank: 1,
        },
      ]),
      BASE,
      'ws',
    )

    const hits = await source.searchDocuments('quota', 20)
    expect(hits.map((hit) => hit.lexicalRank)).toEqual([1, undefined])
    expect(hits.map((hit) => hit.semanticRank)).toEqual([3, 1])
  })
})

// The half that was missing, and the reason it was missing: nothing here
// exercised `loadMarkdown` at all, so the daemon adapter answered with the
// route's `markdown` — the whole OKF projection — and every row thumbnail
// and preview drew the frontmatter block as prose. The browser adapter had
// always answered with the body (`local-files-source.test.ts`), which is
// exactly the shape a contract test cannot catch when only one side has one.
describe('createDaemonFilesSource loadMarkdown', () => {
  function okfFetchStub(payload: unknown): typeof globalThis.fetch {
    return vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.endsWith('/okf')) return Promise.resolve(jsonResponse(payload))
      return Promise.resolve(jsonResponse({ message: 'unexpected' }, 500))
    }) as unknown as typeof globalThis.fetch
  }

  const entry = {
    documentId: '01M0P7D8CDZ5TP3C8ZYM8G275W',
    path: 'notes/plan',
    kind: 'markdown' as const,
  }

  it('answers the body, not the OKF serialization that wraps it', async () => {
    const source = createDaemonFilesSource(
      okfFetchStub({
        markdown: '---\ntype: note\n---\n\n# Plan\n',
        body: '# Plan\n',
        frontmatter: { type: 'note' },
      }),
      BASE,
      'ws',
    )

    const loaded = await source.loadMarkdown(entry)
    expect(loaded.body).toBe('# Plan\n')
    expect(loaded.body).not.toContain('---')
  })

  it('carries the document’s facets back with it', async () => {
    const source = createDaemonFilesSource(
      okfFetchStub({
        markdown: '---\ntype: note\n---\n\n# Plan\n',
        body: '# Plan\n',
        frontmatter: {
          type: 'note',
          facets: { 'visual.symbol/v0': { kind: 'emoji', char: '📌' } },
        },
      }),
      BASE,
      'ws',
    )

    const loaded = await source.loadMarkdown(entry)
    expect(loaded.facets).toEqual({ 'visual.symbol/v0': { kind: 'emoji', char: '📌' } })
  })

  it('leaves the facets absent for a document that declares none', async () => {
    const source = createDaemonFilesSource(
      okfFetchStub({ markdown: '---\ntype: note\n---\n', body: '', frontmatter: { type: 'note' } }),
      BASE,
      'ws',
    )

    expect(await source.loadMarkdown(entry)).toEqual({ body: '' })
  })
})
