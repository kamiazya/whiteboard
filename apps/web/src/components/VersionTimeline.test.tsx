import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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

// Cover the current VersionTimeline contract:
// - filter versions by the active branch (HEAD)
// - render the mini-graph lane for each row
// - place the "branched ->" label at the matching baseVersionId row
//
// Branch actions and save controls live in the header now, so VersionTimeline should not render tabs or save buttons.

type FetchArgs = [RequestInfo | URL, RequestInit?]

function mkBranchesResponse(): Response {
  return new Response(
    JSON.stringify({
      head: 'main',
      branches: [
        {
          name: 'main',
          tipFrontiers: '',
          color: '#1971c2',
          createdAt: '2026-04-23T00:00:00Z',
        },
        {
          name: 'feature',
          tipFrontiers: 'AA==',
          color: '#9333ea',
          baseVersionId: 'v-mid',
          createdAt: '2026-04-23T01:00:00Z',
        },
      ],
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )
}

function mkVersionsResponse(): Response {
  return new Response(
    JSON.stringify({
      versions: [
        {
          id: 'v-new',
          slug: 'canvas-a',
          createdAt: '2026-04-23T02:00:00Z',
          elementCount: 5,
          auto: true,
          hasThumbnail: false,
          branchName: 'main',
          operator: {
            kind: 'ai',
            peerId: 'peer-ai',
            displayName: 'Assistant',
          },
        },
        {
          id: 'v-mid',
          slug: 'canvas-a',
          createdAt: '2026-04-23T01:00:00Z',
          elementCount: 3,
          auto: true,
          hasThumbnail: false,
          branchName: 'main',
          operator: {
            kind: 'human',
            peerId: 'peer-human',
            displayName: 'Alice',
          },
        },
        {
          id: 'v-feat',
          slug: 'canvas-a',
          createdAt: '2026-04-23T01:30:00Z',
          elementCount: 4,
          auto: true,
          hasThumbnail: false,
          branchName: 'feature', // hidden from the main branch view
        },
      ],
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )
}

beforeEach(() => {
  mockLog.error.mockClear()
  mockLog.warn.mockClear()
  mockLog.info.mockClear()
  mockLog.debug.mockClear()
  const fetchMock = vi.fn<(...args: FetchArgs) => Promise<Response>>((input) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    if (url.includes('/branches')) return Promise.resolve(mkBranchesResponse())
    if (url.includes('/versions')) return Promise.resolve(mkVersionsResponse())
    return Promise.resolve(new Response('{}', { status: 200 }))
  })
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
  cleanup()
})

describe('VersionTimeline', () => {
  it('filters cards and mini-graph rows to the active branch', async () => {
    render(<VersionTimeline workspaceId="sess_1" slug="canvas-a" />)

    // Only v-new and v-mid should render; v-feat is filtered out with the feature branch.
    await waitFor(() => {
      expect(screen.getAllByText(/5 els|3 els/).length).toBeGreaterThanOrEqual(2)
    })
    expect(screen.queryByText(/4 els/)).toBeNull()

    // The mini-graph should render two SVG lanes for the two visible main-branch rows.
    await waitFor(() => {
      const svgs = document.querySelectorAll('svg[viewBox="0 0 24 36"]')
      expect(svgs.length).toBe(2)
    })

    // Branch tabs are gone, so no tab role should exist.
    expect(screen.queryAllByRole('tab').length).toBe(0)
  })

  it('renders the branchOut label on the row matching baseVersionId', async () => {
    render(<VersionTimeline workspaceId="sess_1" slug="canvas-a" />)
    // "branched -> feature" should appear on the v-mid row.
    await waitFor(() => {
      expect(screen.getByText(/branched → feature/)).toBeTruthy()
    })
  })

  it('renders operator affordances and keeps the lane color on the branch color', async () => {
    render(<VersionTimeline workspaceId="sess_1" slug="canvas-a" />)

    await waitFor(() => {
      expect(screen.getByText('🤖 Assistant')).toBeTruthy()
      expect(screen.getByText('👤 Alice')).toBeTruthy()
    })

    const circles = document.querySelectorAll('svg[viewBox="0 0 24 36"] circle')
    expect(circles).toHaveLength(2)
    expect(circles[0]?.getAttribute('fill')).toBe('#1971c2')
    expect(circles[0]?.getAttribute('stroke')).toBe('#1971c2')
    expect(circles[1]?.getAttribute('fill')).toBe('#1971c2')
    expect(circles[1]?.getAttribute('stroke')).toBe('#1971c2')
    // Every row shown here is on the active HEAD branch (versions are
    // pre-filtered to head before reaching the mini-graph), so the dot is
    // always solid — never the hollow "other branch" ring.
    expect(circles[0]?.getAttribute('stroke-width')).toBe('0')
    expect(circles[1]?.getAttribute('stroke-width')).toBe('0')
  })

  it('legacy row without operator renders system fallback', async () => {
    vi.unstubAllGlobals()
    const fetchMock = vi.fn<(...args: FetchArgs) => Promise<Response>>((input) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes('/branches')) return Promise.resolve(mkBranchesResponse())
      if (url.includes('/versions')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              versions: [
                {
                  id: 'v-legacy',
                  slug: 'canvas-a',
                  createdAt: '2026-04-23T02:00:00Z',
                  elementCount: 2,
                  auto: true,
                  hasThumbnail: false,
                  branchName: 'main',
                },
              ],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
        )
      }
      return Promise.resolve(new Response('{}', { status: 200 }))
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<VersionTimeline workspaceId="sess_1" slug="canvas-a" />)
    await waitFor(() => {
      expect(screen.getByText('⚙ System')).toBeTruthy()
    })
  })

  it('renders the empty state when the active branch has no versions', async () => {
    vi.unstubAllGlobals()
    const fetchMock = vi.fn<(...args: FetchArgs) => Promise<Response>>((input) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes('/branches')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              head: 'feature',
              branches: [
                {
                  name: 'main',
                  tipFrontiers: '',
                  color: '#1971c2',
                  createdAt: '2026-04-23T00:00:00Z',
                },
                {
                  name: 'feature',
                  tipFrontiers: '',
                  color: '#9333ea',
                  createdAt: '2026-04-23T01:00:00Z',
                },
              ],
            }),
            { status: 200 },
          ),
        )
      }
      if (url.includes('/versions')) {
        return Promise.resolve(new Response(JSON.stringify({ versions: [] }), { status: 200 }))
      }
      return Promise.resolve(new Response('{}', { status: 200 }))
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<VersionTimeline workspaceId="sess_1" slug="canvas-a" />)
    await waitFor(() => {
      expect(screen.getByText(/No versions on «feature» yet/i)).toBeTruthy()
    })
  })

  it('scroll container can shrink inside the fixed-height history popover', async () => {
    const { container } = render(<VersionTimeline workspaceId="sess_1" slug="canvas-a" />)

    await waitFor(() => {
      expect(screen.getByText('🤖 Assistant')).toBeTruthy()
    })

    expect(container.firstElementChild?.className).toContain('min-h-0')
    expect(container.querySelector('[data-slot="scroll-area"]')?.className ?? '').toContain(
      'min-h-0',
    )
  })

  it('calls onRestored and refreshes after a successful restore', async () => {
    const onRestored = vi.fn()
    const restoreCalls: string[] = []
    vi.unstubAllGlobals()
    const fetchMock = vi.fn<(...args: FetchArgs) => Promise<Response>>((input) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes('/restore')) {
        restoreCalls.push(url)
        return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }))
      }
      if (url.includes('/branches')) return Promise.resolve(mkBranchesResponse())
      if (url.includes('/versions')) return Promise.resolve(mkVersionsResponse())
      return Promise.resolve(new Response('{}', { status: 200 }))
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<VersionTimeline workspaceId="sess_1" slug="canvas-a" onRestored={onRestored} />)

    const row = await screen.findByText('🤖 Assistant')
    fireEvent.click(row.closest('button')!)
    await waitFor(() => {
      expect(screen.getByText('Restore this version?')).toBeTruthy()
    })

    const restoreButton = screen.getByRole('button', { name: 'Restore' })
    fireEvent.click(restoreButton)

    await waitFor(() => {
      expect(restoreCalls.some((u) => u.includes('/versions/v-new/restore'))).toBe(true)
    })
    await waitFor(() => {
      expect(onRestored).toHaveBeenCalledTimes(1)
    })
    await waitFor(() => {
      expect(screen.queryByText('Restore this version?')).toBeNull()
    })
  })

  it('keeps the dialog open and does not fire onRestored when the restore request fails', async () => {
    const onRestored = vi.fn()
    vi.unstubAllGlobals()
    const fetchMock = vi.fn<(...args: FetchArgs) => Promise<Response>>((input) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes('/restore')) {
        return Promise.resolve(
          new Response(JSON.stringify({ error: 'not_found' }), { status: 404 }),
        )
      }
      if (url.includes('/branches')) return Promise.resolve(mkBranchesResponse())
      if (url.includes('/versions')) return Promise.resolve(mkVersionsResponse())
      return Promise.resolve(new Response('{}', { status: 200 }))
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<VersionTimeline workspaceId="sess_1" slug="canvas-a" onRestored={onRestored} />)

    const row = await screen.findByText('🤖 Assistant')
    fireEvent.click(row.closest('button')!)
    await waitFor(() => {
      expect(screen.getByText('Restore this version?')).toBeTruthy()
    })

    const restoreButton = screen.getByRole('button', { name: 'Restore' })
    fireEvent.click(restoreButton)

    await waitFor(() => {
      expect(screen.getByText(/restore failed/i)).toBeTruthy()
    })
    expect(onRestored).not.toHaveBeenCalled()
    expect(screen.getByText('Restore this version?')).toBeTruthy()
  })

  it('keeps the dialog open with an error when the restore request throws (network failure)', async () => {
    const onRestored = vi.fn()
    vi.unstubAllGlobals()
    const fetchMock = vi.fn<(...args: FetchArgs) => Promise<Response>>((input) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes('/restore')) return Promise.reject(new TypeError('Failed to fetch'))
      if (url.includes('/branches')) return Promise.resolve(mkBranchesResponse())
      if (url.includes('/versions')) return Promise.resolve(mkVersionsResponse())
      return Promise.resolve(new Response('{}', { status: 200 }))
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<VersionTimeline workspaceId="sess_1" slug="canvas-a" onRestored={onRestored} />)

    const row = await screen.findByText('🤖 Assistant')
    fireEvent.click(row.closest('button')!)
    await waitFor(() => {
      expect(screen.getByText('Restore this version?')).toBeTruthy()
    })

    const restoreButton = screen.getByRole('button', { name: 'Restore' })
    fireEvent.click(restoreButton)

    await waitFor(() => {
      expect(screen.getByText(/restore failed/i)).toBeTruthy()
    })
    expect(onRestored).not.toHaveBeenCalled()
    expect(screen.getByText('Restore this version?')).toBeTruthy()
    expect(mockLog.error).toHaveBeenCalledWith('restore request threw', expect.any(TypeError))
  })

  it('disables the Restore action while a restore is in flight so repeat activation cannot double-submit', async () => {
    const onRestored = vi.fn()
    const restoreCalls: string[] = []
    vi.unstubAllGlobals()
    let resolveRestore: (() => void) | undefined
    const fetchMock = vi.fn<(...args: FetchArgs) => Promise<Response>>((input) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes('/restore')) {
        restoreCalls.push(url)
        return new Promise<Response>((resolve) => {
          resolveRestore = () =>
            resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }))
        })
      }
      if (url.includes('/branches')) return Promise.resolve(mkBranchesResponse())
      if (url.includes('/versions')) return Promise.resolve(mkVersionsResponse())
      return Promise.resolve(new Response('{}', { status: 200 }))
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<VersionTimeline workspaceId="sess_1" slug="canvas-a" onRestored={onRestored} />)

    const row = await screen.findByText('🤖 Assistant')
    fireEvent.click(row.closest('button')!)
    await waitFor(() => {
      expect(screen.getByText('Restore this version?')).toBeTruthy()
    })

    const restoreButton = screen.getByRole('button', { name: 'Restore' })
    fireEvent.click(restoreButton)
    // Repeat activation while the first request is still in flight.
    fireEvent.click(restoreButton)
    fireEvent.click(restoreButton)

    await waitFor(() => {
      expect(restoreCalls.length).toBe(1)
    })
    expect((screen.getByRole('button', { name: 'Restoring…' }) as HTMLButtonElement).disabled).toBe(
      true,
    )

    resolveRestore?.()
    await waitFor(() => {
      expect(onRestored).toHaveBeenCalledTimes(1)
    })
  })

  it('ignores Cancel and keeps the pending version locked while a restore is in flight', async () => {
    const onRestored = vi.fn()
    const restoreCalls: string[] = []
    vi.unstubAllGlobals()
    let resolveRestore: (() => void) | undefined
    const fetchMock = vi.fn<(...args: FetchArgs) => Promise<Response>>((input) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes('/restore')) {
        restoreCalls.push(url)
        return new Promise<Response>((resolve) => {
          resolveRestore = () =>
            resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }))
        })
      }
      if (url.includes('/branches')) return Promise.resolve(mkBranchesResponse())
      if (url.includes('/versions')) return Promise.resolve(mkVersionsResponse())
      return Promise.resolve(new Response('{}', { status: 200 }))
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<VersionTimeline workspaceId="sess_1" slug="canvas-a" onRestored={onRestored} />)

    const row = await screen.findByText('🤖 Assistant')
    fireEvent.click(row.closest('button')!)
    await waitFor(() => {
      expect(screen.getByText('Restore this version?')).toBeTruthy()
    })

    fireEvent.click(screen.getByRole('button', { name: 'Restore' }))
    await waitFor(() => {
      expect(restoreCalls.length).toBe(1)
    })

    // Cancel must not close the dialog nor unlock a second /restore submission
    // while the first request is still in flight.
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.getByText('Restore this version?')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Restoring…' })).toBeTruthy()

    resolveRestore?.()
    await waitFor(() => {
      expect(onRestored).toHaveBeenCalledTimes(1)
    })
    expect(restoreCalls).toHaveLength(1)
    await waitFor(() => {
      expect(screen.queryByText('Restore this version?')).toBeNull()
    })
  })
})

