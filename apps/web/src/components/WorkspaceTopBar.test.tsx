// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Stub heavy/irrelevant dependencies so the component mounts without network or browser-only requirements.
vi.mock('./HeaderBranchChip', () => ({
  HeaderBranchChip: () => <div data-testid="header-branch-chip" />,
}))
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
  onNavigateToCanvas?: (path: string) => void
  workspaces?: string[]
  onSwitchWorkspace?: (workspaceId: string) => void
}) {
  // React 18 delegates events to the root container. Radix portals render into document.body,
  // which is a DOM sibling of the default test container. Using document.body as the React root
  // ensures portal events bubble to React's listener.
  return render(
    <WorkspaceTopBar
      workspaceId="ws_1"
      path="canvas-a"
      canvases={[{ path: 'canvas-a', updatedAt: '2026-04-23T00:00:00Z' }]}
      onToggleFullscreen={() => {}}
      onNavigateBack={overrides?.onNavigateBack ?? (() => {})}
      onNavigateToCanvas={overrides?.onNavigateToCanvas ?? (() => {})}
      workspaces={overrides?.workspaces}
      onSwitchWorkspace={overrides?.onSwitchWorkspace}
    />,
    { container: document.body },
  )
}

// Open the new canvas dialog through the canvas switcher dropdown.
// Radix DropdownMenuTrigger opens on pointerDown (not click); DropdownMenuItem selects on pointerUp.

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

// ADR-0006 point 3: creation is not gated on a name. Selecting "New canvas…" derives a path from
// the loaded list (preserving the current group prefix) and POSTs immediately — no dialog.
// These are the red tests for that convergence; the dialog-era suites below are updated with it.
async function selectNewCanvasItem(switcherName: RegExp = /^Workspace:/i) {
  const switcher = screen.getByRole('button', { name: switcherName })
  fireEvent.pointerDown(switcher, { button: 0, ctrlKey: false })
  const item = await screen.findByTestId('new-canvas-menu-item')
  fireEvent.pointerUp(item)
}

