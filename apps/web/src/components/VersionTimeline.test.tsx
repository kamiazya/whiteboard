import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DaemonApiContext } from '@/contexts/DaemonApiContext'
import { createDaemonFetch } from '@/lib/daemon-api-client'
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
  it('does not render version rows while the branch HEAD is still loading', async () => {
    // useBranches defaults head to 'main' until /branches resolves. If the
    // real HEAD is a feature branch, rendering rows filtered by that default
    // briefly offers the WRONG branch's versions as restore targets.
    const fetchMock = vi.fn<(...args: FetchArgs) => Promise<Response>>((input) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      // Branches never resolve within this test; versions resolve immediately.
      if (url.includes('/branches')) return new Promise<Response>(() => {})
      if (url.includes('/versions')) return Promise.resolve(mkVersionsResponse())
      return Promise.resolve(new Response('{}', { status: 200 }))
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<VersionTimeline workspaceId="sess_1" path="canvas-a" />)

    // Give the versions fetch time to land.
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([input]) => String(input).includes('/versions'))).toBe(true)
    })

    // No rows filtered against the default head — show loading instead.
    expect(screen.getByText('Loading…')).toBeTruthy()
    expect(screen.queryByText(/5 els/)).toBeNull()
    expect(screen.queryByText(/3 els/)).toBeNull()
  })

  it('closes an open restore dialog when the canvas changes', async () => {
    // Switching documents with the dialog open must not leave the previous
    // canvas's version staged — confirming would POST that version id to the
    // NEW canvas's restore endpoint.
    const { rerender } = render(<VersionTimeline workspaceId="sess_1" path="canvas-a" />)

    const row = await screen.findByText(/Assistant/)
    fireEvent.click(row.closest('button')!)
    await waitFor(() => {
      expect(screen.getByText('Restore this version?')).toBeTruthy()
    })

    rerender(<VersionTimeline workspaceId="sess_1" path="canvas-b" />)
    await waitFor(() => {
      expect(screen.queryByText('Restore this version?')).toBeNull()
    })
  })

  it('refetches versions when refreshSignal changes (e.g. after a manual save)', async () => {
    const { rerender } = render(
      <VersionTimeline workspaceId="sess_1" path="canvas-a" refreshSignal={0} />,
    )
    await screen.findByText(/Assistant/)

    const fetchMock = vi.mocked(globalThis.fetch)
    const versionsCallCountBefore = fetchMock.mock.calls.filter(([reqInput]) =>
      String(reqInput).includes('/versions'),
    ).length

    rerender(<VersionTimeline workspaceId="sess_1" path="canvas-a" refreshSignal={1} />)

    await waitFor(() => {
      const versionsCallCountAfter = fetchMock.mock.calls.filter(([reqInput]) =>
        String(reqInput).includes('/versions'),
      ).length
      expect(versionsCallCountAfter).toBeGreaterThan(versionsCallCountBefore)
    })
  })

  it('does not refetch when re-rendered with an unchanged refreshSignal', async () => {
    const { rerender } = render(
      <VersionTimeline workspaceId="sess_1" path="canvas-a" refreshSignal={0} />,
    )
    await screen.findByText(/Assistant/)

    const fetchMock = vi.mocked(globalThis.fetch)
    const versionsCallCountBefore = fetchMock.mock.calls.filter(([reqInput]) =>
      String(reqInput).includes('/versions'),
    ).length

    rerender(<VersionTimeline workspaceId="sess_1" path="canvas-a" refreshSignal={0} />)

    const versionsCallCountAfter = fetchMock.mock.calls.filter(([reqInput]) =>
      String(reqInput).includes('/versions'),
    ).length
    expect(versionsCallCountAfter).toBe(versionsCallCountBefore)
  })

  it('clamps relative timestamps to "0s ago" when the server clock is ahead', async () => {
    vi.unstubAllGlobals()
    const future = new Date(Date.now() + 30_000).toISOString()
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

    render(<VersionTimeline workspaceId="sess_1" path="canvas-a" />)
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
  it('shows every lane, not only the one HEAD is on', async () => {
    render(<VersionTimeline workspaceId="sess_1" path="canvas-a" />)

    // v-new and v-mid on `main`, v-feat on `feature`. Before this, asking for
    // the feature branch's history meant switching onto it first.
    await waitFor(() => {
      expect(screen.getAllByText(/5 els|3 els/).length).toBeGreaterThanOrEqual(2)
    })
    expect(screen.getByText(/4 els/)).toBeTruthy()

    await waitFor(() => {
      expect(document.querySelectorAll('svg[viewBox="0 0 24 36"]').length).toBe(3)
    })

    // Branch tabs are gone, so no tab role should exist.
    expect(screen.queryAllByRole('tab').length).toBe(0)
  })

  it('draws the rows HEAD is not on as rings, which is mini-graph own rule', async () => {
    // `mini-graph.ts` has documented "rows on other branches use a ring dot"
    // since it was written, and no call site could reach it: the timeline
    // filtered to HEAD first, so every row it drew was active by
    // construction. This is that rule becoming visible.
    render(<VersionTimeline workspaceId="sess_1" path="canvas-a" />)

    await waitFor(() => {
      expect(document.querySelectorAll('svg[viewBox="0 0 24 36"]').length).toBe(3)
    })
    const dots = [...document.querySelectorAll('svg[viewBox="0 0 24 36"] circle')]
    expect(dots.length).toBe(3)

    const rings = dots.filter((c) => c.getAttribute('fill') === 'none')
    const solid = dots.filter((c) => c.getAttribute('fill') !== 'none')
    // Exactly the one `feature` row is a ring; the two `main` rows are solid.
    expect(rings.length).toBe(1)
    expect(solid.length).toBe(2)
    expect(rings[0]?.getAttribute('stroke-width')).toBe('2')
  })

  it('names the variation a row is on, but only on the rows HEAD is not on', async () => {
    // A ring says "not the lane you are on". It does not say WHICH lane, and
    // colour is not a name — with two variations open the reader has a row of
    // history and no way to tell whose. The lane HEAD is on takes no label
    // for the same reason the shell does not repeat the current workspace on
    // every row: it is the frame, so saying it once is saying it.
    render(<VersionTimeline workspaceId="sess_1" path="canvas-a" />)

    await waitFor(() => {
      expect(screen.getByText(/4 els/)).toBeTruthy()
    })

    // The `feature` row, and no other, carries the lane's name.
    const labels = screen.getAllByTestId('version-lane-name')
    expect(labels.length).toBe(1)
    expect(labels[0]?.textContent).toBe('feature')

    // And it is on the row it describes, not floating beside the list.
    expect(labels[0]?.closest('[data-testid="version-row"]')?.textContent).toContain('4 els')
  })

  it('offers restore only on the lane HEAD is on', async () => {
    // Showing another variation history is not the same as offering to
    // restore from it. What restoring one variation version into another
    // MEANS is a question nobody has answered, so the row is context here,
    // not a target — an affordance that acts on an undecided semantic is
    // worse than no affordance.
    render(<VersionTimeline workspaceId="sess_1" path="canvas-a" />)

    await waitFor(() => {
      expect(screen.getByText(/4 els/)).toBeTruthy()
    })
    const buttons = screen.getAllByRole('button')
    const labels = buttons.map((b) => b.textContent ?? '')
    expect(labels.filter((t) => /5 els|3 els/.test(t)).length).toBe(2)
    expect(labels.some((t) => /4 els/.test(t))).toBe(false)
  })

  it('renders the branchOut label on the row matching baseVersionId', async () => {
    render(<VersionTimeline workspaceId="sess_1" path="canvas-a" />)
    // "variation -> feature" should appear on the v-mid row.
    await waitFor(() => {
      expect(screen.getByText(/variation → feature/)).toBeTruthy()
    })
  })

  it('renders operator affordances and keeps the lane color on the branch color', async () => {
    render(<VersionTimeline workspaceId="sess_1" path="canvas-a" />)

    await waitFor(() => {
      expect(screen.getByText(/Assistant/)).toBeTruthy()
      expect(screen.getByText(/Alice/)).toBeTruthy()
    })

    const circles = document.querySelectorAll('svg[viewBox="0 0 24 36"] circle')
    expect(circles).toHaveLength(3)
    // Each lane keeps its own BranchMeta.color, on the stroke whichever shape
    // the dot takes — that is what makes a ring readable as the same lane.
    const mainDots = [...circles].filter((c) => c.getAttribute('stroke') === '#1971c2')
    expect(mainDots).toHaveLength(2)
    for (const dot of mainDots) {
      expect(dot.getAttribute('fill')).toBe('#1971c2')
      expect(dot.getAttribute('stroke-width')).toBe('0')
    }
    // The `feature` row carries that branch's colour and the ring shape. The
    // previous version of this case asserted the dot is ALWAYS solid, which
    // was true only because the rows were pre-filtered to HEAD.
    const featureDot = [...circles].find((c) => c.getAttribute('stroke') === '#9333ea')
    expect(featureDot?.getAttribute('fill')).toBe('none')
    expect(featureDot?.getAttribute('stroke-width')).toBe('2')
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

    render(<VersionTimeline workspaceId="sess_1" path="canvas-a" />)
    // An automatic checkpoint has no author to name. It used to be labelled
    // "System", which said the same thing the row's own title already did.
    const row = await screen.findByTestId('version-row')
    expect(row.textContent).not.toMatch(/System/)
  })

  // The empty state is the DOCUMENT's now, not one lane's — nothing is
  // filtered out, so an empty list means there is nothing anywhere.
  it('renders the empty state when the document has no versions at all', async () => {
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

    render(<VersionTimeline workspaceId="sess_1" path="canvas-a" />)
    await waitFor(() => {
      expect(screen.getByText(/No versions yet/i)).toBeTruthy()
    })
  })

  it('scroll container can shrink inside the fixed-height history popover', async () => {
    const { container } = render(<VersionTimeline workspaceId="sess_1" path="canvas-a" />)

    await waitFor(() => {
      expect(screen.getByText(/Assistant/)).toBeTruthy()
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

    render(<VersionTimeline workspaceId="sess_1" path="canvas-a" onRestored={onRestored} />)

    const row = await screen.findByText(/Assistant/)
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

    render(<VersionTimeline workspaceId="sess_1" path="canvas-a" onRestored={onRestored} />)

    const row = await screen.findByText(/Assistant/)
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

    render(<VersionTimeline workspaceId="sess_1" path="canvas-a" onRestored={onRestored} />)

    const row = await screen.findByText(/Assistant/)
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

    render(<VersionTimeline workspaceId="sess_1" path="canvas-a" onRestored={onRestored} />)

    const row = await screen.findByText(/Assistant/)
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

    render(<VersionTimeline workspaceId="sess_1" path="canvas-a" onRestored={onRestored} />)

    const row = await screen.findByText(/Assistant/)
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

    render(<VersionTimeline workspaceId="sess_1" path="canvas-a" />)
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
    // What follows an external HEAD change is no longer WHICH rows exist —
    // every lane is shown either way — but which of them is the active one.
    // The `feature` row becomes solid and the two `main` rows become rings.
    await waitFor(() => {
      const dots = [...document.querySelectorAll('svg[viewBox="0 0 24 36"] circle')]
      const solid = dots.filter((c) => c.getAttribute('fill') !== 'none')
      expect(solid).toHaveLength(1)
      expect(solid[0]?.getAttribute('stroke')).toBe('#9333ea')
    })
    expect(screen.getByText(/4 els/)).toBeTruthy()
    expect(screen.getByText(/5 els/)).toBeTruthy()
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
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const now = new Date('2026-04-23T02:00:00Z')
    vi.setSystemTime(now)
    stubFetchWithVersionAt(new Date(now.getTime() - 30_000).toISOString())

    render(<VersionTimeline workspaceId="sess_1" path="canvas-a" />)
    await waitFor(() => {
      expect(screen.getByText(/30s ago/)).toBeTruthy()
    })
  })

  it('renders minutes-ago for a timestamp under an hour old', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const now = new Date('2026-04-23T02:00:00Z')
    vi.setSystemTime(now)
    stubFetchWithVersionAt(new Date(now.getTime() - 5 * 60_000).toISOString())

    render(<VersionTimeline workspaceId="sess_1" path="canvas-a" />)
    await waitFor(() => {
      expect(screen.getByText(/5m ago/)).toBeTruthy()
    })
  })

  it('renders hours-ago for a timestamp under a day old', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const now = new Date('2026-04-23T02:00:00Z')
    vi.setSystemTime(now)
    stubFetchWithVersionAt(new Date(now.getTime() - 3 * 3600_000).toISOString())

    render(<VersionTimeline workspaceId="sess_1" path="canvas-a" />)
    await waitFor(() => {
      expect(screen.getByText(/3h ago/)).toBeTruthy()
    })
  })

  it('renders an absolute date/time for a timestamp a day or more old', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const now = new Date('2026-04-23T02:00:00Z')
    vi.setSystemTime(now)
    stubFetchWithVersionAt(new Date(now.getTime() - 2 * 86_400_000).toISOString())

    render(<VersionTimeline workspaceId="sess_1" path="canvas-a" />)
    await waitFor(() => {
      // 2026-04-21 00:00 local time rendered as M/D HH:MM.
      expect(screen.getByText(/4\/21 \d{2}:\d{2}/)).toBeTruthy()
    })
  })

  it('falls back to the raw ISO string for an invalid createdAt', async () => {
    stubFetchWithVersionAt('not-a-real-date')

    render(<VersionTimeline workspaceId="sess_1" path="canvas-a" />)
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
    const underlyingFetch = vi.fn<(...args: FetchArgs) => Promise<Response>>((input) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes('/branches')) return Promise.resolve(mkBranchesResponse())
      if (url.includes('/versions')) return Promise.resolve(mkVersionsResponse())
      return Promise.resolve(new Response('{}', { status: 200 }))
    })
    vi.stubGlobal('fetch', underlyingFetch)
    const daemonFetch = createDaemonFetch(DAEMON_BASE_URL, 'test-token')

    render(
      <DaemonApiContext.Provider value={daemonFetch}>
        <VersionTimeline workspaceId="sess_1" path="canvas-a" />
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
    const restoreCalls: string[] = []
    const underlyingFetch = vi.fn<(...args: FetchArgs) => Promise<Response>>((input) => {
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
    vi.stubGlobal('fetch', underlyingFetch)
    const daemonFetch = createDaemonFetch(DAEMON_BASE_URL, 'test-token')

    render(
      <DaemonApiContext.Provider value={daemonFetch}>
        <VersionTimeline workspaceId="sess_1" path="canvas-a" />
      </DaemonApiContext.Provider>,
    )

    const row = await screen.findByText(/Assistant/)
    fireEvent.click(row.closest('button')!)
    await waitFor(() => {
      expect(screen.getByText('Restore this version?')).toBeTruthy()
    })
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }))

    await waitFor(() => {
      expect(restoreCalls.some((u) => u.startsWith(DAEMON_BASE_URL))).toBe(true)
    })
  })

  it('fetches the thumbnail through the authorized daemon fetch and renders it via an objectURL, when a daemon provider is active', async () => {
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
        <VersionTimeline workspaceId="sess_1" path="canvas-a" />
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
    const underlyingFetch = vi.fn<(...args: FetchArgs) => Promise<Response>>((input) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes('/branches')) return Promise.resolve(mkBranchesResponse())
      if (url.includes('/versions')) return Promise.resolve(mkVersionsResponse())
      return Promise.resolve(new Response('{}', { status: 200 }))
    })
    vi.stubGlobal('fetch', underlyingFetch)
    const daemonFetch = createDaemonFetch(DAEMON_BASE_URL, 'test-token')

    render(
      <DaemonApiContext.Provider value={daemonFetch}>
        <VersionTimeline workspaceId="sess_1" path="canvas-a" />
      </DaemonApiContext.Provider>,
    )

    await screen.findByText(/Assistant/)
    expect(document.querySelector('img')).toBeNull()
    expect(
      underlyingFetch.mock.calls.some(([reqInput]) => String(reqInput).includes('/thumbnail')),
    ).toBe(false)
  })

  it('renders the thumbnail <img> for the same-origin fallback (no provider)', async () => {
    const underlyingFetch = vi.fn<(...args: FetchArgs) => Promise<Response>>((input) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes('/branches')) return Promise.resolve(mkBranchesResponse())
      if (url.includes('/versions')) return Promise.resolve(mkThumbnailVersionsResponse())
      return Promise.resolve(new Response('{}', { status: 200 }))
    })
    vi.stubGlobal('fetch', underlyingFetch)

    render(<VersionTimeline workspaceId="sess_1" path="canvas-a" />)

    await screen.findByText(/Assistant/)
    expect(document.querySelector('img')).not.toBeNull()
  })

  it('titles a version a person marked by the name they gave it', async () => {
    const underlyingFetch = vi.fn<(...args: FetchArgs) => Promise<Response>>((input) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes('/branches')) return Promise.resolve(mkBranchesResponse())
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
        <VersionTimeline workspaceId="sess_1" path="canvas-a" />
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
    const fetchMock = vi.fn<(...args: FetchArgs) => Promise<Response>>((input) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes('/branches')) return Promise.resolve(mkBranchesResponse())
      if (url.includes('/versions')) return Promise.reject(new TypeError('network down'))
      return Promise.resolve(new Response('{}', { status: 200 }))
    })
    vi.stubGlobal('fetch', fetchMock)
    mockLog.error.mockClear()

    render(<VersionTimeline workspaceId="sess_1" path="canvas-a" />)

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
    const fetchMock = vi.fn<(...args: FetchArgs) => Promise<Response>>((input) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes('/branches')) return Promise.resolve(mkBranchesResponse())
      if (url.includes('/versions')) return Promise.resolve(new Response('{}', { status: 500 }))
      return Promise.resolve(new Response('{}', { status: 200 }))
    })
    vi.stubGlobal('fetch', fetchMock)
    mockLog.error.mockClear()

    render(<VersionTimeline workspaceId="sess_1" path="canvas-a" />)

    await waitFor(() => {
      expect(mockLog.error).toHaveBeenCalledWith(
        'versions request failed',
        expect.objectContaining({ status: 500 }),
      )
    })
    expect(screen.getByText(/No versions yet/)).toBeTruthy()
  })

  it('clears the previous canvas versions immediately when workspaceId/path changes', async () => {
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

    const { rerender } = render(<VersionTimeline workspaceId="sess_1" path="canvas-old" />)

    // Load canvas-old's versions first so there is stale data to leak.
    await waitFor(() => {
      expect(screen.getByText(/Assistant/)).toBeTruthy()
    })

    // Switching to canvas-new (same component instance, no remount key) must
    // clear that stale data immediately, even though canvas-new's own
    // /versions request never resolves here.
    rerender(<VersionTimeline workspaceId="sess_1" path="canvas-new" />)
    await waitFor(() => {
      expect(screen.queryByText('🤖 Assistant')).toBeNull()
    })
  })
})
