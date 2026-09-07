import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DaemonApiContext } from '../contexts/DaemonApiContext.js'
import { createDaemonFetch } from '../lib/daemon-api-client.js'
import VersionTimeline, { type VersionPreviewSession } from './VersionTimeline.js'

const mockLog = vi.hoisted(() => ({
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
}))

vi.mock('../lib/app-logger.js', () => ({
  getAppLogger: () => mockLog,
}))

// Cover the current VersionTimeline contract:
// - filter versions by the active branch (HEAD)
// - render the mini-graph lane for each row
// - place the "variation ->" label at the matching baseVersionId row
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

// The preview read. Registered before any generic `/versions` branch in each
// mock below: a list payload answered here would fail the document schema and
// the row would report "could not be read" instead of opening.
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
          operator: {
            kind: 'ai',
            peerId: 'peer-ai',
            displayName: 'Assistant',
          },
        },
        {
          id: 'v-mid',
          path: 'canvas-a',
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
          path: 'canvas-a',
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

/**
 * The LOOKING-AT session the panel publishes.
 *
 * These tests used to click the panel's own preview bar. The bar moved onto
 * the document's chrome — the thing that actually changed — so what the
 * panel offers is now this object, and driving it here is driving the real
 * contract rather than a second copy of the buttons. What the CHROME does
 * with it is the top bar's own test and the page flow's.
 */
function capturePreview() {
  let latest: VersionPreviewSession | null = null
  const onPreview = (session: VersionPreviewSession | null) => {
    latest = session
  }
  return {
    onPreview,
    get current(): VersionPreviewSession | null {
      return latest
    },
    /** The session, or a failure naming what was expected instead of a null deref. */
    require(): VersionPreviewSession {
      if (latest === null) throw new Error('no version is being looked at')
      return latest
    },
  }
}

describe('VersionTimeline', () => {
  it('closes an open restore dialog when the canvas changes', async () => {
    const preview = capturePreview()
    // Switching documents with the dialog open must not leave the previous
    // canvas's version staged — confirming would POST that version id to the
    // NEW canvas's restore endpoint.
    const { rerender } = render(
      <VersionTimeline workspaceId="sess_1" path="canvas-a" onPreview={preview.onPreview} />,
    )

    const row = await screen.findByText(/Assistant/)
    fireEvent.click(row.closest('button')!)
    await waitFor(() => {
      expect(preview.current).not.toBeNull()
    })

    rerender(<VersionTimeline workspaceId="sess_1" path="canvas-b" onPreview={preview.onPreview} />)
    await waitFor(() => {
      expect(preview.current).toBeNull()
    })
  })

  it('refetches versions when refreshSignal changes (e.g. after a manual save)', async () => {
    const preview = capturePreview()
    const { rerender } = render(
      <VersionTimeline workspaceId="sess_1" path="canvas-a" refreshSignal={0} />,
    )
    await screen.findByText(/Assistant/)

    const fetchMock = vi.mocked(globalThis.fetch)
    const versionsCallCountBefore = fetchMock.mock.calls.filter(([reqInput]) =>
      String(reqInput).includes('/versions'),
    ).length

    rerender(
      <VersionTimeline
        workspaceId="sess_1"
        path="canvas-a"
        refreshSignal={1}
        onPreview={preview.onPreview}
      />,
    )

    await waitFor(() => {
      const versionsCallCountAfter = fetchMock.mock.calls.filter(([reqInput]) =>
        String(reqInput).includes('/versions'),
      ).length
      expect(versionsCallCountAfter).toBeGreaterThan(versionsCallCountBefore)
    })
  })

  it('does not refetch when re-rendered with an unchanged refreshSignal', async () => {
    const preview = capturePreview()
    const { rerender } = render(
      <VersionTimeline workspaceId="sess_1" path="canvas-a" refreshSignal={0} />,
    )
    await screen.findByText(/Assistant/)

    const fetchMock = vi.mocked(globalThis.fetch)
    const versionsCallCountBefore = fetchMock.mock.calls.filter(([reqInput]) =>
      String(reqInput).includes('/versions'),
    ).length

    rerender(
      <VersionTimeline
        workspaceId="sess_1"
        path="canvas-a"
        refreshSignal={0}
        onPreview={preview.onPreview}
      />,
    )

    const versionsCallCountAfter = fetchMock.mock.calls.filter(([reqInput]) =>
      String(reqInput).includes('/versions'),
    ).length
    expect(versionsCallCountAfter).toBe(versionsCallCountBefore)
  })

  it('clamps relative timestamps to "0s ago" when the server clock is ahead', async () => {
    const preview = capturePreview()
    vi.unstubAllGlobals()
    const future = new Date(Date.now() + 30_000).toISOString()
    const fetchMock = vi.fn<(...args: FetchArgs) => Promise<Response>>((input) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes('/branches')) return Promise.resolve(mkBranchesResponse())
      if (url.endsWith('/document')) return Promise.resolve(mkVersionDocumentResponse())
      if (url.includes('/versions')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              versions: [
                {
                  id: 'v-skew',
                  path: 'canvas-a',
                  createdAt: future,
                  elementCount: 1,
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

    render(<VersionTimeline workspaceId="sess_1" path="canvas-a" onPreview={preview.onPreview} />)
    await waitFor(() => {
      expect(screen.getByText(/0s ago/)).toBeTruthy()
    })
    expect(screen.queryByText(/-\d+s ago/)).toBeNull()
  })

  // REPLACES 'filters cards and mini-graph rows to the active branch'. That
  // test pinned the rule this increment moves, so it is rewritten rather than
  // adjusted until it passes — the two are indistinguishable in a diff
  // otherwise. What it asserted (v-feat absent, two lanes) was true of a
  // timeline that showed one lane; the timeline now shows them all.

  it('renders operator affordances', async () => {
    const preview = capturePreview()
    render(<VersionTimeline workspaceId="sess_1" path="canvas-a" onPreview={preview.onPreview} />)

    await waitFor(() => {
      expect(screen.getByText(/Assistant/)).toBeTruthy()
      expect(screen.getByText(/Alice/)).toBeTruthy()
    })

    // The lane dots this case also asserted on — one per row, coloured by
    // `BranchMeta.color`, solid or ringed by whether HEAD was on it — are
    // gone with the lane column (ADR-0029). Who wrote a version is History's
    // own, and stays.
  })

  it('legacy row without operator renders system fallback', async () => {
    const preview = capturePreview()
    vi.unstubAllGlobals()
    const fetchMock = vi.fn<(...args: FetchArgs) => Promise<Response>>((input) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes('/branches')) return Promise.resolve(mkBranchesResponse())
      if (url.endsWith('/document')) return Promise.resolve(mkVersionDocumentResponse())
      if (url.includes('/versions')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              versions: [
                {
                  id: 'v-legacy',
                  path: 'canvas-a',
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

    render(<VersionTimeline workspaceId="sess_1" path="canvas-a" onPreview={preview.onPreview} />)
    // An automatic checkpoint has no author to name. It used to be labelled
    // "System", which said the same thing the row's own title already did.
    const row = await screen.findByTestId('version-row')
    expect(row.textContent).not.toMatch(/System/)
  })

  // The empty state is the DOCUMENT's now, not one lane's — nothing is
  // filtered out, so an empty list means there is nothing anywhere.
  it('renders the empty state when the document has no versions at all', async () => {
    const preview = capturePreview()
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
      if (url.endsWith('/document')) return Promise.resolve(mkVersionDocumentResponse())
      if (url.includes('/versions')) {
        return Promise.resolve(new Response(JSON.stringify({ versions: [] }), { status: 200 }))
      }
      return Promise.resolve(new Response('{}', { status: 200 }))
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<VersionTimeline workspaceId="sess_1" path="canvas-a" onPreview={preview.onPreview} />)
    const empty = await screen.findByText(/No versions yet/i)

    // The empty state names no cadence, and that is the point rather than
    // vagueness. It said "auto-save (~30s)" for as long as the trigger was a
    // 30-second throttle and for a while after it became a five-minute
    // pause — a number in copy is a second place the interval lives, and the
    // one nothing updates. It also said "this canvas" for a history that is
    // the DOCUMENT's, and reads the same above a markdown body.
    const copy = empty.textContent ?? ''
    expect(copy).not.toMatch(/\d+\s*s\b|~|canvas/i)
    expect(copy).toContain('A checkpoint is saved a little after you stop editing.')
  })

  it('scroll container can shrink inside the fixed-height history popover', async () => {
    const preview = capturePreview()
    const { container } = render(
      <VersionTimeline workspaceId="sess_1" path="canvas-a" onPreview={preview.onPreview} />,
    )

    await waitFor(() => {
      expect(screen.getByText(/Assistant/)).toBeTruthy()
    })

    expect(container.firstElementChild?.className).toContain('min-h-0')
    expect(container.querySelector('[data-slot="scroll-area"]')?.className ?? '').toContain(
      'min-h-0',
    )
  })

  it('calls onRestored and refreshes after a successful restore', async () => {
    const preview = capturePreview()
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
      if (url.endsWith('/document')) return Promise.resolve(mkVersionDocumentResponse())
      if (url.includes('/versions')) return Promise.resolve(mkVersionsResponse())
      return Promise.resolve(new Response('{}', { status: 200 }))
    })
    vi.stubGlobal('fetch', fetchMock)

    render(
      <VersionTimeline
        workspaceId="sess_1"
        path="canvas-a"
        onRestored={onRestored}
        onPreview={preview.onPreview}
      />,
    )

    const row = await screen.findByText(/Assistant/)
    fireEvent.click(row.closest('button')!)
    await waitFor(() => {
      expect(preview.current).not.toBeNull()
    })

    act(() => preview.require().restore())

    await waitFor(() => {
      expect(restoreCalls.some((u) => u.includes('/versions/v-new/restore'))).toBe(true)
    })
    await waitFor(() => {
      expect(onRestored).toHaveBeenCalledTimes(1)
    })
    await waitFor(() => {
      expect(preview.current).toBeNull()
    })
  })

  it('keeps the dialog open and does not fire onRestored when the restore request fails', async () => {
    const preview = capturePreview()
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
      if (url.endsWith('/document')) return Promise.resolve(mkVersionDocumentResponse())
      if (url.includes('/versions')) return Promise.resolve(mkVersionsResponse())
      return Promise.resolve(new Response('{}', { status: 200 }))
    })
    vi.stubGlobal('fetch', fetchMock)

    render(
      <VersionTimeline
        workspaceId="sess_1"
        path="canvas-a"
        onRestored={onRestored}
        onPreview={preview.onPreview}
      />,
    )

    const row = await screen.findByText(/Assistant/)
    fireEvent.click(row.closest('button')!)
    await waitFor(() => {
      expect(preview.current).not.toBeNull()
    })

    act(() => preview.require().restore())

    await waitFor(() => {
      expect(preview.require().error).toMatch(/restore failed/i)
    })
    expect(onRestored).not.toHaveBeenCalled()
    expect(preview.current).not.toBeNull()
  })

  it('keeps the dialog open with an error when the restore request throws (network failure)', async () => {
    const preview = capturePreview()
    const onRestored = vi.fn()
    vi.unstubAllGlobals()
    const fetchMock = vi.fn<(...args: FetchArgs) => Promise<Response>>((input) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes('/restore')) return Promise.reject(new TypeError('Failed to fetch'))
      if (url.includes('/branches')) return Promise.resolve(mkBranchesResponse())
      if (url.endsWith('/document')) return Promise.resolve(mkVersionDocumentResponse())
      if (url.includes('/versions')) return Promise.resolve(mkVersionsResponse())
      return Promise.resolve(new Response('{}', { status: 200 }))
    })
    vi.stubGlobal('fetch', fetchMock)

    render(
      <VersionTimeline
        workspaceId="sess_1"
        path="canvas-a"
        onRestored={onRestored}
        onPreview={preview.onPreview}
      />,
    )

    const row = await screen.findByText(/Assistant/)
    fireEvent.click(row.closest('button')!)
    await waitFor(() => {
      expect(preview.current).not.toBeNull()
    })

    act(() => preview.require().restore())

    await waitFor(() => {
      expect(preview.require().error).toMatch(/restore failed/i)
    })
    expect(onRestored).not.toHaveBeenCalled()
    expect(preview.current).not.toBeNull()
    expect(mockLog.error).toHaveBeenCalledWith('restore request threw', expect.any(TypeError))
  })

  it('disables the Restore action while a restore is in flight so repeat activation cannot double-submit', async () => {
    const preview = capturePreview()
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
      if (url.endsWith('/document')) return Promise.resolve(mkVersionDocumentResponse())
      if (url.includes('/versions')) return Promise.resolve(mkVersionsResponse())
      return Promise.resolve(new Response('{}', { status: 200 }))
    })
    vi.stubGlobal('fetch', fetchMock)

    render(
      <VersionTimeline
        workspaceId="sess_1"
        path="canvas-a"
        onRestored={onRestored}
        onPreview={preview.onPreview}
      />,
    )

    const row = await screen.findByText(/Assistant/)
    fireEvent.click(row.closest('button')!)
    await waitFor(() => {
      expect(preview.current).not.toBeNull()
    })

    act(() => preview.require().restore())
    // Repeat activation while the first request is still in flight. The
    // chrome disables its button, but the guard that matters is the panel's
    // own — a second call must not become a second request.
    act(() => preview.require().restore())
    act(() => preview.require().restore())

    await waitFor(() => {
      expect(restoreCalls.length).toBe(1)
    })
    expect(preview.require().isRestoring).toBe(true)

    resolveRestore?.()
    await waitFor(() => {
      expect(onRestored).toHaveBeenCalledTimes(1)
    })
  })

  it('ignores Cancel and keeps the pending version locked while a restore is in flight', async () => {
    const preview = capturePreview()
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
      if (url.endsWith('/document')) return Promise.resolve(mkVersionDocumentResponse())
      if (url.includes('/versions')) return Promise.resolve(mkVersionsResponse())
      return Promise.resolve(new Response('{}', { status: 200 }))
    })
    vi.stubGlobal('fetch', fetchMock)

    render(
      <VersionTimeline
        workspaceId="sess_1"
        path="canvas-a"
        onRestored={onRestored}
        onPreview={preview.onPreview}
      />,
    )

    const row = await screen.findByText(/Assistant/)
    fireEvent.click(row.closest('button')!)
    await waitFor(() => {
      expect(preview.current).not.toBeNull()
    })

    act(() => preview.require().restore())
    await waitFor(() => {
      expect(restoreCalls.length).toBe(1)
    })

    // Cancel must not close the dialog nor unlock a second /restore submission
    // while the first request is still in flight.
    act(() => preview.require().stop())
    expect(preview.current).not.toBeNull()
    expect(preview.require().isRestoring).toBe(true)

    resolveRestore?.()
    await waitFor(() => {
      expect(onRestored).toHaveBeenCalledTimes(1)
    })
    expect(restoreCalls).toHaveLength(1)
    await waitFor(() => {
      expect(preview.current).toBeNull()
    })
  })
})

