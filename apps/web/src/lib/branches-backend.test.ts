// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import {
  BranchesUnsupportedError,
  createBrowserBranchesBackend,
  createDaemonBranchesBackend,
} from './branches-backend.js'

/**
 * The seam exists for ONE reason, and it is a default rather than a feature.
 *
 * Branches reached the daemon by building `/api/workspaces/...` as a template
 * string inside a hook and calling `apiFetch`. Three consumers used it and one
 * passed the `enabled` flag that stops the browser keeper fetching; the other
 * two were saved by where they happen to be mounted, not by anything a
 * compiler or a test could see. The flag also defaults to ON, so a fourth
 * consumer that forgets falls toward issuing the request.
 *
 * With a keeper-shaped backend the browser's answer IS the answer — there is
 * no flag to forget, and forgetting yields the resting state rather than a
 * request to a daemon that is not there.
 */
describe('the browser keeper answers for branches instead of reaching for a daemon', () => {
  it('answers the resting state: one lane, main, no request', async () => {
    const backend = createBrowserBranchesBackend()
    expect(await backend.list('ws', 'doc')).toEqual({ branches: [], head: 'main' })
  })

  it('refuses every mutator with a typed error rather than a request', async () => {
    const backend = createBrowserBranchesBackend()
    // Named one at a time rather than looped, so a method ADDED to the seam
    // and left unimplemented here is a type error rather than a silent gap —
    // a loop over Object.keys would pass over whatever it happened to find.
    await expect(backend.create('ws', 'doc', { name: 'x' })).rejects.toBeInstanceOf(
      BranchesUnsupportedError,
    )
    await expect(backend.remove('ws', 'doc', 'x')).rejects.toBeInstanceOf(BranchesUnsupportedError)
    await expect(backend.rename('ws', 'doc', 'x', 'y')).rejects.toBeInstanceOf(
      BranchesUnsupportedError,
    )
    await expect(backend.setHead('ws', 'doc', 'x')).rejects.toBeInstanceOf(BranchesUnsupportedError)
    await expect(backend.getStats('ws', 'doc', 'x')).rejects.toBeInstanceOf(
      BranchesUnsupportedError,
    )
    await expect(backend.merge('ws', 'doc', 'x', { into: 'main' })).rejects.toBeInstanceOf(
      BranchesUnsupportedError,
    )
  })

  it('makes no fetch at all — the refusal is local, not a request that failed', async () => {
    // The assertion the two above cannot make between them: `list` could
    // answer the resting state from a request it made and discarded, and a
    // mutator could reject because a fetch rejected. Either would reintroduce
    // exactly the traffic this seam exists to stop.
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const backend = createBrowserBranchesBackend()
    await backend.list('ws', 'doc')
    await backend.setHead('ws', 'doc', 'x').catch(() => {})
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })
})

describe('the daemon keeper still speaks its routes', () => {
  it('lists over the documents route, and salvages a response the envelope rejects', async () => {
    // The per-item salvage is pre-existing behaviour worth naming here: one
    // rogue row must not cost the picker every valid branch beside it.
    const fetchFn = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            head: 'main',
            branches: [
              // A row that really satisfies `branchMetaSchema` — the point of
              // the case is that it SURVIVES beside a broken one, so a fixture
              // the schema would reject anyway proves nothing. The first
              // version of this test used one, and it passed the salvage while
              // asserting nothing about it.
              {
                name: 'main',
                tipFrontiers: 'abc',
                color: '#888888',
                createdAt: '2026-05-04T00:00:00.000Z',
              },
              { nonsense: true },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    ) as unknown as typeof fetch

    const state = await createDaemonBranchesBackend(fetchFn).list('ws', 'a/b')
    expect(state.head).toBe('main')
    expect(state.branches.map((b) => b.name)).toEqual(['main'])
  })

  it('encodes a path containing a slash into one segment', async () => {
    const calls: string[] = []
    const fetchFn = vi.fn(async (url: string) => {
      calls.push(String(url))
      return new Response(JSON.stringify({ head: 'main', branches: [] }), { status: 200 })
    }) as unknown as typeof fetch

    await createDaemonBranchesBackend(fetchFn).list('ws', 'folder/doc')
    expect(calls[0]).toContain('folder%2Fdoc')
  })
})