describe('VersionTimeline HEAD polling', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    cleanup()
  })

  it('refetches branches on the same 15s poll as versions, picking up an external HEAD change', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    let head = 'main'
    const fetchMock = vi.fn<(...args: FetchArgs) => Promise<Response>>((input) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes('/branches')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              head,
              branches: [
                {
                  name: 'main',
                  tipFrontiers: '',
                  color: '#1971c2',
                  createdAt: '2026-04-23T00:00:00Z',
                },
                {
                  name: 'feature',
                  tipFrontiers: '',
                  color: '#9333ea',
                  createdAt: '2026-04-23T01:00:00Z',
                },
              ],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
        )
      }
      if (url.includes('/versions')) return Promise.resolve(mkVersionsResponse())
      return Promise.resolve(new Response('{}', { status: 200 }))
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<VersionTimeline workspaceId="sess_1" slug="canvas-a" />)
    await waitFor(() => {
      expect(screen.getByText(/5 els/)).toBeTruthy()
    })

    // An external HEAD change (e.g. another peer switching branches) is not
    // pushed to this component; simulate the server having moved on.
    head = 'feature'
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000)
    })

    // mkVersionsResponse's v-feat row (branchName: 'feature', 4 elements) is
    // the one version on the new head; the two main-branch rows must drop
    // out of the filtered view.
    await waitFor(() => {
      expect(screen.getByText(/4 els/)).toBeTruthy()
    })
    expect(screen.queryByText(/5 els/)).toBeNull()
    expect(screen.queryByText(/3 els/)).toBeNull()
  })
})

