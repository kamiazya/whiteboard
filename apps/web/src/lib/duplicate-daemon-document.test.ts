/**
 * The daemon-side copy, which is four requests in a fixed order — and the
 * order is the contract: the CREATE is the only place the copy's kind is set
 * (the snapshot write is a plain re-save that never touches a stored kind),
 * so a create that omits it files a markdown note as a canvas. That was a
 * real defect, closed by #1767 at the one call site that existed; this suite
 * is what stops the second call site re-opening it.
 */
import { describe, expect, it } from 'vitest'
import { duplicateDaemonDocument } from './duplicate-daemon-document.js'

interface Call {
  readonly method: string
  readonly url: string
  readonly body?: unknown
}

function stubDaemon(): { fetch: typeof globalThis.fetch; calls: Call[] } {
  const calls: Call[] = []
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()
    const method = init?.method ?? 'GET'
    const isBytes = init?.body instanceof Uint8Array
    calls.push({
      method,
      url,
      ...(init?.body === undefined
        ? {}
        : { body: isBytes ? init.body : JSON.parse(String(init.body)) }),
    })
    if (/\/documents\/[^/]+\/snapshot$/.test(url) && method === 'GET') {
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { 'Content-Type': 'application/octet-stream' },
      })
    }
    if (url.endsWith('/documents') && method === 'POST') {
      const body = JSON.parse(String(init?.body)) as { path: string }
      // A real ULID: the v1 create response is `.strict()` over
      // `documentIdSchema`, so a placeholder id fails the parse and the
      // failure names schema validation rather than the fixture.
      return Response.json(
        { workspaceId: 'ws', documentId: '01J9ZC8XK4PQRS7TVWXY0ABCDE', path: body.path },
        { status: 201 },
      )
    }
    if (/\/name$/.test(url)) return Response.json({ documents: {}, pinned: [] })
    return Response.json({ ok: true })
  }) as typeof globalThis.fetch
  return { fetch, calls }
}

describe('duplicating a daemon-kept document', () => {
  it('creates the copy AS THE SOURCE KIND, then writes the bytes, then names it', async () => {
    const { fetch, calls } = stubDaemon()

    const copy = await duplicateDaemonDocument({
      fetch,
      daemonBaseUrl: 'http://127.0.0.1:3099',
      workspaceId: 'ws',
      sourcePath: 'notes',
      kind: 'markdown',
      displayName: 'Notes',
      existingPaths: ['notes'],
      existingNames: ['Notes'],
    })

    expect(copy.path).not.toBe('notes')
    const create = calls.find((call) => call.method === 'POST')
    expect(create?.body).toMatchObject({ path: copy.path, kind: 'markdown' })

    // The ORDER, not merely the presence: a rename before the write would be
    // applied to a document the write then replaces, and a write before the
    // create has nothing to write to.
    const order = calls.map((call) => `${call.method} ${call.url.replace(/^.*\/api/, '')}`)
    expect(order[0]).toMatch(/^GET .*notes\/snapshot$/)
    expect(order[1]).toMatch(/^POST .*\/documents$/)
    expect(order[2]).toMatch(/^POST .*update$/)
    expect(order.at(-1)).toMatch(/^PUT .*name$/)
  })

  it('derives a path and a name that do not collide with what the workspace holds', async () => {
    const { fetch, calls } = stubDaemon()

    const copy = await duplicateDaemonDocument({
      fetch,
      daemonBaseUrl: 'http://127.0.0.1:3099',
      workspaceId: 'ws',
      sourcePath: 'notes',
      kind: 'markdown',
      displayName: 'Notes',
      // The obvious derivations are already taken, so a helper that appends
      // once and stops would answer one of these.
      existingPaths: ['notes', 'notes-copy'],
      existingNames: ['Notes', 'Notes (copy)'],
    })

    expect(['notes', 'notes-copy']).not.toContain(copy.path)
    const named = calls.at(-1)?.body as { name?: string } | undefined
    expect(named?.name).toBeDefined()
    expect(['Notes', 'Notes (copy)']).not.toContain(named?.name)
  })
})