// `VersionTimeline HEAD polling` stood here: the list refetched branches on
// the same 15s tick so an externally-moved HEAD reached its filter. There is
// no HEAD to move any more (ADR-0029) — the poll now only looks for new
// versions, which the refreshSignal cases above cover.

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
            path: 'canvas-a',
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
    const preview = capturePreview()
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const now = new Date('2026-04-23T02:00:00Z')
    vi.setSystemTime(now)
    stubFetchWithVersionAt(new Date(now.getTime() - 30_000).toISOString())

    render(<VersionTimeline workspaceId="sess_1" path="canvas-a" onPreview={preview.onPreview} />)
    await waitFor(() => {
      expect(screen.getByText(/30s ago/)).toBeTruthy()
    })
  })

  it('renders minutes-ago for a timestamp under an hour old', async () => {
    const preview = capturePreview()
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const now = new Date('2026-04-23T02:00:00Z')
    vi.setSystemTime(now)
    stubFetchWithVersionAt(new Date(now.getTime() - 5 * 60_000).toISOString())

    render(<VersionTimeline workspaceId="sess_1" path="canvas-a" onPreview={preview.onPreview} />)
    await waitFor(() => {
      expect(screen.getByText(/5m ago/)).toBeTruthy()
    })
  })

  it('renders hours-ago for a timestamp under a day old', async () => {
    const preview = capturePreview()
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const now = new Date('2026-04-23T02:00:00Z')
    vi.setSystemTime(now)
    stubFetchWithVersionAt(new Date(now.getTime() - 3 * 3600_000).toISOString())

    render(<VersionTimeline workspaceId="sess_1" path="canvas-a" onPreview={preview.onPreview} />)
    await waitFor(() => {
      expect(screen.getByText(/3h ago/)).toBeTruthy()
    })
  })

  it('renders an absolute date/time for a timestamp a day or more old', async () => {
    const preview = capturePreview()
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const now = new Date('2026-04-23T02:00:00Z')
    vi.setSystemTime(now)
    stubFetchWithVersionAt(new Date(now.getTime() - 2 * 86_400_000).toISOString())

    render(<VersionTimeline workspaceId="sess_1" path="canvas-a" onPreview={preview.onPreview} />)
    await waitFor(() => {
      // 2026-04-21 00:00 local time rendered as M/D HH:MM.
      expect(screen.getByText(/4\/21 \d{2}:\d{2}/)).toBeTruthy()
    })
  })

  it('falls back to the raw ISO string for an invalid createdAt', async () => {
    const preview = capturePreview()
    stubFetchWithVersionAt('not-a-real-date')

    render(<VersionTimeline workspaceId="sess_1" path="canvas-a" onPreview={preview.onPreview} />)
    await waitFor(() => {
      expect(screen.getByText(/not-a-real-date/)).toBeTruthy()
    })
  })
})

