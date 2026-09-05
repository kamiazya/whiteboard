import { cleanup, render, screen, waitFor } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import '../index.css'
import WorkspaceTopBar from './WorkspaceTopBar'

type FetchArgs = [RequestInfo | URL, RequestInit?]

function mkNamesResponse(): Response {
  return new Response(
    JSON.stringify({
      workspace: 'Design review',
      documents: {
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
    path: 'design/login-flow',
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

  return new Response(JSON.stringify({ versions }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

function renderTopBar(props?: Partial<ComponentProps<typeof WorkspaceTopBar>>) {
  return render(
    <div className="h-[560px] w-[1100px] bg-background p-6">
      <WorkspaceTopBar
        workspaceId="sess_1"
        path="design/login-flow"
        onNavigateBack={() => {}}
        {...props}
      />
    </div>,
  )
}

beforeEach(() => {
  const fetchMock = vi.fn<(...args: FetchArgs) => Promise<Response>>((input, init) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
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

afterEach(async () => {
  vi.unstubAllGlobals()
  cleanup()
  // Restore the shared browser instance's default viewport so later tests
  // in this file (and other files sharing the instance) aren't affected by
  // the collapse test's narrow viewport.
  await page.viewport(1280, 900)
})

describe('WorkspaceTopBar browser mode', () => {
  // Tailwind's arbitrary breakpoint variants only take effect against the
  // real viewport width, so a narrow-width guard can only run in the
  // browser layer. The "View options" kebab that used to collapse the
  // right-side actions here went with fullscreen to the shell row; what is
  // left to hold is that the row keeps its height and its left-side group
  // at a phone width, with no second ⋯ growing back.
  it('keeps its height and the left-side group at 375px, with no second kebab', async () => {
    await page.viewport(375, 900)
    renderTopBar()

    const header = screen.getByRole('banner')
    await waitFor(() => {
      expect(header.getBoundingClientRect().height).toBeCloseTo(48, 0)
    })
    expect(
      (screen.getByRole('button', { name: /back to documents/i }) as HTMLElement).checkVisibility(),
    ).toBe(true)
    expect(screen.queryByRole('button', { name: 'View options' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Fullscreen' })).toBeNull()
  })
})
describe('landscape display cutout', () => {
  // `viewport-fit=cover` (index.html) lays the page out UNDER the cutout, so
  // a full-width bar with a plain gutter puts its first and last control —
  // the way back, the kebab — beneath the camera housing in landscape. The
  // padding sits on the bar rather than on a wrapper so the bar's own border
  // and background still reach the screen edge; only the content moves in.
  // The browser layer is the only one that can see this: `px-chrome` is a
  // Tailwind `@utility`, and a name that fails to compile emits NO rule at
  // all rather than an error, which a class-list check would pass right over.
  it('pads the top bar to the safe area rather than a fixed gutter', () => {
    const { container } = renderTopBar()
    const header = container.querySelector('header') as HTMLElement
    // The utility compiled and reached this element: 0px would mean it did not.
    expect(getComputedStyle(header).paddingLeft).toBe('12px')
    // …and it is the safe-area one. On a machine with no cutout every inset
    // is 0px, so the floor makes `px-chrome` and `px-3` numerically identical
    // and only the declaration separates them.
    expect(header.className).toContain('px-chrome')
  })
})