function capturePosts() {
  const posts: Array<{ url: string; body: unknown }> = []
  vi.mocked(apiFetch).mockImplementation(async (url, init) => {
    if (String(url).includes('/names')) return mkNamesOk()
    if (init?.method === 'POST') {
      posts.push({ url: String(url), body: JSON.parse(String(init.body)) })
      return new Response(
        JSON.stringify({ path: (JSON.parse(String(init.body)) as { path: string }).path }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      )
    }
    return new Response('{}', { status: 200 })
  })
  return posts
}

describe('WorkspaceTopBar — immediate create (ADR-0006)', () => {
  it('POSTs a derived path on select and navigates — no dialog', async () => {
    const posts = capturePosts()
    const onNavigateToCanvas = vi.fn()
    renderBar({ onNavigateToCanvas })
    await selectNewCanvasItem()
    await waitFor(() => expect(onNavigateToCanvas).toHaveBeenCalledWith('untitled'))
    expect(posts).toEqual([expect.objectContaining({ body: { path: 'untitled' } })])
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('derives inside the current group: design/foo -> design/untitled', async () => {
    const posts = capturePosts()
    const onNavigateToCanvas = vi.fn()
    render(
      <WorkspaceTopBar
        workspaceId="ws_1"
        path="design/foo"
        canvases={[{ path: 'design/foo', updatedAt: '2026-04-23T00:00:00Z' }]}
        onToggleFullscreen={() => {}}
        onNavigateBack={() => {}}
        onNavigateToCanvas={onNavigateToCanvas}
      />,
      { container: document.body },
    )
    await selectNewCanvasItem()
    await waitFor(() => expect(onNavigateToCanvas).toHaveBeenCalledWith('design/untitled'))
    expect(posts[0]?.body).toEqual({ path: 'design/untitled' })
  })

  it('skips paths already in the list: untitled taken -> untitled-2', async () => {
    const posts = capturePosts()
    render(
      <WorkspaceTopBar
        workspaceId="ws_1"
        path="canvas-a"
        canvases={[
          { path: 'canvas-a', updatedAt: '2026-04-23T00:00:00Z' },
          { path: 'untitled', updatedAt: '2026-04-23T00:00:00Z' },
        ]}
        onToggleFullscreen={() => {}}
        onNavigateBack={() => {}}
        onNavigateToCanvas={() => {}}
      />,
      { container: document.body },
    )
    await selectNewCanvasItem()
    await waitFor(() => expect(posts.length).toBe(1))
    expect(posts[0]?.body).toEqual({ path: 'untitled-2' })
  })

  it('a failed create surfaces the Problem Details title in an alert — still no dialog', async () => {
    vi.mocked(apiFetch).mockImplementation(async (url) => {
      if (String(url).includes('/names')) return mkNamesOk()
      return new Response(
        JSON.stringify({ title: 'Canvas "untitled" already exists', status: 409 }),
        {
          status: 409,
          headers: { 'Content-Type': 'application/json' },
        },
      )
    })
    const onNavigateToCanvas = vi.fn()
    renderBar({ onNavigateToCanvas })
    await selectNewCanvasItem()
    expect((await screen.findByRole('alert')).textContent).toContain('already exists')
    expect(onNavigateToCanvas).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).toBeNull()
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
      path: 'shared-path',
      canvases: [{ path: 'shared-path', updatedAt: '2026-04-23T00:00:00Z' }],
      onToggleFullscreen: () => {},
      onNavigateBack: () => {},
      onNavigateToCanvas: () => {},
    }

    const { rerender } = render(<WorkspaceTopBar workspaceId="ws_a" {...baseProps} />)
    rerender(<WorkspaceTopBar workspaceId="ws_b" {...baseProps} />)

    // The newer workspace's response arrives first; the stale ws_a response
    // arrives later and must not clobber it.
    resolveB(
      new Response(
        JSON.stringify({ workspace: 'B', canvases: { 'shared-path': 'Fresh B' }, pinned: [] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    )
    // Observed in the switcher's list: the trigger names the workspace now,
    // but WHICH canvas name wins is exactly what this race guards.
    fireEvent.pointerDown(screen.getByRole('button', { name: /^Workspace:/i }), {
      button: 0,
      ctrlKey: false,
    })
    await waitFor(() => {
      expect(screen.getByText('Fresh B')).toBeTruthy()
    })

    resolveA(
      new Response(
        JSON.stringify({ workspace: 'A', canvases: { 'shared-path': 'Stale A' }, pinned: [] }),
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
      path: `canvas-${i}`,
      updatedAt: '2026-04-23T00:00:00Z',
    }))
    renderBar()
    cleanup()
    render(
      <WorkspaceTopBar
        workspaceId="ws_1"
        path="canvas-0"
        canvases={many}
        onToggleFullscreen={() => {}}
        onNavigateBack={() => {}}
        onNavigateToCanvas={() => {}}
      />,
    )

    const switcher = screen.getByRole('button', { name: /^Workspace:/i })
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

describe('WorkspaceTopBar — new-canvas double activation', () => {
  it('issues exactly one POST /canvases when New canvas… is activated twice before the first resolves', async () => {
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
    const switcher = screen.getByRole('button', { name: /^Workspace:/i })
    fireEvent.pointerDown(switcher, { button: 0, ctrlKey: false })
    const item = await screen.findByTestId('new-canvas-menu-item')
    fireEvent.pointerUp(item)
    fireEvent.pointerUp(item)
    await waitFor(() => expect(postCount).toBe(1))
    resolvePost(new Response(JSON.stringify({ path: 'untitled' }), { status: 200 }))
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
          path="canvas-a"
          canvases={[{ path: 'canvas-a', updatedAt: '2026-04-23T00:00:00Z' }]}
          onToggleFullscreen={() => {}}
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

// Each of these locks in that a specific call site was actually rewired to
// the injected daemonFetch (not just the /names effect covered above) — a
// regression that left one of these five still calling the stale
// module-level apiFetch would fall back to same-origin requests silently.
describe('WorkspaceTopBar — daemon-context-aware fetch, remaining call sites (RED-first)', () => {
  function renderBarWithDaemonFetch(overrides?: {
    getThumbnailBlob?: () => Promise<Blob | null>
    onNavigateToCanvas?: (path: string) => void
  }) {
    const daemonFetch = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes('/names')) return mkNamesOk()
      return new Response('{}', { status: 200 })
    })

    render(
      <DaemonApiContext.Provider value={daemonFetch}>
        <WorkspaceTopBar
          workspaceId="ws_1"
          path="canvas-a"
          canvases={[{ path: 'canvas-a', updatedAt: '2026-04-23T00:00:00Z' }]}
          onToggleFullscreen={() => {}}
          onNavigateBack={() => {}}
          onNavigateToCanvas={overrides?.onNavigateToCanvas ?? (() => {})}
          getThumbnailBlob={overrides?.getThumbnailBlob}
        />
      </DaemonApiContext.Provider>,
      { container: document.body },
    )

    return daemonFetch
  }

  function mkSaveVersionOk(id = 'v1') {
    return new Response(
      JSON.stringify({
        version: {
          id,
          path: 'canvas-a',
          createdAt: '2026-04-23T00:00:00Z',
          elementCount: 0,
          auto: false,
          hasThumbnail: false,
          branchName: 'main',
        },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )
  }

  it('quick-saves a version through the injected daemon fetch on Cmd/Ctrl+S', async () => {
    const daemonFetch = renderBarWithDaemonFetch()
    daemonFetch.mockImplementation(async (url: string | URL | Request) => {
      const u = String(url)
      if (u.includes('/names')) return mkNamesOk()
      if (u.includes('/versions')) return mkSaveVersionOk()
      return new Response('{}', { status: 200 })
    })

    act(() => {
      fireEvent.keyDown(window, { ctrlKey: true, key: 's', code: 'KeyS' })
    })

    await waitFor(() => {
      expect(daemonFetch).toHaveBeenCalledWith(
        expect.stringContaining('/versions'),
        expect.objectContaining({ method: 'POST' }),
      )
    })
    expect(apiFetch).not.toHaveBeenCalled()
  })

  it('uploads the version thumbnail through the injected daemon fetch after a successful save', async () => {
    const blob = new Blob(['x'], { type: 'image/png' })
    const daemonFetch = renderBarWithDaemonFetch({ getThumbnailBlob: async () => blob })
    daemonFetch.mockImplementation(async (url: string | URL | Request) => {
      const u = String(url)
      if (u.includes('/names')) return mkNamesOk()
      if (u.includes('/versions')) return mkSaveVersionOk('v1')
      return new Response('{}', { status: 200 })
    })

    act(() => {
      fireEvent.keyDown(window, { ctrlKey: true, key: 's', code: 'KeyS' })
    })

    await waitFor(() => {
      expect(daemonFetch).toHaveBeenCalledWith(
        expect.stringContaining('/versions/v1/thumbnail'),
        expect.objectContaining({ method: 'PUT' }),
      )
    })
    expect(apiFetch).not.toHaveBeenCalled()
  })

  it('commits a canvas rename through the injected daemon fetch', async () => {
    const daemonFetch = renderBarWithDaemonFetch()

    const canvasActions = screen.getByLabelText('Canvas actions')
    fireEvent.pointerDown(canvasActions, { button: 0, ctrlKey: false })
    const renameItem = await screen.findByText('Rename canvas')
    fireEvent.pointerUp(renameItem)
    const input = await screen.findByPlaceholderText('canvas-a')
    fireEvent.change(input, { target: { value: 'renamed' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => {
      expect(daemonFetch).toHaveBeenCalledWith(
        expect.stringContaining('/canvases/canvas-a/name'),
        expect.objectContaining({ method: 'PUT' }),
      )
    })
    expect(apiFetch).not.toHaveBeenCalled()
  })

  it('toggles pin through the injected daemon fetch', async () => {
    const daemonFetch = renderBarWithDaemonFetch()

    const switcher = screen.getByRole('button', { name: /^Workspace:/i })
    fireEvent.pointerDown(switcher, { button: 0, ctrlKey: false })
    const pinButton = await screen.findByRole('button', { name: 'Pin canvas' })
    fireEvent.click(pinButton)

    await waitFor(() => {
      expect(daemonFetch).toHaveBeenCalledWith(
        expect.stringContaining('/canvases/canvas-a/pin'),
        expect.objectContaining({ method: 'PUT' }),
      )
    })
    expect(apiFetch).not.toHaveBeenCalled()
  })

  it('creates a canvas through the injected daemon fetch', async () => {
    const onNavigateToCanvas = vi.fn()
    const daemonFetch = renderBarWithDaemonFetch({ onNavigateToCanvas })

    await selectNewCanvasItem()

    await waitFor(() => {
      expect(daemonFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/workspaces/ws_1/canvases'),
        expect.objectContaining({ method: 'POST' }),
      )
    })
    expect(apiFetch).not.toHaveBeenCalled()
  })
})

describe('WorkspaceTopBar — export affordance (RED-first)', () => {
  async function openCanvasActions() {
    const canvasActions = screen.getByLabelText('Canvas actions')
    fireEvent.pointerDown(canvasActions, { button: 0, ctrlKey: false })
    await screen.findByText('Rename canvas')
  }

  it('does not render export menu items when onExport is not provided', async () => {
    renderBar()
    await openCanvasActions()

    expect(screen.queryByText('Export as PNG')).toBeNull()
    expect(screen.queryByText('Export as SVG')).toBeNull()
  })

  it('invokes onExport with "png" from the Canvas actions menu and triggers a download', async () => {
    const blob = new Blob(['fake-png'], { type: 'image/png' })
    const onExport = vi.fn().mockResolvedValue(blob)
    const createObjectURL = vi.fn(() => 'blob:mock-url')
    const revokeObjectURL = vi.fn()
    vi.stubGlobal('URL', { ...URL, createObjectURL, revokeObjectURL })

    render(
      <WorkspaceTopBar
        workspaceId="ws_1"
        path="canvas-a"
        canvases={[{ path: 'canvas-a', updatedAt: '2026-04-23T00:00:00Z' }]}
        onToggleFullscreen={() => {}}
        onNavigateBack={() => {}}
        onNavigateToCanvas={() => {}}
        onExport={onExport}
      />,
      { container: document.body },
    )

    await openCanvasActions()
    const pngItem = await screen.findByText('Export as PNG')
    fireEvent.pointerUp(pngItem)

    await waitFor(() => expect(onExport).toHaveBeenCalledWith('png'))
    await waitFor(() => expect(createObjectURL).toHaveBeenCalledWith(blob))
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock-url')

    vi.unstubAllGlobals()
  })

  it('invokes onExport with "svg" from the Canvas actions menu', async () => {
    const blob = new Blob(['<svg></svg>'], { type: 'image/svg+xml' })
    const onExport = vi.fn().mockResolvedValue(blob)
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: vi.fn(() => 'blob:mock-url'),
      revokeObjectURL: vi.fn(),
    })

    render(
      <WorkspaceTopBar
        workspaceId="ws_1"
        path="canvas-a"
        canvases={[{ path: 'canvas-a', updatedAt: '2026-04-23T00:00:00Z' }]}
        onToggleFullscreen={() => {}}
        onNavigateBack={() => {}}
        onNavigateToCanvas={() => {}}
        onExport={onExport}
      />,
      { container: document.body },
    )

    await openCanvasActions()
    const svgItem = await screen.findByText('Export as SVG')
    fireEvent.pointerUp(svgItem)

    await waitFor(() => expect(onExport).toHaveBeenCalledWith('svg'))

    vi.unstubAllGlobals()
  })

  // The menu must only offer formats `onExport` (SceneExportFormat) can
  // actually produce — an entry outside that union is an affordance whose
  // every click fails.
  it('never renders a JSON/Excalidraw export menu item', async () => {
    const onExport = vi.fn().mockResolvedValue(new Blob())

    render(
      <WorkspaceTopBar
        workspaceId="ws_1"
        path="canvas-a"
        canvases={[{ path: 'canvas-a', updatedAt: '2026-04-23T00:00:00Z' }]}
        onToggleFullscreen={() => {}}
        onNavigateBack={() => {}}
        onNavigateToCanvas={() => {}}
        onExport={onExport}
      />,
      { container: document.body },
    )

    await openCanvasActions()
    expect(screen.getByText('Export as PNG')).toBeTruthy()
    expect(screen.getByText('Export as SVG')).toBeTruthy()
    expect(screen.queryByText(/json|excalidraw/i)).toBeNull()
  })

  it('does not throw when onExport resolves null (export unavailable)', async () => {
    const onExport = vi.fn().mockResolvedValue(null)

    render(
      <WorkspaceTopBar
        workspaceId="ws_1"
        path="canvas-a"
        canvases={[{ path: 'canvas-a', updatedAt: '2026-04-23T00:00:00Z' }]}
        onToggleFullscreen={() => {}}
        onNavigateBack={() => {}}
        onNavigateToCanvas={() => {}}
        onExport={onExport}
      />,
      { container: document.body },
    )

    await openCanvasActions()
    const pngItem = await screen.findByText('Export as PNG')
    fireEvent.pointerUp(pngItem)

    await waitFor(() => expect(onExport).toHaveBeenCalledWith('png'))
  })

  it('surfaces a visible error when onExport resolves null (export unavailable)', async () => {
    const onExport = vi.fn().mockResolvedValue(null)

    render(
      <WorkspaceTopBar
        workspaceId="ws_1"
        path="canvas-a"
        canvases={[{ path: 'canvas-a', updatedAt: '2026-04-23T00:00:00Z' }]}
        onToggleFullscreen={() => {}}
        onNavigateBack={() => {}}
        onNavigateToCanvas={() => {}}
        onExport={onExport}
      />,
      { container: document.body },
    )

    await openCanvasActions()
    const pngItem = await screen.findByText('Export as PNG')
    fireEvent.pointerUp(pngItem)

    await waitFor(() => expect(onExport).toHaveBeenCalledWith('png'))
    expect((await screen.findByRole('alert')).textContent).toMatch(/export/i)
  })

  it('surfaces a visible error when onExport rejects', async () => {
    const onExport = vi.fn().mockRejectedValue(new Error('boom'))

    render(
      <WorkspaceTopBar
        workspaceId="ws_1"
        path="canvas-a"
        canvases={[{ path: 'canvas-a', updatedAt: '2026-04-23T00:00:00Z' }]}
        onToggleFullscreen={() => {}}
        onNavigateBack={() => {}}
        onNavigateToCanvas={() => {}}
        onExport={onExport}
      />,
      { container: document.body },
    )

    await openCanvasActions()
    const pngItem = await screen.findByText('Export as PNG')
    fireEvent.pointerUp(pngItem)

    await waitFor(() => expect(onExport).toHaveBeenCalledWith('png'))
    expect((await screen.findByRole('alert')).textContent).toMatch(/export/i)
  })

  // RED-first: Firefox (and per the HTML spec generally) does not start a
  // download from a synthetic .click() on an <a> that was never attached to
  // the document — the exact "looks like it worked but does nothing" defect
  // this export affordance exists to avoid. Assert the anchor is actually in
  // the document at click time, and removed again afterward.
  it('attaches the download anchor to the document before clicking it, then removes it', async () => {
    const blob = new Blob(['fake-png'], { type: 'image/png' })
    const onExport = vi.fn().mockResolvedValue(blob)
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: vi.fn(() => 'blob:mock-url'),
      revokeObjectURL: vi.fn(),
    })

    let anchorConnectedAtClick: boolean | null = null
    const realCreateElement = document.createElement.bind(document)
    const createElementSpy = vi
      .spyOn(document, 'createElement')
      .mockImplementation((tagName: string, ...rest) => {
        const el = realCreateElement(tagName, ...rest)
        if (tagName === 'a') {
          const realClick = el.click.bind(el)
          el.click = () => {
            anchorConnectedAtClick = el.isConnected
            realClick()
          }
        }
        return el
      })

    render(
      <WorkspaceTopBar
        workspaceId="ws_1"
        path="canvas-a"
        canvases={[{ path: 'canvas-a', updatedAt: '2026-04-23T00:00:00Z' }]}
        onToggleFullscreen={() => {}}
        onNavigateBack={() => {}}
        onNavigateToCanvas={() => {}}
        onExport={onExport}
      />,
      { container: document.body },
    )

    await openCanvasActions()
    const pngItem = await screen.findByText('Export as PNG')
    fireEvent.pointerUp(pngItem)

    await waitFor(() => expect(onExport).toHaveBeenCalledWith('png'))
    await waitFor(() => expect(anchorConnectedAtClick).toBe(true))

    createElementSpy.mockRestore()
    vi.unstubAllGlobals()
  })
})

describe('WorkspaceTopBar — ~400px collapse (RED-first)', () => {
  it('marks the exposed right-side action group and the More-actions kebab trigger with responsive collapse classes', () => {
    renderBar()

    const header = screen.getByRole('banner')
    expect(header.className).toContain('h-12')

    const exposedGroup = screen.getByTestId('topbar-right-actions-exposed')
    expect(exposedGroup.className).toContain('max-[400px]:hidden')

    const kebabTrigger = screen.getByRole('button', { name: 'View options' })
    expect(kebabTrigger.className).toContain('min-[400px]:hidden')
  })
})

describe('WorkspaceTopBar — optional daemon-context props (RED-first)', () => {
  it('hides the back button when onNavigateBack is omitted', () => {
    render(
      <WorkspaceTopBar
        workspaceId="ws_1"
        path="canvas-a"
        canvases={[{ path: 'canvas-a', updatedAt: '2026-04-23T00:00:00Z' }]}
        onNavigateToCanvas={() => {}}
      />,
      { container: document.body },
    )
    expect(screen.queryByLabelText('Back to canvas list')).toBeNull()
  })

  it('hides the fullscreen button when onToggleFullscreen is omitted', () => {
    render(
      <WorkspaceTopBar
        workspaceId="ws_1"
        path="canvas-a"
        canvases={[{ path: 'canvas-a', updatedAt: '2026-04-23T00:00:00Z' }]}
        onNavigateBack={() => {}}
        onNavigateToCanvas={() => {}}
      />,
      { container: document.body },
    )
    expect(screen.queryByLabelText('Fullscreen')).toBeNull()
  })

  it('hides HeaderSaveDot when capabilities.versions is false', () => {
    render(
      <WorkspaceTopBar
        workspaceId="ws_1"
        path="canvas-a"
        canvases={[{ path: 'canvas-a', updatedAt: '2026-04-23T00:00:00Z' }]}
        onNavigateBack={() => {}}
        onToggleFullscreen={() => {}}
        onNavigateToCanvas={() => {}}
        capabilities={{ versions: false, branches: true, merge: true }}
      />,
      { container: document.body },
    )
    expect(screen.queryByTestId('header-save-dot')).toBeNull()
    // The version-history trigger lives in the canvas HistoryCluster now,
    // never in the top bar.
    expect(screen.queryByRole('button', { name: /history/i })).toBeNull()
  })

  it('never issues a POST /versions on Cmd/Ctrl+S when capabilities.versions is false', async () => {
    let postCount = 0
    vi.mocked(apiFetch).mockImplementation(async (url, init) => {
      const u = String(url)
      if (u.includes('/names')) return mkNamesOk()
      if (u.includes('/versions') && (init as RequestInit | undefined)?.method === 'POST') {
        postCount++
      }
      return new Response('{}', { status: 200 })
    })

    render(
      <WorkspaceTopBar
        workspaceId="ws_1"
        path="canvas-a"
        canvases={[{ path: 'canvas-a', updatedAt: '2026-04-23T00:00:00Z' }]}
        onNavigateBack={() => {}}
        onToggleFullscreen={() => {}}
        onNavigateToCanvas={() => {}}
        capabilities={{ versions: false, branches: true, merge: true }}
      />,
      { container: document.body },
    )

    act(() => {
      fireEvent.keyDown(window, { ctrlKey: true, key: 's', code: 'KeyS' })
    })
    await Promise.resolve()
    expect(postCount).toBe(0)
  })

  it('hides HeaderBranchChip when capabilities.branches is false', () => {
    render(
      <WorkspaceTopBar
        workspaceId="ws_1"
        path="canvas-a"
        canvases={[{ path: 'canvas-a', updatedAt: '2026-04-23T00:00:00Z' }]}
        onNavigateBack={() => {}}
        onToggleFullscreen={() => {}}
        onNavigateToCanvas={() => {}}
        capabilities={{ versions: true, branches: false, merge: true }}
      />,
      { container: document.body },
    )
    // HeaderBranchChip is stubbed to render null, so absence is confirmed by
    // the fact mounting never throws when the chip's props (workspaceId/path)
    // would otherwise be required — the real assertion lives in the
    // conditional render below via a spy-friendly mock override.
    expect(screen.queryByTestId('header-branch-chip')).toBeNull()
  })
})

describe('WorkspaceTopBar — workspaceId URL encoding', () => {
  it('percent-encodes a workspaceId with reserved characters in the names fetch', async () => {
    render(
      <WorkspaceTopBar
        workspaceId="ws 1#x"
        path="canvas-a"
        canvases={[{ path: 'canvas-a', updatedAt: '2026-04-23T00:00:00Z' }]}
        onToggleFullscreen={() => {}}
        onNavigateBack={() => {}}
        onNavigateToCanvas={() => {}}
      />,
      { container: document.body },
    )
    await waitFor(() => {
      const namesCall = vi
        .mocked(apiFetch)
        .mock.calls.find((call) => String(call[0]).includes('/names'))
      expect(namesCall).toBeTruthy()
      expect(String(namesCall?.[0])).toContain(
        `/api/workspaces/${encodeURIComponent('ws 1#x')}/names`,
      )
    })
  })
})

describe('WorkspaceTopBar — copy canvas URL feedback (RED-first)', () => {
  function openCanvasActionsMenu() {
    const canvasActions = screen.getByLabelText('Canvas actions')
    fireEvent.pointerDown(canvasActions, { button: 0, ctrlKey: false })
    return screen.findByText('Copy canvas URL')
  }

  afterEach(() => {
    // @ts-expect-error -- test-only cleanup of a property defined per-test below
    delete navigator.clipboard
  })

  it('shows a "Copied!" confirmation after a successful copy, then reverts', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    })

    try {
      renderBar()
      const copyItem = await openCanvasActionsMenu()
      fireEvent.pointerUp(copyItem)

      await vi.waitFor(() => expect(screen.getByText('Copied!')).toBeTruthy())
      expect(writeText).toHaveBeenCalledWith(expect.stringContaining('/w/ws_1/canvas/canvas-a'))
      // Screen-reader-visible announcement, independent of the visible label.
      expect(screen.getByRole('status', { name: 'Copy status' }).textContent).toContain(
        'Canvas URL copied to clipboard.',
      )

      await act(async () => {
        vi.advanceTimersByTime(2000)
      })
      await vi.waitFor(() => expect(screen.queryByText('Copied!')).toBeNull())
      expect(screen.getByText('Copy canvas URL')).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })

  it('surfaces a rejected clipboard write as a visible error instead of a false success', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('Clipboard permission denied'))
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    })

    renderBar()
    const copyItem = await openCanvasActionsMenu()
    fireEvent.pointerUp(copyItem)

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain("Couldn't copy automatically")
    expect(screen.queryByText('Copied!')).toBeNull()
    expect(screen.getByRole('status', { name: 'Copy status' }).textContent).toContain(
      "Couldn't copy the canvas URL automatically.",
    )

    // Fallback: the URL is still available as selectable text.
    const fallbackInput = screen.getByLabelText('Canvas URL') as HTMLInputElement
    expect(fallbackInput.value).toContain('/w/ws_1/canvas/canvas-a')
    expect(fallbackInput.readOnly).toBe(true)
  })

  it('does not nest the live-region announcement or the error fallback inside the role="menu" container', async () => {
    // WAI-ARIA menu pattern: an element with role="menu" may only own
    // menuitem/menuitemcheckbox/menuitemradio/group descendants. A
    // role="status"/role="alert" live region nested directly inside it
    // violates that contract (axe/AccessLint: aria-required-children) even
    // though the text itself is never focusable or selectable via arrow keys.
    const writeText = vi.fn().mockRejectedValue(new Error('Clipboard permission denied'))
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    })

    renderBar()
    const copyItem = await openCanvasActionsMenu()
    fireEvent.pointerUp(copyItem)

    const alert = await screen.findByRole('alert')
    const status = screen.getByRole('status', { name: 'Copy status' })
    const menu = screen.getByRole('menu')

    expect(menu.contains(alert)).toBe(false)
    expect(menu.contains(status)).toBe(false)
  })
})