describe('VersionTimeline via DaemonApiContext', () => {
  const DAEMON_BASE_URL = 'http://127.0.0.1:3099'

  afterEach(() => {
    vi.unstubAllGlobals()
    cleanup()
  })

  function mkThumbnailVersionsResponse(): Response {
    return new Response(
      JSON.stringify({
        versions: [
          {
            id: 'v-thumb',
            path: 'canvas-a',
            createdAt: '2026-04-23T02:00:00Z',
            elementCount: 5,
            auto: true,
            hasThumbnail: true,
            branchName: 'main',
            operator: { kind: 'ai', peerId: 'peer-ai', displayName: 'Assistant' },
          },
        ],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )
  }

  it('resolves the versions request against the daemon origin with an Authorization header', async () => {
    const preview = capturePreview()
    const underlyingFetch = vi.fn<(...args: FetchArgs) => Promise<Response>>((input) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes('/branches')) return Promise.resolve(mkBranchesResponse())
      if (url.endsWith('/document')) return Promise.resolve(mkVersionDocumentResponse())
      if (url.includes('/versions')) return Promise.resolve(mkVersionsResponse())
      return Promise.resolve(new Response('{}', { status: 200 }))
    })
    vi.stubGlobal('fetch', underlyingFetch)
    const daemonFetch = createDaemonFetch(DAEMON_BASE_URL, 'test-token')

    render(
      <DaemonApiContext.Provider value={daemonFetch}>
        <VersionTimeline workspaceId="sess_1" path="canvas-a" onPreview={preview.onPreview} />
      </DaemonApiContext.Provider>,
    )

    await waitFor(() => {
      expect(
        underlyingFetch.mock.calls.some(([input]) => {
          const url = input instanceof URL ? input : new URL(String(input))
          return url.origin === DAEMON_BASE_URL && String(url).includes('/versions')
        }),
      ).toBe(true)
    })

    const versionsCall = underlyingFetch.mock.calls.find(([input]) =>
      String(input instanceof URL ? input : new URL(String(input))).includes('/versions'),
    )
    const init = versionsCall?.[1]
    const headers = new Headers(init?.headers)
    expect(headers.get('Authorization')).toBe('Bearer test-token')
  })

  it('POSTs restore through the provided daemon fetch', async () => {
    const preview = capturePreview()
    const restoreCalls: string[] = []
    const underlyingFetch = vi.fn<(...args: FetchArgs) => Promise<Response>>((input) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes('/restore')) {
        restoreCalls.push(url)
        return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }))
      }
      if (url.includes('/branches')) return Promise.resolve(mkBranchesResponse())
      if (url.endsWith('/document')) return Promise.resolve(mkVersionDocumentResponse())
      if (url.includes('/versions')) return Promise.resolve(mkVersionsResponse())
      return Promise.resolve(new Response('{}', { status: 200 }))
    })
    vi.stubGlobal('fetch', underlyingFetch)
    const daemonFetch = createDaemonFetch(DAEMON_BASE_URL, 'test-token')

    render(
      <DaemonApiContext.Provider value={daemonFetch}>
        <VersionTimeline workspaceId="sess_1" path="canvas-a" onPreview={preview.onPreview} />
      </DaemonApiContext.Provider>,
    )

    const row = await screen.findByText(/Assistant/)
    fireEvent.click(row.closest('button')!)
    await waitFor(() => {
      expect(preview.current).not.toBeNull()
    })
    act(() => preview.require().restore())

    await waitFor(() => {
      expect(restoreCalls.some((u) => u.startsWith(DAEMON_BASE_URL))).toBe(true)
    })
  })

  it('fetches the thumbnail through the authorized daemon fetch and renders it via an objectURL, when a daemon provider is active', async () => {
    const preview = capturePreview()
    const createObjectURL = vi.fn(() => 'blob:mock-1')
    const revokeObjectURL = vi.fn()
    const originalCreateObjectURL = URL.createObjectURL
    const originalRevokeObjectURL = URL.revokeObjectURL
    URL.createObjectURL = createObjectURL
    URL.revokeObjectURL = revokeObjectURL

    const underlyingFetch = vi.fn<(...args: FetchArgs) => Promise<Response>>((input) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes('/branches')) return Promise.resolve(mkBranchesResponse())
      if (url.includes('/versions/v-thumb/thumbnail')) {
        return Promise.resolve(new Response(new Blob(['png']), { status: 200 }))
      }
      if (url.includes('/versions')) return Promise.resolve(mkThumbnailVersionsResponse())
      return Promise.resolve(new Response('{}', { status: 200 }))
    })
    vi.stubGlobal('fetch', underlyingFetch)
    const daemonFetch = createDaemonFetch(DAEMON_BASE_URL, 'test-token')

    render(
      <DaemonApiContext.Provider value={daemonFetch}>
        <VersionTimeline workspaceId="sess_1" path="canvas-a" onPreview={preview.onPreview} />
      </DaemonApiContext.Provider>,
    )

    await screen.findByText(/Assistant/)
    await waitFor(() => expect(document.querySelector('img')).not.toBeNull())
    expect(document.querySelector('img')?.getAttribute('src')).toBe('blob:mock-1')
    expect(
      underlyingFetch.mock.calls.some(([reqInput]) =>
        String(reqInput).includes('/versions/v-thumb/thumbnail'),
      ),
    ).toBe(true)

    URL.createObjectURL = originalCreateObjectURL
    URL.revokeObjectURL = originalRevokeObjectURL
  })

  it('a version with hasThumbnail=false renders the placeholder without fetching a thumbnail, in daemon mode', async () => {
    const preview = capturePreview()
    const underlyingFetch = vi.fn<(...args: FetchArgs) => Promise<Response>>((input) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes('/branches')) return Promise.resolve(mkBranchesResponse())
      if (url.endsWith('/document')) return Promise.resolve(mkVersionDocumentResponse())
      if (url.includes('/versions')) return Promise.resolve(mkVersionsResponse())
      return Promise.resolve(new Response('{}', { status: 200 }))
    })
    vi.stubGlobal('fetch', underlyingFetch)
    const daemonFetch = createDaemonFetch(DAEMON_BASE_URL, 'test-token')

    render(
      <DaemonApiContext.Provider value={daemonFetch}>
        <VersionTimeline workspaceId="sess_1" path="canvas-a" onPreview={preview.onPreview} />
      </DaemonApiContext.Provider>,
    )

    await screen.findByText(/Assistant/)
    expect(document.querySelector('img')).toBeNull()
    expect(
      underlyingFetch.mock.calls.some(([reqInput]) => String(reqInput).includes('/thumbnail')),
    ).toBe(false)
  })

  it('draws the picture the keeper answers with', async () => {
    const preview = capturePreview()
    const underlyingFetch = vi.fn<(...args: FetchArgs) => Promise<Response>>((input) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes('/branches')) return Promise.resolve(mkBranchesResponse())
      if (url.includes('/versions')) return Promise.resolve(mkThumbnailVersionsResponse())
      return Promise.resolve(new Response('{}', { status: 200 }))
    })
    vi.stubGlobal('fetch', underlyingFetch)

    render(<VersionTimeline workspaceId="sess_1" path="canvas-a" onPreview={preview.onPreview} />)

    await screen.findByText(/Assistant/)
    // Awaited rather than read once: the picture arrives from the keeper on a
    // later tick now, where it used to be an <img src> the first render
    // already carried.
    await waitFor(() => expect(document.querySelector('img')).not.toBeNull())
  })

  it('titles a version a person marked by the name they gave it', async () => {
    const preview = capturePreview()
    const underlyingFetch = vi.fn<(...args: FetchArgs) => Promise<Response>>((input) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes('/branches')) return Promise.resolve(mkBranchesResponse())
      if (url.endsWith('/document')) return Promise.resolve(mkVersionDocumentResponse())
      if (url.includes('/versions')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              versions: [
                {
                  id: 'v-manual',
                  path: 'canvas-a',
                  label: 'release candidate',
                  createdAt: '2026-04-23T02:00:00Z',
                  elementCount: 5,
                  auto: false,
                  hasThumbnail: false,
                  branchName: 'main',
                  operator: { kind: 'human', peerId: 'peer-human', displayName: 'Alice' },
                },
              ],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
        )
      }
      return Promise.resolve(new Response('{}', { status: 200 }))
    })
    vi.stubGlobal('fetch', underlyingFetch)
    const daemonFetch = createDaemonFetch(DAEMON_BASE_URL, 'test-token')

    render(
      <DaemonApiContext.Provider value={daemonFetch}>
        <VersionTimeline workspaceId="sess_1" path="canvas-a" onPreview={preview.onPreview} />
      </DaemonApiContext.Provider>,
    )

    // The "manual" badge is gone: a version a person marked deliberately is
    // the one carrying a LABEL, and the label is already the row's title.
    // Both said the same thing, and neither said what the version holds.
    const row = await screen.findByTestId('version-row')
    expect(row.textContent).toContain('release candidate')
    expect(row.textContent).not.toMatch(/manual/)
  })
})

