// miniGraphRows/miniGraphById were rebuilt in the component body on every
// render, even for state churn unrelated to head/branches/versions
// (previewing, isRestoring, restoreError, stale, loading) — buildMiniGraph
// is O(versions) and every keystroke of unrelated UI state paid for it again.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import VersionTimeline from './VersionTimeline.js'

const mockLog = vi.hoisted(() => ({
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
}))

vi.mock('@/lib/app-logger', () => ({
  getAppLogger: () => mockLog,
}))

const buildMiniGraphSpy = vi.fn()

vi.mock('@/lib/mini-graph', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/mini-graph')>()
  return {
    ...actual,
    buildMiniGraph: (...args: Parameters<typeof actual.buildMiniGraph>) => {
      buildMiniGraphSpy(...args)
      return actual.buildMiniGraph(...args)
    },
  }
})

type FetchArgs = [RequestInfo | URL, RequestInit?]

function mkBranchesResponse(): Response {
  return new Response(
    JSON.stringify({
      head: 'main',
      branches: [
        { name: 'main', tipFrontiers: '', color: '#1971c2', createdAt: '2026-04-23T00:00:00Z' },
      ],
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )
}

function mkVersionDocumentResponse(): Response {
  return new Response(JSON.stringify({ kind: 'spatial', canvas: { nodes: [], edges: [] } }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

function mkVersionsResponse(): Response {
  return new Response(
    JSON.stringify({
      versions: [
        {
          id: 'v-new',
          path: 'canvas-a',
          createdAt: '2026-04-23T02:00:00Z',
          elementCount: 5,
          auto: true,
          hasThumbnail: false,
          branchName: 'main',
        },
      ],
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )
}

beforeEach(() => {
  buildMiniGraphSpy.mockClear()
  const fetchMock = vi.fn<(...args: FetchArgs) => Promise<Response>>((input) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    if (url.includes('/branches')) return Promise.resolve(mkBranchesResponse())
    if (url.endsWith('/document')) return Promise.resolve(mkVersionDocumentResponse())
    if (url.includes('/versions')) return Promise.resolve(mkVersionsResponse())
    return Promise.resolve(new Response('{}', { status: 200 }))
  })
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
  cleanup()
})

it('does not recompute the mini-graph when only preview/restore state changes', async () => {
  render(<VersionTimeline workspaceId="sess_1" path="canvas-a" />)
  const row = await screen.findByTestId('version-row')
  const baseline = buildMiniGraphSpy.mock.calls.length
  expect(baseline).toBeGreaterThanOrEqual(1)

  // Opening a preview changes `previewing`/`previewPast` — none of which
  // are inputs to the mini-graph (head, branches, versions). The row's
  // interactive surface is the <button> RowShell renders INSIDE the
  // testid'd wrapper div, not the wrapper itself — a click on the wrapper
  // does not bubble down into it.
  const activateButton = row.querySelector('button')
  expect(activateButton).not.toBeNull()
  await act(async () => {
    fireEvent.click(activateButton as HTMLButtonElement)
  })

  expect(buildMiniGraphSpy).toHaveBeenCalledTimes(baseline)
})