describe('WorkspaceTopBar — dataMode="local"', () => {
  it('never calls the daemon fetch: mount, open the canvas switcher, and open the actions area', async () => {
    render(
      <WorkspaceTopBar
        dataMode="local"
        workspaceId="ws_1"
        path="canvas-a"
        canvases={[
          { path: 'canvas-a', updatedAt: '2026-04-23T00:00:00Z', name: 'Canvas A' },
          { path: 'canvas-b', updatedAt: '2026-04-22T00:00:00Z', name: 'Canvas B' },
        ]}
        onToggleFullscreen={() => {}}
        onNavigateToCanvas={() => {}}
        onRenameCanvas={() => {}}
        onCreateCanvas={() => {}}
      />,
      { container: document.body },
    )

    // Open the canvas switcher dropdown.
    const switcher = screen.getByRole('button', { name: /^Workspace:/i })
    fireEvent.pointerDown(switcher, { button: 0, ctrlKey: false })
    await screen.findByTestId('new-canvas-menu-item')

    expect(apiFetch).not.toHaveBeenCalled()
  })

  it('uses canvases[].name for display instead of fetching /names', async () => {
    render(
      <WorkspaceTopBar
        dataMode="local"
        workspaceId="ws_1"
        path="canvas-a"
        canvases={[{ path: 'canvas-a', updatedAt: '2026-04-23T00:00:00Z', name: 'Custom title' }]}
        onToggleFullscreen={() => {}}
        onNavigateToCanvas={() => {}}
        onRenameCanvas={() => {}}
        onCreateCanvas={() => {}}
      />,
      { container: document.body },
    )

    // The trigger names the WORKSPACE now, so the resolved canvas name is
    // observed where it is still shown: the switcher's own list.
    fireEvent.pointerDown(screen.getByRole('button', { name: /^Workspace:/i }), {
      button: 0,
      ctrlKey: false,
    })
    expect(await screen.findByText('Custom title')).not.toBeNull()
    expect(apiFetch).not.toHaveBeenCalled()
  })

  it('routes "New canvas…" to onCreateCanvas instead of opening the path dialog / POSTing', async () => {
    const onCreateCanvas = vi.fn().mockResolvedValue(undefined)
    render(
      <WorkspaceTopBar
        dataMode="local"
        workspaceId="ws_1"
        path="canvas-a"
        canvases={[{ path: 'canvas-a', updatedAt: '2026-04-23T00:00:00Z', name: 'Canvas A' }]}
        onToggleFullscreen={() => {}}
        onNavigateToCanvas={() => {}}
        onRenameCanvas={() => {}}
        onCreateCanvas={onCreateCanvas}
      />,
      { container: document.body },
    )

    const switcher = screen.getByRole('button', { name: /^Workspace:/i })
    fireEvent.pointerDown(switcher, { button: 0, ctrlKey: false })
    const item = await screen.findByTestId('new-canvas-menu-item')
    fireEvent.pointerUp(item)

    await waitFor(() => expect(onCreateCanvas).toHaveBeenCalledTimes(1))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(apiFetch).not.toHaveBeenCalled()
  })

  it('commits a local-mode rename through onRenameCanvas and closes the rename input', async () => {
    const onRenameCanvas = vi.fn().mockResolvedValue(undefined)
    render(
      <WorkspaceTopBar
        dataMode="local"
        workspaceId="ws_1"
        path="canvas-a"
        canvases={[{ path: 'canvas-a', updatedAt: '2026-04-23T00:00:00Z', name: 'Canvas A' }]}
        onToggleFullscreen={() => {}}
        onNavigateToCanvas={() => {}}
        onRenameCanvas={onRenameCanvas}
        onCreateCanvas={() => {}}
      />,
      { container: document.body },
    )

    const canvasActions = screen.getByLabelText('Canvas actions')
    fireEvent.pointerDown(canvasActions, { button: 0, ctrlKey: false })
    const renameItem = await screen.findByText('Rename canvas')
    fireEvent.pointerUp(renameItem)
    // Query and edit synchronously in the same tick as the pointerUp that
    // mounts this input (no intervening `await`) — Radix asynchronously
    // returns focus to the dropdown trigger after the menu closes, which
    // races with (and can steal) this input's `autoFocus`. Editing before
    // yielding to that gap keeps the interaction deterministic.
    const input = screen.getByPlaceholderText('canvas-a')
    fireEvent.change(input, { target: { value: 'renamed canvas' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => expect(onRenameCanvas).toHaveBeenCalledWith('renamed canvas'))
    await waitFor(() => expect(screen.queryByPlaceholderText('canvas-a')).toBeNull())
    expect(apiFetch).not.toHaveBeenCalled()
  })

  it('surfaces a rejected onRenameCanvas as a visible error and keeps the rename input open', async () => {
    const onRenameCanvas = vi.fn().mockRejectedValue(new Error('boom'))
    render(
      <WorkspaceTopBar
        dataMode="local"
        workspaceId="ws_1"
        path="canvas-a"
        canvases={[{ path: 'canvas-a', updatedAt: '2026-04-23T00:00:00Z', name: 'Canvas A' }]}
        onToggleFullscreen={() => {}}
        onNavigateToCanvas={() => {}}
        onRenameCanvas={onRenameCanvas}
        onCreateCanvas={() => {}}
      />,
      { container: document.body },
    )

    const canvasActions = screen.getByLabelText('Canvas actions')
    fireEvent.pointerDown(canvasActions, { button: 0, ctrlKey: false })
    const renameItem = await screen.findByText('Rename canvas')
    fireEvent.pointerUp(renameItem)
    // See the comment in the success-path test above: edit synchronously,
    // in the same tick, to avoid Radix's async focus-return-to-trigger
    // blurring the input first.
    const input = screen.getByPlaceholderText('canvas-a')
    fireEvent.change(input, { target: { value: 'renamed canvas' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => expect(onRenameCanvas).toHaveBeenCalledWith('renamed canvas'))
    expect((await screen.findByRole('alert')).textContent).toContain('Failed to rename canvas.')
    // The input stays mounted so the user can retry without retyping.
    expect(screen.queryByPlaceholderText('canvas-a')).not.toBeNull()
  })

  it('surfaces a rejected onCreateCanvas as a visible error since local mode has no path dialog', async () => {
    const onCreateCanvas = vi.fn().mockRejectedValue(new Error('boom'))
    render(
      <WorkspaceTopBar
        dataMode="local"
        workspaceId="ws_1"
        path="canvas-a"
        canvases={[{ path: 'canvas-a', updatedAt: '2026-04-23T00:00:00Z', name: 'Canvas A' }]}
        onToggleFullscreen={() => {}}
        onNavigateToCanvas={() => {}}
        onRenameCanvas={() => {}}
        onCreateCanvas={onCreateCanvas}
      />,
      { container: document.body },
    )

    const switcher = screen.getByRole('button', { name: /^Workspace:/i })
    fireEvent.pointerDown(switcher, { button: 0, ctrlKey: false })
    const item = await screen.findByTestId('new-canvas-menu-item')
    fireEvent.pointerUp(item)

    await waitFor(() => expect(onCreateCanvas).toHaveBeenCalledTimes(1))
    expect((await screen.findByRole('alert')).textContent).toContain('Failed to create canvas.')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(apiFetch).not.toHaveBeenCalled()
  })

  it('gives the rename input an accessible name and isolates it from document-level shortcut listeners', async () => {
    render(
      <WorkspaceTopBar
        dataMode="local"
        workspaceId="ws_1"
        path="canvas-a"
        canvases={[{ path: 'canvas-a', updatedAt: '2026-04-23T00:00:00Z', name: 'Canvas A' }]}
        onToggleFullscreen={() => {}}
        onNavigateToCanvas={() => {}}
        onRenameCanvas={() => {}}
        onCreateCanvas={() => {}}
      />,
      { container: document.body },
    )

    const canvasActions = screen.getByLabelText('Canvas actions')
    fireEvent.pointerDown(canvasActions, { button: 0, ctrlKey: false })
    const renameItem = await screen.findByText('Rename canvas')
    fireEvent.pointerUp(renameItem)

    const input = screen.getByRole('textbox', { name: 'Canvas title' })

    const docKeydown = vi.fn()
    const docKeyup = vi.fn()
    document.addEventListener('keydown', docKeydown)
    document.addEventListener('keyup', docKeyup)
    try {
      fireEvent.keyDown(input, { key: 'Delete' })
      fireEvent.keyUp(input, { key: 'Delete' })
    } finally {
      document.removeEventListener('keydown', docKeydown)
      document.removeEventListener('keyup', docKeyup)
    }

    expect(docKeydown).not.toHaveBeenCalled()
    expect(docKeyup).not.toHaveBeenCalled()
  })

  it('guards against a second in-flight onCreateCanvas call when "New canvas…" is invoked twice before the first resolves', async () => {
    let resolveCreate: () => void = () => {}
    const onCreateCanvas = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveCreate = resolve
        }),
    )
    render(
      <WorkspaceTopBar
        dataMode="local"
        workspaceId="ws_1"
        path="canvas-a"
        canvases={[{ path: 'canvas-a', updatedAt: '2026-04-23T00:00:00Z', name: 'Canvas A' }]}
        onToggleFullscreen={() => {}}
        onNavigateToCanvas={() => {}}
        onRenameCanvas={() => {}}
        onCreateCanvas={onCreateCanvas}
      />,
      { container: document.body },
    )

    const switcher = screen.getByRole('button', { name: /^Workspace:/i })
    fireEvent.pointerDown(switcher, { button: 0, ctrlKey: false })
    const item = await screen.findByTestId('new-canvas-menu-item')
    fireEvent.pointerUp(item)

    expect(onCreateCanvas).toHaveBeenCalledTimes(1)

    // Reopen the switcher and fire "New canvas…" again before the first
    // onCreateCanvas call resolves — the newCanvasBusy guard must skip this
    // second invocation instead of minting a duplicate canvas.
    fireEvent.pointerDown(switcher, { button: 0, ctrlKey: false })
    const item2 = await screen.findByTestId('new-canvas-menu-item')
    fireEvent.pointerUp(item2)

    expect(onCreateCanvas).toHaveBeenCalledTimes(1)

    resolveCreate()
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
    expect(onCreateCanvas).toHaveBeenCalledTimes(1)
  })

  it('announces the in-flight create through a region that was already there', async () => {
    let resolveCreate: () => void = () => {}
    const onCreateCanvas = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveCreate = resolve
        }),
    )
    render(
      <WorkspaceTopBar
        dataMode="local"
        workspaceId="ws_1"
        path="canvas-a"
        canvases={[{ path: 'canvas-a', updatedAt: '2026-04-23T00:00:00Z', name: 'Canvas A' }]}
        onToggleFullscreen={() => {}}
        onNavigateToCanvas={() => {}}
        onRenameCanvas={() => {}}
        onCreateCanvas={onCreateCanvas}
      />,
      { container: document.body },
    )

    // Present and silent BEFORE anything happens: a polite region that
    // arrives carrying its first message is announced unreliably.
    const region = screen.getByRole('status', { name: 'New canvas status' })
    expect(region.textContent).toBe('')

    const switcher = screen.getByRole('button', { name: /^Workspace:/i })
    fireEvent.pointerDown(switcher, { button: 0, ctrlKey: false })
    fireEvent.pointerUp(await screen.findByTestId('new-canvas-menu-item'))

    await waitFor(() => expect(region.textContent).toBe('Creating canvas…'))
    // The SAME element, not a replacement — this is what makes the update an
    // announcement rather than an insertion.
    expect(screen.getByRole('status', { name: 'New canvas status' })).toBe(region)

    resolveCreate()
    await waitFor(() => expect(region.textContent).toBe(''))
  })

  it('never renders the daemon-only thumbnail <img> or the pin affordance in the canvas switcher', async () => {
    render(
      <WorkspaceTopBar
        dataMode="local"
        workspaceId="ws_1"
        path="canvas-a"
        canvases={[
          { path: 'canvas-a', updatedAt: '2026-04-23T00:00:00Z', name: 'Canvas A' },
          { path: 'canvas-b', updatedAt: '2026-04-22T00:00:00Z', name: 'Canvas B' },
        ]}
        onToggleFullscreen={() => {}}
        onNavigateToCanvas={() => {}}
        onRenameCanvas={() => {}}
        onCreateCanvas={() => {}}
      />,
      { container: document.body },
    )

    const switcher = screen.getByRole('button', { name: /^Workspace:/i })
    fireEvent.pointerDown(switcher, { button: 0, ctrlKey: false })
    await screen.findByTestId('new-canvas-menu-item')

    expect(document.querySelectorAll('img[src*="/api/"]').length).toBe(0)
    expect(screen.queryByRole('button', { name: /pin canvas/i })).toBeNull()
  })
})

