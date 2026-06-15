import type { ComponentProps } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import '../index.css'
import WorkspaceTopBar from './WorkspaceTopBar.js'
import type { SaveVersionResponse } from '../../shared/api-contracts/canvas.js'

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

function mkSaveVersionResponse(): Response {
  const body: SaveVersionResponse = {
    version: {
      id: 'v-saved-001',
      slug: 'design/login-flow',
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

  return new Response(JSON.stringify({ versions }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

function renderTopBar(props?: Partial<ComponentProps<typeof WorkspaceTopBar>>) {
  return render(
    <MemoryRouter initialEntries={['/canvas/sess_1/design/login-flow']}>
      <div className="h-[560px] w-[1100px] bg-background p-6">
        <WorkspaceTopBar
          workspaceId="sess_1"
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

    // Outside-click to close the popover. Workspace identity is no longer
    // surfaced in the header so we click the back-button (always present)
    // which is outside the version-history Popover bounds.
    fireEvent.mouseDown(container.querySelector('a[href="/"]')!)
    await waitFor(() => {
      expect(container.textContent).not.toContain('Version 24')
    })
  })

  it('exposes a theme toggle that cycles light → dark → system → light', async () => {
    const onToggleTheme = vi.fn()
    const { rerender } = renderTopBar({ theme: 'light', onToggleTheme })

    // light → dark
    fireEvent.click(screen.getByRole('button', { name: /Theme: light/i }))
    expect(onToggleTheme).toHaveBeenLastCalledWith('dark')

    function rerenderWith(theme: 'dark' | 'system') {
      rerender(
        <MemoryRouter initialEntries={['/canvas/sess_1/design/login-flow']}>
          <div className="h-[560px] w-[1100px] bg-background p-6">
            <WorkspaceTopBar
              workspaceId="sess_1"
              slug="design/login-flow"
              canvases={[
                { slug: 'design/login-flow', updatedAt: '2026-04-24T11:00:00Z' },
                { slug: 'design/settings-flow', updatedAt: '2026-04-23T11:00:00Z' },
              ]}
              onEnterFullscreen={() => {}}
              theme={theme}
              onToggleTheme={onToggleTheme}
            />
          </div>
        </MemoryRouter>,
      )
    }

    // dark → system
    rerenderWith('dark')
    fireEvent.click(screen.getByRole('button', { name: /Theme: dark/i }))
    expect(onToggleTheme).toHaveBeenLastCalledWith('system')

    // system → light
    rerenderWith('system')
    fireEvent.click(screen.getByRole('button', { name: /Theme: system/i }))
    expect(onToggleTheme).toHaveBeenLastCalledWith('light')
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

  it('new-canvas dialog: shows Problem Details title on 409 and shows fallback on missing title', async () => {
    let callCount = 0
    // Override the beforeEach fetch stub for this test only.
    const fetchMock = vi.fn<(...args: FetchArgs) => Promise<Response>>((input, init) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.endsWith('/api/workspaces/sess_1/names')) return Promise.resolve(mkNamesResponse())
      if (url.includes('/branches')) return Promise.resolve(mkBranchesResponse())
      if (url.includes('/versions')) return Promise.resolve(mkVersionsResponse())
      if (url.includes('/canvases') && init?.method === 'POST') {
        callCount++
        if (callCount === 1) {
          // First POST → 409 Problem Details with title
          return Promise.resolve(
            new Response(JSON.stringify({ title: 'Canvas "design/foo" already exists' }), {
              status: 409,
              headers: { 'Content-Type': 'application/json' },
            }),
          )
        }
        // Second POST → 500 without title → fallback message
        return Promise.resolve(
          new Response(JSON.stringify({ error: 'internal' }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
          }),
        )
      }
      return Promise.resolve(new Response('{}', { status: 200 }))
    })
    vi.stubGlobal('fetch', fetchMock)

    renderTopBar()

    // The canvas switcher trigger renders the slug as separate spans for prefix/leaf
    // when a "/" is present ("design" + "/" + "login-flow"). Wait for the leaf span
    // to appear, then walk up to the enclosing button.
    await waitFor(() => expect(screen.getByText('login-flow')).toBeTruthy())
    const switcherLeaf = screen.getByText('login-flow')
    const switcher = switcherLeaf.closest('button')!
    expect(switcher).toBeTruthy()
    // pointerDown triggers Radix's open handler; pointerUp on the menu item selects it.
    fireEvent.pointerDown(switcher, { button: 0, ctrlKey: false })
    await waitFor(() => screen.getByTestId('new-canvas-menu-item'))
    fireEvent.pointerUp(screen.getByTestId('new-canvas-menu-item'))
    await waitFor(() => screen.getByRole('dialog'))

    // Submit a slug — first call returns 409 with Problem Details title.
    const input = screen.getByPlaceholderText('e.g. design/login-flow')
    fireEvent.change(input, { target: { value: 'design/foo' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))

    await waitFor(() => {
      expect(screen.getByText('Canvas "design/foo" already exists')).toBeTruthy()
    })
    // Dialog must still be open after an error.
    expect(screen.getByRole('dialog')).toBeTruthy()

    // Second submit — 500 without title → fallback.
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    await waitFor(() => {
      expect(screen.getByText('Failed to create canvas.')).toBeTruthy()
    })
    // Sensitive server internals must never be exposed.
    expect(screen.queryByText(/internal/i)).toBeNull()
  })

  it('does not dispatch excalidraw:version_saved when POST /versions returns invalid schema', async () => {
    // The default beforeEach mock returns { ok: true } for POST /versions,
    // which does not match saveVersionResponseSchema (missing version.id, branchName, etc.).
    const versionSavedFired = vi.fn()
    window.addEventListener('excalidraw:version_saved', versionSavedFired)

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

    window.removeEventListener('excalidraw:version_saved', versionSavedFired)
  })

  it('dispatches excalidraw:version_saved when POST /versions returns a schema-conforming response', async () => {
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
    window.addEventListener('excalidraw:version_saved', versionSavedFired)

    renderTopBar()

    // Ctrl+S triggers saveVersion(''); fire on window with capture listener.
    fireEvent.keyDown(window, { ctrlKey: true, key: 's', code: 'KeyS' })

    // Wait for the event to be dispatched after the successful fetch + schema parse.
    await waitFor(() => {
      expect(versionSavedFired).toHaveBeenCalledTimes(1)
    })

    window.removeEventListener('excalidraw:version_saved', versionSavedFired)
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
    window.addEventListener('excalidraw:version_saved', versionSavedFired)

    renderTopBar({ getThumbnailBlob })

    fireEvent.keyDown(window, { ctrlKey: true, key: 's', code: 'KeyS' })

    // The version_saved event must still fire even when the thumbnail upload rejects.
    await waitFor(() => {
      expect(versionSavedFired).toHaveBeenCalledTimes(1)
    })

    window.removeEventListener('excalidraw:version_saved', versionSavedFired)
  })
})
