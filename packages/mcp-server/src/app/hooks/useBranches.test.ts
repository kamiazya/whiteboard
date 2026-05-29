import { renderHook, act } from '@testing-library/react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  buildBranchUrls,
  type BranchesState,
  parseBranchesResponse,
  branchesApi,
  useBranches,
} from './useBranches.js'

describe('buildBranchUrls', () => {
  it('encodes hierarchical slug with "/" safely', () => {
    const urls = buildBranchUrls('sess_1', '621/header')
    expect(urls.list).toBe('/api/workspaces/sess_1/canvases/621%2Fheader/branches')
    expect(urls.head).toBe('/api/workspaces/sess_1/canvases/621%2Fheader/head')
    expect(urls.deleteBranch('feature')).toBe(
      '/api/workspaces/sess_1/canvases/621%2Fheader/branches/feature',
    )
    expect(urls.merge('feature')).toBe(
      '/api/workspaces/sess_1/canvases/621%2Fheader/branches/feature/merge',
    )
  })
})

describe('parseBranchesResponse', () => {
  it('defaults to empty / main when response is malformed', () => {
    expect(parseBranchesResponse(null)).toEqual<BranchesState>({ branches: [], head: 'main' })
    expect(parseBranchesResponse({})).toEqual<BranchesState>({ branches: [], head: 'main' })
  })

  it('passes through well-formed responses', () => {
    expect(
      parseBranchesResponse({
        head: 'feature',
        branches: [
          { name: 'main', tipFrontiers: '', color: '#1971c2', createdAt: '2026-04-23T00:00:00Z' },
          {
            name: 'feature',
            tipFrontiers: 'AA==',
            color: '#9333ea',
            createdAt: '2026-04-23T01:00:00Z',
          },
        ],
      }),
    ).toEqual<BranchesState>({
      head: 'feature',
      branches: [
        { name: 'main', tipFrontiers: '', color: '#1971c2', createdAt: '2026-04-23T00:00:00Z' },
        {
          name: 'feature',
          tipFrontiers: 'AA==',
          color: '#9333ea',
          createdAt: '2026-04-23T01:00:00Z',
        },
      ],
    })
  })

  it('drops malformed branches entries and keeps valid ones', () => {
    const result = parseBranchesResponse({
      head: 'main',
      branches: [
        { name: 'main', tipFrontiers: '', color: '#1971c2', createdAt: '2026-04-23T00:00:00Z' },
        { name: 42 }, // malformed
        null,
      ],
    })
    expect(result.branches).toHaveLength(1)
    expect(result.branches[0]!.name).toBe('main')
  })

  it('falls back to "main" when head is an empty string', () => {
    expect(
      parseBranchesResponse({ head: '', branches: [] }),
    ).toEqual<BranchesState>({ branches: [], head: 'main' })
  })
})

