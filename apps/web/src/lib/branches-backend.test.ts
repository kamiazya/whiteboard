// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { branchlessBackendContract } from './branches-backend.contract.js'
import { createDaemonBranchesBackend } from './branches-backend.js'
import { BrowserBackend } from './browser-backend.js'
import { createBrowserBranchesBackend } from './browser-branches-backend.js'

/** Any document: this file never delivers a record, so nothing reads it. */
const TARGET = { documentId: '01JZZZZZZZZZZZZZZZZZZZZZZZ', path: 'doc', kind: 'spatial' } as const

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
  /**
   * A backend whose record has not been delivered — which is what a page has
   * before its document loads, and all this file needs. What the browser
   * keeper DOES with a delivered record is the contract's business, run
   * against real IndexedDB in `branches-backend.contract.browser.test.tsx`;
   * what is left here is the one property that is about the seam rather than
   * about branches.
   */
  const browserBackend = () => createBrowserBranchesBackend({ backend: new BrowserBackend(TARGET) })

  // The state the page is in for a markdown document, and before any document
  // loads. It must not be expressed as a `null` context value: that falls
  // through to the DAEMON backend and issues requests to a daemon that is not
  // there, which is what mounting a browser provider exists to stop.
  describe('with no record-holding backend', () => {
    branchlessBackendContract(() => createBrowserBranchesBackend({ backend: null }))

    it('makes no fetch while answering and refusing', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch')
      const backend = createBrowserBranchesBackend({ backend: null })
      await backend.list('ws', 'doc')
      await backend.setHead('ws', 'doc', 'x').catch(() => {})
      expect(fetchSpy).not.toHaveBeenCalled()
      fetchSpy.mockRestore()
    })
  })

  it('answers the resting state before its record arrives: main, and no request', async () => {
    expect(await browserBackend().list('ws', 'doc')).toEqual({
      branches: [{ name: 'main', tipFrontiers: '', color: '#1971c2', createdAt: '' }],
      head: 'main',
    })
  })

  it('makes no fetch at all — what it cannot do yet fails locally, not as a request', async () => {
    // The property this whole seam exists for, and the one the cases above
    // cannot make between them: `list` could answer from a request it made
    // and discarded, and a mutator could reject because a fetch rejected.
    // Either would reintroduce exactly the traffic the seam stops.
    //
    // It outlived the branchless backend it was written for. That backend is
    // gone — the browser keeper has branches now — and the assertion is the
    // same either way: this keeper reaches its own storage or nothing.
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const backend = browserBackend()
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
