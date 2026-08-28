import type { SaveVersionResponse } from '@kamiazya/whiteboard-mcp/api-contracts'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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

function mkSaveVersionResponse(): Response {
  const body: SaveVersionResponse = {
    version: {
      id: 'v-saved-001',
      path: 'design/login-flow',
      createdAt: new Date('2026-06-07T10:00:00Z').toISOString(),
      elementCount: 42,
      label: '',
      auto: false,
      hasThumbnail: false,
      branchName: 'main',
      operator: { kind: 'human', peerId: 'peer-test', displayName: 'Tester' },
    },
  }
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
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
        onToggleFullscreen={() => {}}
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
  it('does not dispatch whiteboard:wb_version_saved when POST /versions returns invalid schema', async () => {
    // The default beforeEach mock returns { ok: true } for POST /versions,
    // which does not match saveVersionResponseSchema (missing version.id, branchName, etc.).
    const versionSavedFired = vi.fn()
    window.addEventListener('whiteboard:wb_version_saved', versionSavedFired)

    renderTopBar()

    // Ctrl+S triggers saveVersion(''); fire on window (capture listener)
    fireEvent.keyDown(window, { ctrlKey: true, key: 's', code: 'KeyS' })

    // Wait until the fetch mock has been called for the POST /versions request.
    // This is the observable boundary that confirms saveVersion has finished its
    // round-trip — independent of whether the implementation logs to console,
    // getLogger, or swallows the error silently.
    await waitFor(() => {
      const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/versions'),
        expect.objectContaining({ method: 'POST' }),
      )
    })

    // Give the microtask queue one turn so any Promise continuations after the
    // fetch resolve can settle before we assert the event was not dispatched.
    await new Promise<void>((resolve) => setTimeout(resolve, 0))

    expect(versionSavedFired).not.toHaveBeenCalled()

    window.removeEventListener('whiteboard:wb_version_saved', versionSavedFired)
  })

  it('dispatches wb_version_saved on a conforming save, clearing HeaderVersionDot', async () => {
    // Override the beforeEach stub so POST /versions returns a valid saveVersionResponseSchema body.
    const fetchMock = vi.fn<(...args: FetchArgs) => Promise<Response>>((input, init) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.endsWith('/api/workspaces/sess_1/names')) return Promise.resolve(mkNamesResponse())
      if (url.includes('/branches')) return Promise.resolve(mkBranchesResponse())
      if (url.includes('/versions') && url.endsWith('/restore')) {
        return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }))
      }
      if (url.includes('/versions') && init?.method === 'POST') {
        return Promise.resolve(mkSaveVersionResponse())
      }
      if (url.includes('/versions')) return Promise.resolve(mkVersionsResponse())
      return Promise.resolve(new Response('{}', { status: 200 }))
    })
    vi.stubGlobal('fetch', fetchMock)

    const versionSavedFired = vi.fn()
    window.addEventListener('whiteboard:wb_version_saved', versionSavedFired)

    renderTopBar()

    // Mark the doc dirty first (as useWhiteboardSync would on a real edit) so
    // HeaderVersionDot's dot is visible before the save clears it.
    window.dispatchEvent(
      new CustomEvent('whiteboard:doc_changed', {
        detail: { workspaceId: 'sess_1', path: 'design/login-flow' },
      }),
    )
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /save/i })).toBeTruthy()
    })

    // Ctrl+S triggers saveVersion(''); fire on window with capture listener.
    fireEvent.keyDown(window, { ctrlKey: true, key: 's', code: 'KeyS' })

    // Wait for the event to be dispatched after the successful fetch + schema parse,
    // with the exact detail shape useDirtyState filters on.
    await waitFor(() => {
      expect(versionSavedFired).toHaveBeenCalledTimes(1)
      const event = versionSavedFired.mock.calls[0]![0] as CustomEvent<{
        workspaceId: string
        path: string
      }>
      expect(event.detail).toEqual({ workspaceId: 'sess_1', path: 'design/login-flow' })
    })

    // The dirty dot clears once useDirtyState observes the matching wb_version_saved event.
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /save/i })).toBeNull()
    })

    window.removeEventListener('whiteboard:wb_version_saved', versionSavedFired)
  })

  it('issues PUT /versions/:id/thumbnail after a valid save when getThumbnailBlob returns a Blob', async () => {
    const thumbnailBlob = new Blob(['fake-png'], { type: 'image/png' })
    const getThumbnailBlob = vi.fn().mockResolvedValue(thumbnailBlob)

    const thumbnailPutCalls: string[] = []
    const fetchMock = vi.fn<(...args: FetchArgs) => Promise<Response>>((input, init) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.endsWith('/api/workspaces/sess_1/names')) return Promise.resolve(mkNamesResponse())
      if (url.includes('/branches')) return Promise.resolve(mkBranchesResponse())
      if (url.includes('/versions') && url.endsWith('/restore')) {
        return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }))
      }
      if (url.includes('/versions') && init?.method === 'PUT') {
        thumbnailPutCalls.push(url)
        return Promise.resolve(new Response(null, { status: 204 }))
      }
      if (url.includes('/versions') && init?.method === 'POST') {
        return Promise.resolve(mkSaveVersionResponse())
      }
      if (url.includes('/versions')) return Promise.resolve(mkVersionsResponse())
      return Promise.resolve(new Response('{}', { status: 200 }))
    })
    vi.stubGlobal('fetch', fetchMock)

    renderTopBar({ getThumbnailBlob })

    fireEvent.keyDown(window, { ctrlKey: true, key: 's', code: 'KeyS' })

    // Wait for the thumbnail PUT to be issued using the version id from the response.
    await waitFor(() => {
      expect(thumbnailPutCalls).toHaveLength(1)
      expect(thumbnailPutCalls[0]).toContain('/versions/v-saved-001/thumbnail')
    })

    expect(getThumbnailBlob).toHaveBeenCalledTimes(1)
  })

  it('does not throw when thumbnail upload fails after a valid save', async () => {
    const getThumbnailBlob = vi
      .fn()
      .mockResolvedValue(new Blob(['fake-png'], { type: 'image/png' }))

    const fetchMock = vi.fn<(...args: FetchArgs) => Promise<Response>>((input, init) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.endsWith('/api/workspaces/sess_1/names')) return Promise.resolve(mkNamesResponse())
      if (url.includes('/branches')) return Promise.resolve(mkBranchesResponse())
      if (url.includes('/versions') && url.endsWith('/restore')) {
        return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }))
      }
      if (url.includes('/versions') && init?.method === 'PUT') {
        // Simulate a network failure on thumbnail upload.
        return Promise.reject(new Error('upload failed'))
      }
      if (url.includes('/versions') && init?.method === 'POST') {
        return Promise.resolve(mkSaveVersionResponse())
      }
      if (url.includes('/versions')) return Promise.resolve(mkVersionsResponse())
      return Promise.resolve(new Response('{}', { status: 200 }))
    })
    vi.stubGlobal('fetch', fetchMock)

    const versionSavedFired = vi.fn()
    window.addEventListener('whiteboard:wb_version_saved', versionSavedFired)

    renderTopBar({ getThumbnailBlob })

    fireEvent.keyDown(window, { ctrlKey: true, key: 's', code: 'KeyS' })

    // The wb_version_saved event must still fire even when the thumbnail upload rejects.
    await waitFor(() => {
      expect(versionSavedFired).toHaveBeenCalledTimes(1)
    })

    window.removeEventListener('whiteboard:wb_version_saved', versionSavedFired)
  })

  // RED-first: the ~400px collapse is a new UX decision, not part of the
  // original component — Tailwind's arbitrary max-*/min-* breakpoint
  // variants only take effect against the real viewport width, so this
  // guard can only run in the browser layer (jsdom class-list checks alone
  // would pass even if the CSS never generated).
  it('collapses the right-side actions into a "View options" kebab under 400px, without hiding the left-side group', async () => {
    // `display:none` on an ancestor (the collapse group, not the button
    // itself) drops the button out of the accessibility tree, so
    // page.getByRole()/toBeVisible() can't distinguish "present but hidden"
    // from "not rendered", and getComputedStyle(button).display never
    // reports 'none' since that property isn't inherited from the hidden
    // ancestor. Query with RTL's `hidden: true` to bypass the a11y filter
    // and use checkVisibility(), which walks the ancestor chain.
    const isDisplayNone = (el: Element) =>
      'checkVisibility' in el ? !(el as HTMLElement).checkVisibility() : false

    await page.viewport(375, 900)
    renderTopBar()

    const header = screen.getByRole('banner')
    await waitFor(() => {
      expect(header.getBoundingClientRect().height).toBeCloseTo(48, 0)
    })

    // Exposed right-side actions are hidden at this width.
    await waitFor(() => {
      expect(isDisplayNone(screen.getByRole('button', { name: 'Fullscreen', hidden: true }))).toBe(
        true,
      )
      expect(isDisplayNone(screen.getByRole('button', { name: 'Fullscreen', hidden: true }))).toBe(
        true,
      )
    })

    // The kebab is visible instead.
    // Use the testid rather than an accessible-name role query: an element
    // that is itself display:none (the kebab is, at ≥400px) has no
    // computable accessible name per the ARIA name-computation algorithm,
    // so a name-filtered role query would spuriously not-find it there.
    const kebab = screen.getByTestId('topbar-more-actions-trigger')
    expect(isDisplayNone(kebab)).toBe(false)

    // The left-side group (back button + HeaderBranchChip) still renders
    // without overflow or wrapping.
    expect(isDisplayNone(screen.getByRole('button', { name: /back to documents/i }))).toBe(false)

    // Opening the kebab and selecting Fullscreen calls the same handler as
    // the exposed button would.
    const onToggleFullscreen = vi.fn()
    cleanup()
    renderTopBar({ onToggleFullscreen })
    await page.getByRole('button', { name: 'View options' }).click()
    await page.getByRole('menuitem', { name: 'Fullscreen' }).click()
    expect(onToggleFullscreen).toHaveBeenCalledTimes(1)

    // At ≥400px the kebab is hidden again and the three buttons are visible.
    // 401 (not exactly 400) sidesteps the boundary ambiguity between
    // `max-[400px]:hidden` and `min-[400px]:hidden`, which both match at
    // precisely 400px — the component intentionally treats 400px itself as
    // "narrow" so the two collapse states never both show at once.
    await page.viewport(401, 900)
    cleanup()
    renderTopBar()
    await waitFor(() => {
      expect(isDisplayNone(screen.getByTestId('topbar-more-actions-trigger'))).toBe(true)
      expect(isDisplayNone(screen.getByRole('button', { name: 'Fullscreen' }))).toBe(false)
      expect(isDisplayNone(screen.getByRole('button', { name: 'Fullscreen' }))).toBe(false)
    })

    const headerAfter = screen.getByRole('banner')
    expect(headerAfter.getBoundingClientRect().height).toBeCloseTo(48, 0)
  })
})