describe('branchesApi', () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    vi.unstubAllGlobals()
    globalThis.fetch = originalFetch
  })

  it('list() GETs branches URL and parses response', async () => {
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () =>
      new Response(
        JSON.stringify({
          head: 'main',
          branches: [
            { name: 'main', tipFrontiers: '', color: '#1971c2', createdAt: '2026-04-23T00:00:00Z' },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    )
    vi.stubGlobal('fetch', fetchMock)
    const api = branchesApi('sess_1', 'canvas-a')
    const state = await api.list()
    expect(state.branches).toHaveLength(1)
    const firstCall = fetchMock.mock.calls[0]
    expect(firstCall?.[0]).toBe('/api/workspaces/sess_1/canvases/canvas-a/branches')
  })

  it('create() POSTs JSON body', async () => {
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () =>
      new Response(
        JSON.stringify({
          branch: {
            name: 'feature',
            tipFrontiers: '',
            color: '#9333ea',
            createdAt: '2026-04-23T01:00:00Z',
          },
        }),
        { status: 201, headers: { 'Content-Type': 'application/json' } },
      ),
    )
    vi.stubGlobal('fetch', fetchMock)
    const api = branchesApi('sess_1', 'canvas-a')
    const branch = await api.create({ name: 'feature' })
    expect(branch.name).toBe('feature')
    const firstCall2 = fetchMock.mock.calls[0]
    const init = firstCall2?.[1] as RequestInit | undefined
    expect(init?.method).toBe('POST')
    expect(init?.body).toBe(JSON.stringify({ name: 'feature' }))
  })

  it('create() rejects with response error payload on 4xx/5xx', async () => {
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () =>
      new Response(
        JSON.stringify({ error: 'branch_conflict', message: 'exists' }),
        { status: 409, headers: { 'Content-Type': 'application/json' } },
      ),
    )
    vi.stubGlobal('fetch', fetchMock)
    const api = branchesApi('sess_1', 'canvas-a')
    await expect(api.create({ name: 'feature' })).rejects.toMatchObject({
      status: 409,
      body: { error: 'branch_conflict' },
    })
  })

  it('setHead() PUTs { branch } and parses result', async () => {
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () =>
      new Response(JSON.stringify({ head: 'feature', previousHead: 'main' }), { status: 200 }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const api = branchesApi('sess_1', 'canvas-a')
    const result = await api.setHead('feature')
    expect(result).toEqual({ head: 'feature', previousHead: 'main' })
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/workspaces/sess_1/canvases/canvas-a/head')
    const headCall = fetchMock.mock.calls[0]
    const headInit = headCall?.[1] as RequestInit | undefined
    expect(headInit?.method).toBe('PUT')
  })

  it('remove() issues DELETE', async () => {
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () =>
      new Response(JSON.stringify({ ok: true, unmergedCommits: 0 }), { status: 200 }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const api = branchesApi('sess_1', 'canvas-a')
    const result = await api.remove('feature')
    expect(result.ok).toBe(true)
    const delCall = fetchMock.mock.calls[0]
    const delInit = delCall?.[1] as RequestInit | undefined
    expect(delInit?.method).toBe('DELETE')
  })

  it('merge() POSTs to merge URL with { into, dryRun }', async () => {
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () =>
      new Response(
        JSON.stringify({ badges: [], preview: { elementCount: 5 } }),
        { status: 200 },
      ),
    )
    vi.stubGlobal('fetch', fetchMock)
    const api = branchesApi('sess_1', 'canvas-a')
    const result = await api.merge('feature', { into: 'main', dryRun: true })
    expect(result.preview?.elementCount).toBe(5)
    const mergeCall = fetchMock.mock.calls[0]
    const url = mergeCall?.[0]
    const init2 = mergeCall?.[1] as RequestInit | undefined
    expect(url).toBe('/api/workspaces/sess_1/canvases/canvas-a/branches/feature/merge')
    expect(init2?.method).toBe('POST')
    expect(init2?.body).toBe(JSON.stringify({ into: 'main', dryRun: true }))
  })

  describe('contract_mismatch normalization: malformed 200 must not leak ZodError', () => {
    it.each([
      ['create', (api: ReturnType<typeof branchesApi>) => api.create({ name: 'x' }), JSON.stringify({ branch: null })],
      ['setHead', (api: ReturnType<typeof branchesApi>) => api.setHead('main'), JSON.stringify({ head: 42, previousHead: 'main' })],
      ['remove', (api: ReturnType<typeof branchesApi>) => api.remove('feature'), JSON.stringify({ ok: 'yes' })],
      ['rename', (api: ReturnType<typeof branchesApi>) => api.rename('old', 'new-name'), JSON.stringify({ branch: null, renamedVersionCount: 'x' })],
      ['getStats', (api: ReturnType<typeof branchesApi>) => api.getStats('feature'), JSON.stringify({ unmergedCommits: 'bad' })],
      ['merge', (api: ReturnType<typeof branchesApi>) => api.merge('feature', { into: 'main' }), JSON.stringify({ badges: 'not-an-array' })],
    ])(
      '%s() rejects with structured error (not ZodError) when server returns malformed 200',
      async (_label, call, malformedBody) => {
        vi.stubGlobal(
          'fetch',
          vi.fn(async () =>
            new Response(malformedBody, {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            }),
          ),
        )
        const api = branchesApi('sess_1', 'canvas-a')
        const err = await call(api).catch((e: unknown) => e)
        // ZodError extends Error; a structured BranchApiError is a plain object
        expect(err instanceof Error).toBe(false)
        expect(err).toMatchObject({ body: { error: 'contract_mismatch' } })
      },
    )
  })
})

