import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  buildBranchUrls,
  type BranchesState,
  parseBranchesResponse,
  branchesApi,
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
})
