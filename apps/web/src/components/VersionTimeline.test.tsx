import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import VersionTimeline from './VersionTimeline.js'

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
})