describe('formatRelative display branches (via rendered version rows)', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  function mkSingleVersionResponse(createdAt: string): Response {
    return new Response(
      JSON.stringify({
        versions: [
          {
            id: 'v-1',
            slug: 'canvas-a',
            createdAt,
            elementCount: 1,
            auto: true,
            hasThumbnail: false,
            branchName: 'main',
          },
        ],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )
  }

  function stubFetchWithVersionAt(createdAt: string) {
    const fetchMock = vi.fn<(...args: FetchArgs) => Promise<Response>>((input) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes('/branches')) return Promise.resolve(mkBranchesResponse())
      if (url.includes('/versions')) return Promise.resolve(mkSingleVersionResponse(createdAt))
      return Promise.resolve(new Response('{}', { status: 200 }))
    })
    vi.stubGlobal('fetch', fetchMock)
  }

  it('renders seconds-ago for a timestamp under a minute old', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const now = new Date('2026-04-23T02:00:00Z')
    vi.setSystemTime(now)
    stubFetchWithVersionAt(new Date(now.getTime() - 30_000).toISOString())

    render(<VersionTimeline workspaceId="sess_1" slug="canvas-a" />)
    await waitFor(() => {
      expect(screen.getByText(/30s ago/)).toBeTruthy()
    })
  })

  it('renders minutes-ago for a timestamp under an hour old', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const now = new Date('2026-04-23T02:00:00Z')
    vi.setSystemTime(now)
    stubFetchWithVersionAt(new Date(now.getTime() - 5 * 60_000).toISOString())

    render(<VersionTimeline workspaceId="sess_1" slug="canvas-a" />)
    await waitFor(() => {
      expect(screen.getByText(/5m ago/)).toBeTruthy()
    })
  })

  it('renders hours-ago for a timestamp under a day old', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const now = new Date('2026-04-23T02:00:00Z')
    vi.setSystemTime(now)
    stubFetchWithVersionAt(new Date(now.getTime() - 3 * 3600_000).toISOString())

    render(<VersionTimeline workspaceId="sess_1" slug="canvas-a" />)
    await waitFor(() => {
      expect(screen.getByText(/3h ago/)).toBeTruthy()
    })
  })

  it('renders an absolute date/time for a timestamp a day or more old', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const now = new Date('2026-04-23T02:00:00Z')
    vi.setSystemTime(now)
    stubFetchWithVersionAt(new Date(now.getTime() - 2 * 86_400_000).toISOString())

    render(<VersionTimeline workspaceId="sess_1" slug="canvas-a" />)
    await waitFor(() => {
      // 2026-04-21 00:00 local time rendered as M/D HH:MM.
      expect(screen.getByText(/4\/21 \d{2}:\d{2}/)).toBeTruthy()
    })
  })

  it('falls back to the raw ISO string for an invalid createdAt', async () => {
    stubFetchWithVersionAt('not-a-real-date')

    render(<VersionTimeline workspaceId="sess_1" slug="canvas-a" />)
    await waitFor(() => {
      expect(screen.getByText(/not-a-real-date/)).toBeTruthy()
    })
  })
})

