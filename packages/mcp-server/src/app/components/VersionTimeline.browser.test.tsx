import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import '../index.css'
import VersionTimeline from './VersionTimeline.js'

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
      ],
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )
}

function mkVersionsResponse(count = 24): Response {
  const versions = Array.from({ length: count }, (_, index) => ({
    id: `v-${index}`,
    slug: 'canvas-a',
    createdAt: new Date(Date.now() - index * 60_000).toISOString(),
    elementCount: 58,
    label: `Version ${index + 1}`,
    auto: true,
    hasThumbnail: false,
    branchName: 'main',
    operator: {
      kind: 'system' as const,
      peerId: 'peer-system',
      displayName: 'auto-save',
    },
  }))

  return new Response(
    JSON.stringify({ versions }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )
}

beforeEach(() => {
  const fetchMock = vi.fn<(...args: FetchArgs) => Promise<Response>>((input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
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

describe('VersionTimeline browser mode', () => {
  it('keeps the history list scrollable inside the fixed-height popover', async () => {
    const { container } = render(
      <div
        style={{
          width: '340px',
          height: '480px',
          display: 'flex',
          flexDirection: 'column',
          minHeight: 0,
        }}
      >
        <VersionTimeline workspaceId="sess_1" slug="canvas-a" />
      </div>,
    )

    await waitFor(() => {
      expect(container.textContent).toContain('Version 1')
      expect(container.textContent).toContain('Version 24')
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
  })

  it('keeps each history row keyboard-focusable and opens the restore dialog', async () => {
    render(
      <div
        style={{
          width: '340px',
          height: '480px',
          display: 'flex',
          flexDirection: 'column',
          minHeight: 0,
        }}
      >
        <VersionTimeline workspaceId="sess_1" slug="canvas-a" />
      </div>,
    )

    const firstVersion = await screen.findByRole('button', { name: /^Version 1\b/ })
    expect(firstVersion).toHaveAttribute('type', 'button')

    firstVersion.focus()
    expect(firstVersion).toHaveFocus()
    firstVersion.click()

    await expect.element(page.getByRole('alertdialog')).toBeInTheDocument()
    await expect.element(page.getByText('Restore this version?')).toBeInTheDocument()
  })
})
