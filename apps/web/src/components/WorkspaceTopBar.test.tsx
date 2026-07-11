// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Stub heavy/irrelevant dependencies so the component mounts without network or browser-only requirements.
vi.mock('./HeaderBranchChip', () => ({ HeaderBranchChip: () => null }))
vi.mock('./HeaderSaveDot', () => ({ HeaderSaveDot: () => null }))
vi.mock('./VersionTimeline', () => ({ default: () => null }))
vi.mock('@/hooks/useDirtyState', () => ({ useDirtyState: () => ({ isDirty: false }) }))
vi.mock('@kamiazya/whiteboard-mcp/api-client', () => ({ apiFetch: vi.fn() }))

import { apiFetch } from '@kamiazya/whiteboard-mcp/api-client'
import { DaemonApiContext } from '@/contexts/DaemonApiContext'
import WorkspaceTopBar from './WorkspaceTopBar'

function mkNamesOk() {
  return new Response(JSON.stringify({ workspace: 'My WS', canvases: {}, pinned: [] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

function renderBar(overrides?: {
  onNavigateBack?: () => void
  onNavigateToCanvas?: (slug: string) => void
}) {
  // React 18 delegates events to the root container. Radix portals render into document.body,
  // which is a DOM sibling of the default test container. Using document.body as the React root
  // ensures portal events bubble to React's listener.
  return render(
    <WorkspaceTopBar
      workspaceId="ws_1"
      slug="canvas-a"
      canvases={[{ slug: 'canvas-a', updatedAt: '2026-04-23T00:00:00Z' }]}
      onEnterFullscreen={() => {}}
      onNavigateBack={overrides?.onNavigateBack ?? (() => {})}
      onNavigateToCanvas={overrides?.onNavigateToCanvas ?? (() => {})}
    />,
    { container: document.body },
  )
}

// Open the new canvas dialog through the canvas switcher dropdown.
// Radix DropdownMenuTrigger opens on pointerDown (not click); DropdownMenuItem selects on pointerUp.
async function openNewCanvasDialog() {
  // The canvas switcher trigger is the button that shows the current canvas slug.
  const switcher = screen.getByRole('button', { name: /canvas-a/i })
  // pointerDown with button=0 triggers Radix's internal open handler.
  fireEvent.pointerDown(switcher, { button: 0, ctrlKey: false })
  // After the dropdown opens, pointerUp on the item triggers onSelect → openNewCanvas().
  const item = await screen.findByTestId('new-canvas-menu-item')
  fireEvent.pointerUp(item)
  await screen.findByRole('dialog')
}

// Fill in the slug field and click Create.
async function submitSlug(slug: string) {
  const input = screen.getByPlaceholderText('e.g. design/login-flow')
  fireEvent.change(input, { target: { value: slug } })
  fireEvent.click(screen.getByRole('button', { name: 'Create' }))
}

beforeEach(() => {
  vi.mocked(apiFetch).mockImplementation(async (url) => {
    if (String(url).includes('/names')) return mkNamesOk()
    return new Response('{}', { status: 200 })
  })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('WorkspaceTopBar — new canvas error rendering (P-HTTP-005)', () => {
  it('shows Problem Details body.title when the server returns a 409 with title', async () => {
    vi.mocked(apiFetch).mockImplementation(async (url) => {
      if (String(url).includes('/names')) return mkNamesOk()
      // POST /canvases → 409 Problem Details
      return new Response(
        JSON.stringify({
          type: 'https://example.com/problems/canvas_conflict',
          title: 'Canvas already exists',
          status: 409,
        }),
        { status: 409, headers: { 'Content-Type': 'application/json' } },
      )
    })

    renderBar()
    await openNewCanvasDialog()
    await submitSlug('existing-canvas')

    await waitFor(() => {
      expect(screen.getByText('Canvas already exists')).toBeTruthy()
    })
  })

  it('shows fallback and never exposes body.message (P-HTTP-005)', async () => {
    vi.mocked(apiFetch).mockImplementation(async (url) => {
      if (String(url).includes('/names')) return mkNamesOk()
      // Legacy response with sensitive body.message
      return new Response(JSON.stringify({ message: '/Users/alice/secret-path/config.json' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      })
    })

    renderBar()
    await openNewCanvasDialog()
    await submitSlug('any-slug')

    await waitFor(() => {
      expect(screen.getByText('Failed to create canvas.')).toBeTruthy()
    })
    expect(screen.queryByText(/secret-path/i)).toBeNull()
    expect(screen.queryByText(/\/Users\//i)).toBeNull()
  })

  it('shows fallback and never exposes Error.message when fetch throws (P-HTTP-005)', async () => {
    vi.mocked(apiFetch).mockImplementation(async (url) => {
      if (String(url).includes('/names')) return mkNamesOk()
      throw new Error('Authorization: Bearer secret-token-XYZ')
    })

    renderBar()
    await openNewCanvasDialog()
    await submitSlug('any-slug')

    await waitFor(() => {
      expect(screen.getByText('Failed to create canvas.')).toBeTruthy()
    })
    expect(screen.queryByText(/secret-token/i)).toBeNull()
    expect(screen.queryByText(/Authorization/i)).toBeNull()
  })

  it('closes the dialog, shows no error, and calls onNavigateToCanvas with the entered slug on successful creation', async () => {
    vi.mocked(apiFetch).mockImplementation(async (url) => {
      if (String(url).includes('/names')) return mkNamesOk()
      return new Response('{}', { status: 200 })
    })
    const onNavigateToCanvas = vi.fn()

    renderBar({ onNavigateToCanvas })
    await openNewCanvasDialog()
    await submitSlug('new-canvas')

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull()
    })
    expect(screen.queryByText('Failed to create canvas.')).toBeNull()
    expect(onNavigateToCanvas).toHaveBeenCalledWith('new-canvas')
  })

  it('shows fallback when Problem Details title is a non-string (Zod parse guard)', async () => {
    vi.mocked(apiFetch).mockImplementation(async (url) => {
      if (String(url).includes('/names')) return mkNamesOk()
      // title is a number — invalid per problemDetailsErrorSchema; cast would let it through
      return new Response(JSON.stringify({ title: 42 }), {
        status: 422,
        headers: { 'Content-Type': 'application/json' },
      })
    })

    renderBar()
    await openNewCanvasDialog()
    await submitSlug('any-slug')

    await waitFor(() => {
      expect(screen.getByText('Failed to create canvas.')).toBeTruthy()
    })
    expect(screen.queryByText('42')).toBeNull()
  })

  it('shows the slug validation error inline without making a fetch request', async () => {
    renderBar()
    await openNewCanvasDialog()
    await submitSlug('bad/')

    await waitFor(() => {
      expect(screen.getByText(/enter a slug/i)).toBeTruthy()
    })
    // No POST request should have been made for invalid slugs.
    const calls = vi
      .mocked(apiFetch)
      .mock.calls.filter(
        ([url, init]) =>
          String(url).includes('/canvases') && (init as RequestInit | undefined)?.method === 'POST',
      )
    expect(calls).toHaveLength(0)
  })
})

describe('WorkspaceTopBar — router-free navigation callbacks', () => {
  it('calls onNavigateBack when the back button is clicked', () => {
    const onNavigateBack = vi.fn()
    renderBar({ onNavigateBack })

    fireEvent.click(screen.getByRole('button', { name: /back to canvas list/i }))

    expect(onNavigateBack).toHaveBeenCalledTimes(1)
  })
})

describe('WorkspaceTopBar — names fetch race (RED-first)', () => {
  it('does not let a stale in-flight /names response for a previous workspaceId overwrite the current workspace names', async () => {
    let resolveA!: (r: Response) => void
    let resolveB!: (r: Response) => void
    const pendingA = new Promise<Response>((resolve) => {
      resolveA = resolve
    })
    const pendingB = new Promise<Response>((resolve) => {
      resolveB = resolve
    })

    vi.mocked(apiFetch).mockImplementation(async (url) => {
      const u = String(url)
      if (u.includes('/workspaces/ws_a/names')) return pendingA
      if (u.includes('/workspaces/ws_b/names')) return pendingB
      return new Response('{}', { status: 200 })
    })

    const baseProps = {
      slug: 'shared-slug',
      canvases: [{ slug: 'shared-slug', updatedAt: '2026-04-23T00:00:00Z' }],
      onEnterFullscreen: () => {},
      onNavigateBack: () => {},
      onNavigateToCanvas: () => {},
    }

    const { rerender } = render(<WorkspaceTopBar workspaceId="ws_a" {...baseProps} />)
    rerender(<WorkspaceTopBar workspaceId="ws_b" {...baseProps} />)

    // The newer workspace's response arrives first; the stale ws_a response
    // arrives later and must not clobber it.
    resolveB(
      new Response(
        JSON.stringify({ workspace: 'B', canvases: { 'shared-slug': 'Fresh B' }, pinned: [] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    )
    await waitFor(() => {
      expect(screen.getByText('Fresh B')).toBeTruthy()
    })

    resolveA(
      new Response(
        JSON.stringify({ workspace: 'A', canvases: { 'shared-slug': 'Stale A' }, pinned: [] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    )

    await waitFor(() => {
      expect(screen.queryByText('Stale A')).toBeNull()
      expect(screen.getByText('Fresh B')).toBeTruthy()
    })
  })
})

describe('WorkspaceTopBar — canvas switcher overflow (RED-first)', () => {
  it('wraps the canvas list section in a scrollable max-height container so many canvases remain reachable', async () => {
    const many = Array.from({ length: 50 }, (_, i) => ({
      slug: `canvas-${i}`,
      updatedAt: '2026-04-23T00:00:00Z',
    }))
    renderBar()
    cleanup()
    render(
      <WorkspaceTopBar
        workspaceId="ws_1"
        slug="canvas-0"
        canvases={many}
        onEnterFullscreen={() => {}}
        onNavigateBack={() => {}}
        onNavigateToCanvas={() => {}}
      />,
    )

    const switcher = screen.getByRole('button', { name: /canvas-0/i })
    fireEvent.pointerDown(switcher, { button: 0, ctrlKey: false })
    await screen.findByTestId('new-canvas-menu-item')

    expect(document.querySelector('.max-h-\\[300px\\].overflow-y-auto')).toBeTruthy()
  })
})

describe('WorkspaceTopBar — saveVersion double-invoke race (RED-first)', () => {
  it('issues exactly one POST /versions when Cmd/Ctrl+S fires twice before the first request resolves', async () => {
    let resolvePost!: (r: Response) => void
    const deferred = new Promise<Response>((resolve) => {
      resolvePost = resolve
    })
    let postCount = 0
    vi.mocked(apiFetch).mockImplementation(async (url, init) => {
      const u = String(url)
      if (u.includes('/names')) return mkNamesOk()
      if (u.includes('/versions') && (init as RequestInit | undefined)?.method === 'POST') {
        postCount++
        return deferred
      }
      return new Response('{}', { status: 200 })
    })

    renderBar()

    // Fire both keydowns inside a single act() batch so no intermediate
    // render (and thus no updated `saving` closure) happens between them —
    // this is the actual shape of the race: two dispatches landing before
    // React has a chance to re-render with saving=true.
    act(() => {
      fireEvent.keyDown(window, { ctrlKey: true, key: 's', code: 'KeyS' })
      fireEvent.keyDown(window, { ctrlKey: true, key: 's', code: 'KeyS' })
    })

    resolvePost(new Response('{}', { status: 200 }))
    await waitFor(() => expect(postCount).toBe(1))
  })
})

describe('WorkspaceTopBar — new-canvas double submission (RED-first)', () => {
  it('issues exactly one POST /canvases when Enter is pressed twice before the first request resolves', async () => {
    let resolvePost!: (r: Response) => void
    const deferred = new Promise<Response>((resolve) => {
      resolvePost = resolve
    })
    let postCount = 0
    vi.mocked(apiFetch).mockImplementation(async (url, init) => {
      const u = String(url)
      if (u.includes('/names')) return mkNamesOk()
      if (u.includes('/canvases') && (init as RequestInit | undefined)?.method === 'POST') {
        postCount++
        return deferred
      }
      return new Response('{}', { status: 200 })
    })

    renderBar()
    await openNewCanvasDialog()
    const input = screen.getByPlaceholderText('e.g. design/login-flow')
    fireEvent.change(input, { target: { value: 'double-submit' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.keyDown(input, { key: 'Enter' })

    resolvePost(new Response('{}', { status: 200 }))
    await waitFor(() => expect(postCount).toBe(1))
  })
})

describe('WorkspaceTopBar — daemon-context-aware fetch (RED-first)', () => {
  it('with no DaemonApiContext provider mounted, loads names through the default apiFetch (fallback stays byte-identical)', async () => {
    renderBar()

    await waitFor(() => {
      expect(vi.mocked(apiFetch)).toHaveBeenCalledWith(
        expect.stringContaining('/api/workspaces/ws_1/names'),
      )
    })
  })

  it('with a DaemonApiContext provider mounted, loads names through the injected daemon fetch instead of apiFetch', async () => {
    const daemonFetch = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes('/names')) return mkNamesOk()
      return new Response('{}', { status: 200 })
    })

    render(
      <DaemonApiContext.Provider value={daemonFetch}>
        <WorkspaceTopBar
          workspaceId="ws_1"
          slug="canvas-a"
          canvases={[{ slug: 'canvas-a', updatedAt: '2026-04-23T00:00:00Z' }]}
          onEnterFullscreen={() => {}}
          onNavigateBack={() => {}}
          onNavigateToCanvas={() => {}}
        />
      </DaemonApiContext.Provider>,
      { container: document.body },
    )

    await waitFor(() => {
      expect(daemonFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/workspaces/ws_1/names'),
      )
    })
    expect(apiFetch).not.toHaveBeenCalled()
  })
})

describe('WorkspaceTopBar — ~400px collapse (RED-first)', () => {
  it('marks the exposed right-side action group and the More-actions kebab trigger with responsive collapse classes', () => {
    renderBar()

    const header = screen.getByRole('banner')
    expect(header.className).toContain('h-12')

    const exposedGroup = screen.getByTestId('topbar-right-actions-exposed')
    expect(exposedGroup.className).toContain('max-[400px]:hidden')

    const kebabTrigger = screen.getByRole('button', { name: 'More actions' })
    expect(kebabTrigger.className).toContain('min-[400px]:hidden')
  })
})
