/**
 * The daemon-side copy, which is four requests in a fixed order — and the
 * order is the contract: the CREATE is the only place the copy's kind is set
 * (the snapshot write is a plain re-save that never touches a stored kind),
 * so a create that omits it files a markdown note as a canvas. That was a
 * real defect, closed at the one call site that existed; this suite
 * is what stops the second call site re-opening it.
 */
import { describe, expect, it } from 'vitest'
import { expectLoggedFailure } from '../test-utils/logged-failures.js'
import { duplicateDaemonDocument } from './duplicate-daemon-document.js'

interface Call {
  readonly method: string
  readonly url: string
  readonly body?: unknown
}

interface StubOptions {
  /** Answers the copy's snapshot write instead of the default success. */
  readonly update?: () => Response
  /** Answers the clean-up DELETE instead of the default success. */
  readonly remove?: () => Response
}

function stubDaemon(options: StubOptions = {}): {
  fetch: typeof globalThis.fetch
  calls: Call[]
} {
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
      // A real ULID: the v1 create response is checked against
      // `documentIdSchema`, so a placeholder id fails the parse and the
      // failure names schema validation rather than the fixture.
      return Response.json(
        { workspaceId: 'ws', documentId: '01J9ZC8XK4PQRS7TVWXY0ABCDE', path: body.path },
        { status: 201 },
      )
    }
    if (/\/name$/.test(url)) return Response.json({ documents: {}, pinned: [] })
    if (url.endsWith('/update') && options.update !== undefined) return options.update()
    if (method === 'DELETE' && options.remove !== undefined) return options.remove()
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

  it('takes the empty copy back down when the keeper refuses its contents', async () => {
    const { fetch, calls } = stubDaemon({
      update: () =>
        Response.json({ type: 'about:blank', title: 'Too large', status: 413 }, { status: 413 }),
    })

    const attempt = duplicateDaemonDocument({ ...REQUEST, fetch })

    await expect(attempt).rejects.toMatchObject({ status: 413 })
    const created = calls.find((call) => call.method === 'POST' && call.url.endsWith('/documents'))
    const createdPath = (created?.body as { path?: string } | undefined)?.path
    expect(createdPath).toBeDefined()
    const removed = calls.filter((call) => call.method === 'DELETE')
    expect(removed).toHaveLength(1)
    expect(removed[0]?.url).toMatch(new RegExp(`/documents/${createdPath}$`))
    // Nothing is named after the failure: the copy is gone, not half-made.
    expect(calls.some((call) => call.method === 'PUT')).toBe(false)
  })

  it('still reports the original failure when the clean-up fails too', async () => {
    const { fetch } = stubDaemon({
      update: () => new Response('down', { status: 503 }),
      remove: () => new Response('gone wrong', { status: 500 }),
    })

    const attempt = duplicateDaemonDocument({ ...REQUEST, fetch })

    // The write's failure, not the clean-up's: it is what the person asked about.
    await expect(attempt).rejects.toMatchObject({ status: 503 })
    await expectLoggedFailure('could not remove the copy')
  })
})

const REQUEST = {
  daemonBaseUrl: 'http://127.0.0.1:3099',
  workspaceId: 'ws',
  sourcePath: 'notes',
  kind: 'markdown',
  displayName: 'Notes',
  existingPaths: ['notes'],
  existingNames: ['Notes'],
} as const