describe('VersionTimeline error handling and canvas-switch reset', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    cleanup()
  })

  it('does not reject or crash when the versions fetch throws a network error', async () => {
    const preview = capturePreview()
    const fetchMock = vi.fn<(...args: FetchArgs) => Promise<Response>>((input) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes('/branches')) return Promise.resolve(mkBranchesResponse())
      if (url.includes('/versions')) return Promise.reject(new TypeError('network down'))
      return Promise.resolve(new Response('{}', { status: 200 }))
    })
    vi.stubGlobal('fetch', fetchMock)
    mockLog.error.mockClear()

    render(<VersionTimeline workspaceId="sess_1" path="canvas-a" onPreview={preview.onPreview} />)

    await waitFor(() => {
      expect(mockLog.error).toHaveBeenCalledWith('versions request threw', expect.any(TypeError))
    })
    // Loading settles instead of spinning forever, and no unhandled rejection
    // propagates out of the effect (a rejection here would fail the test run).
    await waitFor(() => {
      expect(screen.getByText(/No versions yet/)).toBeTruthy()
    })
  })

  it('logs and leaves the list empty when the versions response is not ok', async () => {
    const preview = capturePreview()
    const fetchMock = vi.fn<(...args: FetchArgs) => Promise<Response>>((input) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes('/branches')) return Promise.resolve(mkBranchesResponse())
      if (url.includes('/versions')) return Promise.resolve(new Response('{}', { status: 500 }))
      return Promise.resolve(new Response('{}', { status: 200 }))
    })
    vi.stubGlobal('fetch', fetchMock)
    mockLog.error.mockClear()

    render(<VersionTimeline workspaceId="sess_1" path="canvas-a" onPreview={preview.onPreview} />)

    await waitFor(() => {
      expect(mockLog.error).toHaveBeenCalledWith(
        'versions request failed',
        expect.objectContaining({ status: 500 }),
      )
    })
    expect(screen.getByText(/No versions yet/)).toBeTruthy()
  })

  it('clears the previous canvas versions immediately when workspaceId/path changes', async () => {
    const preview = capturePreview()
    // canvas-new's /versions request hangs for the rest of the test, so any
    // row rendered after the switch can only be the stale canvas-old data —
    // unless the reset-on-change effect cleared it.
    let versionsCallCount = 0
    const fetchMock = vi.fn<(...args: FetchArgs) => Promise<Response>>((input) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes('/branches')) return Promise.resolve(mkBranchesResponse())
      if (url.endsWith('/document')) return Promise.resolve(mkVersionDocumentResponse())
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

    const { rerender } = render(
      <VersionTimeline workspaceId="sess_1" path="canvas-old" onPreview={preview.onPreview} />,
    )

    // Load canvas-old's versions first so there is stale data to leak.
    await waitFor(() => {
      expect(screen.getByText(/Assistant/)).toBeTruthy()
    })

    // Switching to canvas-new (same component instance, no remount key) must
    // clear that stale data immediately, even though canvas-new's own
    // /versions request never resolves here.
    rerender(
      <VersionTimeline workspaceId="sess_1" path="canvas-new" onPreview={preview.onPreview} />,
    )
    await waitFor(() => {
      expect(screen.queryByText('🤖 Assistant')).toBeNull()
    })
  })
})