describe('VersionTimeline error handling and canvas-switch reset', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    cleanup()
  })

  it('does not reject or crash when the versions fetch throws a network error', async () => {
    const fetchMock = vi.fn<(...args: FetchArgs) => Promise<Response>>((input) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes('/branches')) return Promise.resolve(mkBranchesResponse())
      if (url.includes('/versions')) return Promise.reject(new TypeError('network down'))
      return Promise.resolve(new Response('{}', { status: 200 }))
    })
    vi.stubGlobal('fetch', fetchMock)
    mockLog.error.mockClear()

    render(<VersionTimeline workspaceId="sess_1" slug="canvas-a" />)

    await waitFor(() => {
      expect(mockLog.error).toHaveBeenCalledWith('versions request threw', expect.any(TypeError))
    })
    // Loading settles instead of spinning forever, and no unhandled rejection
    // propagates out of the effect (a rejection here would fail the test run).
    await waitFor(() => {
      expect(screen.getByText(/No versions on/)).toBeTruthy()
    })
  })

  it('logs and leaves the list empty when the versions response is not ok', async () => {
    const fetchMock = vi.fn<(...args: FetchArgs) => Promise<Response>>((input) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes('/branches')) return Promise.resolve(mkBranchesResponse())
      if (url.includes('/versions')) return Promise.resolve(new Response('{}', { status: 500 }))
      return Promise.resolve(new Response('{}', { status: 200 }))
    })
    vi.stubGlobal('fetch', fetchMock)
    mockLog.error.mockClear()

    render(<VersionTimeline workspaceId="sess_1" slug="canvas-a" />)

    await waitFor(() => {
      expect(mockLog.error).toHaveBeenCalledWith(
        'versions request failed',
        expect.objectContaining({ status: 500 }),
      )
    })
    expect(screen.getByText(/No versions on/)).toBeTruthy()
  })

  it('clears the previous canvas versions immediately when workspaceId/slug changes', async () => {
    // canvas-new's /versions request hangs for the rest of the test, so any
    // row rendered after the switch can only be the stale canvas-old data —
    // unless the reset-on-change effect cleared it.
    let versionsCallCount = 0
    const fetchMock = vi.fn<(...args: FetchArgs) => Promise<Response>>((input) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes('/branches')) return Promise.resolve(mkBranchesResponse())
      if (url.includes('/versions')) {
        versionsCallCount += 1
        if (versionsCallCount === 1) return Promise.resolve(mkVersionsResponse())
        return new Promise<Response>(() => {
          /* canvas-new's request never resolves in this test */
        })
      }
      return Promise.resolve(new Response('{}', { status: 200 }))
    })
    vi.stubGlobal('fetch', fetchMock)

    const { rerender } = render(<VersionTimeline workspaceId="sess_1" slug="canvas-old" />)

    // Load canvas-old's versions first so there is stale data to leak.
    await waitFor(() => {
      expect(screen.getByText('🤖 Assistant')).toBeTruthy()
    })

    // Switching to canvas-new (same component instance, no remount key) must
    // clear that stale data immediately, even though canvas-new's own
    // /versions request never resolves here.
    rerender(<VersionTimeline workspaceId="sess_1" slug="canvas-new" />)
    await waitFor(() => {
      expect(screen.queryByText('🤖 Assistant')).toBeNull()
    })
  })
})