describe('useBranches hook', () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    vi.unstubAllGlobals()
    globalThis.fetch = originalFetch
  })

  it('does not update state when the component has unmounted', async () => {
    let resolveAfterUnmount!: () => void
    const gate = new Promise<void>((r) => {
      resolveAfterUnmount = r
    })

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        await gate
        return new Response(
          JSON.stringify({ head: 'should-not-appear', branches: [] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }),
    )

    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const { unmount } = renderHook(() => useBranches('sess_1', 'canvas-a'))

    unmount()

    // Releasing the gate after unmount must not cause React state-update warnings.
    await act(async () => {
      resolveAfterUnmount()
      await new Promise((r) => setTimeout(r, 0))
    })

    const stateUpdateErrors = consoleErrorSpy.mock.calls.filter((args) =>
      typeof args[0] === 'string' && args[0].includes('unmounted'),
    )
    expect(stateUpdateErrors).toHaveLength(0)

    consoleErrorSpy.mockRestore()
  })

  it('discards in-flight canvas-a fetch when key changes to canvas-b before it resolves', async () => {
    let resolveCanvasA!: () => void
    const canvasAGate = new Promise<void>((r) => {
      resolveCanvasA = r
    })

    let callCount = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        callCount++
        if (callCount === 1) {
          await canvasAGate
          return new Response(
            JSON.stringify({ head: 'canvas-a-head', branches: [] }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          )
        }
        return new Response(
          JSON.stringify({ head: 'canvas-b-head', branches: [] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }),
    )

    const { result, rerender } = renderHook(
      ({ workspaceId, slug }: { workspaceId: string; slug: string }) =>
        useBranches(workspaceId, slug),
      { initialProps: { workspaceId: 'sess_1', slug: 'canvas-a' } },
    )

    // Switch to canvas-b while canvas-a fetch is still in-flight.
    await act(async () => {
      rerender({ workspaceId: 'sess_1', slug: 'canvas-b' })
      await new Promise((r) => setTimeout(r, 0))
    })

    expect(result.current.state.head).toBe('canvas-b-head')

    // Release canvas-a. Without a guard it would overwrite canvas-b state.
    await act(async () => {
      resolveCanvasA()
      await new Promise((r) => setTimeout(r, 0))
    })

    expect(result.current.state.head).toBe('canvas-b-head')
  })

  it('discards a stale list() that resolves after a newer refetch', async () => {
    let resolveStale!: () => void
    const staleGate = new Promise<void>((r) => {
      resolveStale = r
    })

    let callCount = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        callCount++
        if (callCount === 1) {
          await staleGate
          return new Response(
            JSON.stringify({
              head: 'stale-branch',
              branches: [
                {
                  name: 'stale-branch',
                  tipFrontiers: '',
                  color: '#aaaaaa',
                  createdAt: '2026-01-01T00:00:00Z',
                },
              ],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          )
        }
        return new Response(
          JSON.stringify({
            head: 'main',
            branches: [
              {
                name: 'main',
                tipFrontiers: '',
                color: '#bbbbbb',
                createdAt: '2026-01-01T00:00:00Z',
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }),
    )

    const { result } = renderHook(() => useBranches('sess_1', 'canvas-a'))

    // Initial mount triggered call #1 (held by staleGate).
    // Trigger call #2 which resolves immediately with fresh data.
    await act(async () => {
      await result.current.refetch()
    })

    expect(result.current.state.head).toBe('main')

    // Release the stale call. Without the sequence guard, state would revert to 'stale-branch'.
    await act(async () => {
      resolveStale()
      await new Promise((r) => setTimeout(r, 0))
    })

    expect(result.current.state.head).toBe('main')
  })
})
