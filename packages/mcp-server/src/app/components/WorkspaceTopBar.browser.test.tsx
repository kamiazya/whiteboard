import type { ComponentProps } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import '../index.css'
import WorkspaceTopBar from './WorkspaceTopBar.js'

type FetchArgs = [RequestInfo | URL, RequestInit?]

function mkNamesResponse(): Response {
  return new Response(
    JSON.stringify({
      workspace: 'Design review',
      canvases: {
        'design/login-flow': 'Login flow',
        'design/settings-flow': 'Settings flow',
      },
      pinned: ['design/login-flow'],
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )
}

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
      ],
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )
}

function mkVersionsResponse(count = 24): Response {
  const versions = Array.from({ length: count }, (_, index) => ({
    id: `v-${index}`,
    slug: 'design/login-flow',
    createdAt: new Date(Date.now() - index * 60_000).toISOString(),
    elementCount: 58 + index,
    label: `Version ${index + 1}`,
    auto: index % 2 === 0,
    hasThumbnail: false,
    branchName: 'main',
    operator: {
      kind: index % 3 === 0 ? ('human' as const) : ('system' as const),
      peerId: `peer-${index}`,
      displayName: index % 3 === 0 ? 'Alice' : 'auto-save',
    },
  }))

  return new Response(
    JSON.stringify({ versions }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )
}

function renderTopBar(props?: Partial<ComponentProps<typeof WorkspaceTopBar>>) {
  return render(
    <MemoryRouter initialEntries={['/canvas/sess_1/design/login-flow']}>
      <div className="h-[560px] w-[1100px] bg-background p-6">
        <WorkspaceTopBar
          sessionId="sess_1"
          slug="design/login-flow"
          canvases={[
            { slug: 'design/login-flow', updatedAt: '2026-04-24T11:00:00Z' },
            { slug: 'design/settings-flow', updatedAt: '2026-04-23T11:00:00Z' },
          ]}
          onEnterFullscreen={() => {}}
          {...props}
        />
      </div>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  const fetchMock = vi.fn<(...args: FetchArgs) => Promise<Response>>((input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    if (url.endsWith('/api/workspaces/sess_1/names')) return Promise.resolve(mkNamesResponse())
    if (url.includes('/branches')) return Promise.resolve(mkBranchesResponse())
    if (url.includes('/versions') && url.endsWith('/restore')) {
      return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }))
    }
    if (url.includes('/versions') && init?.method === 'POST') {
      return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }))
    }
    if (url.includes('/versions')) return Promise.resolve(mkVersionsResponse())
    return Promise.resolve(new Response('{}', { status: 200 }))
  })
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
  cleanup()
})

describe('WorkspaceTopBar browser mode', () => {
  it('opens History from the real top bar and keeps the popover list scrollable', async () => {
    const { container } = renderTopBar()

    await page.getByRole('button', { name: 'History' }).click()

    await waitFor(() => {
      expect(container.textContent).toContain('Version history')
      expect(container.textContent).toContain('Version 1')
      expect(container.textContent).toContain('Version 24')
      expect(container.textContent).toContain('👤 Alice')
    })

    const viewport = container.querySelector('[data-slot="scroll-area-viewport"]')
    expect(viewport).toBeInstanceOf(HTMLDivElement)

    await waitFor(() => {
      expect(viewport!.clientHeight).toBeGreaterThan(0)
      expect(viewport!.scrollHeight).toBeGreaterThan(viewport!.clientHeight)
    })

    const before = viewport!.scrollTop
    viewport!.scrollTo({ top: viewport!.scrollHeight })
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))

    expect(viewport!.scrollTop).toBeGreaterThan(before)

    await page.getByText('Design review').click()
    await waitFor(() => {
      expect(container.textContent).not.toContain('Version 24')
    })
  })

  it('opens the restore dialog from a real history row and posts restore on confirm', async () => {
    const onRestored = vi.fn()
    renderTopBar({ onRestored })

    await page.getByRole('button', { name: 'History' }).click()
    await page.getByText(/^Version 1$/).click()

    await expect.element(page.getByText('Restore this version?')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }))

    await waitFor(() => {
      const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/versions/v-0/restore'),
        expect.objectContaining({ method: 'POST' }),
      )
      expect(onRestored).toHaveBeenCalledTimes(1)
    })
  })
})