/**
 * The lineage a restore leaves, on screen.
 *
 * Two halves that have to arrive together: the arc says the two points are
 * joined, and the label says WHY. The shape alone would show a branch with
 * no account of itself; the label alone would claim a link the eye cannot
 * follow.
 */
describe('VersionTimeline draws where a restored state came from', () => {
  const restoredHistory = () =>
    new Response(
      JSON.stringify({
        versions: [
          {
            id: 'v-merge',
            path: 'canvas-a',
            createdAt: '2026-04-23T03:00:00Z',
            elementCount: 5,
            auto: true,
            hasThumbnail: false,
            branchName: 'main',
            restoredFrom: 'v-old',
          },
          {
            id: 'v-between',
            path: 'canvas-a',
            createdAt: '2026-04-23T02:00:00Z',
            elementCount: 4,
            auto: true,
            hasThumbnail: false,
            branchName: 'main',
          },
          {
            id: 'v-old',
            path: 'canvas-a',
            createdAt: '2026-04-23T01:00:00Z',
            elementCount: 3,
            auto: false,
            label: 'first draft',
            hasThumbnail: false,
            branchName: 'main',
          },
        ],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )

  it('names the point a restore came from', async () => {
    vi.unstubAllGlobals()
    vi.stubGlobal(
      'fetch',
      vi.fn<(...args: FetchArgs) => Promise<Response>>((input) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
        if (url.includes('/branches')) return Promise.resolve(mkBranchesResponse())
        if (url.includes('/versions')) return Promise.resolve(restoredHistory())
        return Promise.resolve(new Response('{}', { status: 200 }))
      }),
    )

    render(<VersionTimeline workspaceId="sess_1" path="canvas-a" />)
    await screen.findByText('first draft')

    // Named by what the row it points at is CALLED, so the label and the
    // arc's far end read as the same thing.
    const label = screen.getByTestId('version-restored-from')
    expect(label.textContent).toBe('restored from first draft')
    expect(label.closest('[data-testid="version-row"]')?.textContent).toContain('5 els')

    // The ARC that used to run beside this label is gone with the lane
    // column (ADR-0029). What it drew — that these two points met because
    // somebody went back — is what the label says in words, which is why the
    // label is what survived.
  })

  it('draws no arc for a history nobody restored in', async () => {
    const { container } = render(<VersionTimeline workspaceId="sess_1" path="canvas-a" />)
    await screen.findByText(/Assistant/)
    expect(container.querySelectorAll('[stroke-dasharray]')).toHaveLength(0)
    expect(screen.queryByTestId('version-restored-from')).toBeNull()
  })
})