describe('WorkspaceTopBar — mountedRef survives StrictMode dev double-invoke', () => {
  it('closes the rename input after a successful daemon rename under StrictMode', async () => {
    vi.mocked(apiFetch).mockImplementation(async (url, init) => {
      if (String(url).includes('/names')) return mkNamesOk()
      if (String(url).includes('/name') && init?.method === 'PUT') {
        return new Response(JSON.stringify({ workspace: 'My WS', canvases: {}, pinned: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response('{}', { status: 200 })
    })

    render(
      <StrictMode>
        <WorkspaceTopBar
          workspaceId="ws_1"
          path="canvas-a"
          canvases={[{ path: 'canvas-a', updatedAt: '2026-04-23T00:00:00Z' }]}
          onToggleFullscreen={() => {}}
          onNavigateBack={() => {}}
          onNavigateToCanvas={() => {}}
        />
      </StrictMode>,
      { container: document.body },
    )

    const actionsButton = screen.getByRole('button', { name: 'Canvas actions' })
    fireEvent.pointerDown(actionsButton, { button: 0, ctrlKey: false })
    const renameItem = await screen.findByText('Rename canvas')
    fireEvent.pointerUp(renameItem)

    const input = await screen.findByLabelText('Canvas title')
    fireEvent.change(input, { target: { value: 'Renamed Canvas' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    // Under React StrictMode's dev-only double-invoke (setup -> cleanup ->
    // setup), a mountedRef that never re-arms on setup would stay stuck
    // false, so the rename completion path (gated on mountedRef.current)
    // would never close the input.
    await waitFor(() => {
      expect(screen.queryByLabelText('Canvas title')).toBeNull()
    })
  })
})

describe('WorkspaceTopBar — workspace picker (RED-first)', () => {
  async function openSwitcher() {
    const switcher = screen.getByRole('button', { name: /^Workspace:/i })
    fireEvent.pointerDown(switcher, { button: 0, ctrlKey: false })
    await screen.findByTestId('new-canvas-menu-item')
  }

  it('renders a Workspaces section above the canvases section, one menuitemradio per workspace, current checked', async () => {
    renderBar({ workspaces: ['ws_1', 'w2'], onSwitchWorkspace: () => {} })
    await openSwitcher()

    const label = screen.getByText('Workspaces')
    const items = screen.getAllByRole('menuitemradio')
    expect(items.map((item) => item.textContent)).toEqual(['ws_1', 'w2'])
    expect(items[0]?.getAttribute('aria-checked')).toBe('true')
    expect(items[1]?.getAttribute('aria-checked')).toBe('false')

    // "Above the canvases section": the label precedes the canvas entry in document order.
    const canvasEntry = screen.getByText('canvas-a')
    expect(
      label.compareDocumentPosition(canvasEntry) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
  })

  it('marks the current workspace with a visible non-color indicator (ItemIndicator check icon), and no indicator on the others', async () => {
    renderBar({ workspaces: ['ws_1', 'w2'], onSwitchWorkspace: () => {} })
    await openSwitcher()

    const items = screen.getAllByRole('menuitemradio')
    expect(items[0]?.querySelector('svg')).not.toBeNull()
    expect(items[1]?.querySelector('svg')).toBeNull()
  })

  it('clicking another workspace calls onSwitchWorkspace exactly once with its id and closes the menu', async () => {
    const onSwitchWorkspace = vi.fn()
    renderBar({ workspaces: ['ws_1', 'w2'], onSwitchWorkspace })
    await openSwitcher()

    const w2Item = screen.getByRole('menuitemradio', { name: 'w2' })
    fireEvent.pointerUp(w2Item)

    await waitFor(() => expect(onSwitchWorkspace).toHaveBeenCalledTimes(1))
    expect(onSwitchWorkspace).toHaveBeenCalledWith('w2')
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
  })

  it('clicking the current workspace never calls onSwitchWorkspace', async () => {
    const onSwitchWorkspace = vi.fn()
    renderBar({ workspaces: ['ws_1', 'w2'], onSwitchWorkspace })
    await openSwitcher()

    const currentItem = screen.getByRole('menuitemradio', { name: 'ws_1' })
    fireEvent.pointerUp(currentItem)

    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
    expect(onSwitchWorkspace).not.toHaveBeenCalled()
  })

  it('renders no Workspaces section when workspaces/onSwitchWorkspace are absent — every pre-existing caller stays byte-identical', async () => {
    renderBar()
    await openSwitcher()

    expect(screen.queryByText('Workspaces')).toBeNull()
    expect(screen.queryByRole('menuitemradio')).toBeNull()
  })

  it('renders no Workspaces section with a single workspace, and hides it while a canvas search is active', async () => {
    const onSwitchWorkspace = vi.fn()
    renderBar({ workspaces: ['ws_1'], onSwitchWorkspace })
    await openSwitcher()
    expect(screen.queryByText('Workspaces')).toBeNull()

    cleanup()

    renderBar({ workspaces: ['ws_1', 'w2'], onSwitchWorkspace })
    await openSwitcher()
    expect(screen.getByText('Workspaces')).toBeTruthy()

    fireEvent.change(screen.getByPlaceholderText('Switch canvas…'), {
      target: { value: 'canvas-a' },
    })
    expect(screen.queryByText('Workspaces')).toBeNull()
  })
})

describe('WorkspaceTopBar — titleSlot (merged canvas row)', () => {
  it('renders the page-provided title segment inside the header', () => {
    render(
      <WorkspaceTopBar
        workspaceId="ws_1"
        path="canvas-a"
        canvases={[{ path: 'canvas-a', updatedAt: '2026-04-23T00:00:00Z' }]}
        onToggleFullscreen={() => {}}
        onNavigateBack={() => {}}
        onNavigateToCanvas={() => {}}
        titleSlot={<input aria-label="Merged title" readOnly value="t" />}
      />,
      { container: document.body },
    )
    const header = screen.getByRole('banner')
    expect(header.contains(screen.getByLabelText('Merged title'))).toBe(true)
  })
})
