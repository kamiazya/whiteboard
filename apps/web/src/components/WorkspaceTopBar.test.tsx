// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Stub heavy/irrelevant dependencies so the component mounts without network or browser-only requirements.
vi.mock('./HeaderBranchChip', () => ({
  HeaderBranchChip: () => <div data-testid="header-branch-chip" />,
}))
vi.mock('./HeaderVersionDot', () => ({ HeaderVersionDot: () => null }))
vi.mock('./VersionTimeline', () => ({ default: () => null }))
vi.mock('@/hooks/useDirtyState', () => ({ useDirtyState: () => ({ isDirty: false }) }))
vi.mock('@kamiazya/whiteboard-mcp/api-client', () => ({ apiFetch: vi.fn() }))

import { apiFetch } from '@kamiazya/whiteboard-mcp/api-client'
import { DaemonApiContext } from '@/contexts/DaemonApiContext'
import WorkspaceTopBar, { type DocumentIdentity } from './WorkspaceTopBar'

function mkNamesOk() {
  return new Response(JSON.stringify({ workspace: 'My WS', documents: {}, pinned: [] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

function renderBar(overrides?: { onNavigateBack?: () => void }) {
  // React 18 delegates events to the root container. Radix portals render into document.body,
  // which is a DOM sibling of the default test container. Using document.body as the React root
  // ensures portal events bubble to React's listener.
  return render(
    <WorkspaceTopBar
      workspaceId="ws_1"
      path="canvas-a"
      onToggleFullscreen={() => {}}
      onNavigateBack={overrides?.onNavigateBack ?? (() => {})}
    />,
    { container: document.body },
  )
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

describe('WorkspaceTopBar — router-free navigation callbacks', () => {
  it('calls onNavigateBack when the back button is clicked', () => {
    const onNavigateBack = vi.fn()
    renderBar({ onNavigateBack })

    fireEvent.click(screen.getByRole('button', { name: /back to documents/i }))

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
      onToggleFullscreen: () => {},
      onNavigateBack: () => {},
      // The resolved display name is what this race decides, and the title
      // segment is where it surfaces now that the switcher's list is gone.
      titleSlot: (identity: DocumentIdentity) => <span>{identity.name}</span>,
    }

    const { rerender } = render(<WorkspaceTopBar workspaceId="ws_a" {...baseProps} />)
    rerender(<WorkspaceTopBar workspaceId="ws_b" {...baseProps} />)

    // The newer workspace's response arrives first; the stale ws_a response
    // arrives later and must not clobber it.
    resolveB(
      new Response(
        JSON.stringify({ workspace: 'B', documents: { 'shared-path': 'Fresh B' }, pinned: [] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    )
    await waitFor(() => {
      expect(screen.getByText('Fresh B')).toBeTruthy()
    })

    resolveA(
      new Response(
        JSON.stringify({ workspace: 'A', documents: { 'shared-path': 'Stale A' }, pinned: [] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    )

    await waitFor(() => {
      expect(screen.queryByText('Stale A')).toBeNull()
      expect(screen.getByText('Fresh B')).toBeTruthy()
    })
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
          onToggleFullscreen={() => {}}
          onNavigateBack={() => {}}
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
    titleSlot?: ComponentProps<typeof WorkspaceTopBar>['titleSlot']
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
          onToggleFullscreen={() => {}}
          onNavigateBack={() => {}}
          getThumbnailBlob={overrides?.getThumbnailBlob}
          titleSlot={overrides?.titleSlot}
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

  it('commits a rename made through the title slot via the injected daemon fetch', async () => {
    const daemonFetch = renderBarWithDaemonFetch({
      titleSlot: (identity) => (
        <input
          aria-label="Merged title"
          value={identity.name}
          onChange={(e) => identity.onRename?.(e.target.value)}
        />
      ),
    })

    fireEvent.change(screen.getByLabelText('Merged title'), { target: { value: 'renamed' } })

    await waitFor(() => {
      expect(daemonFetch).toHaveBeenCalledWith(
        expect.stringContaining('/documents/canvas-a/name'),
        expect.objectContaining({ method: 'PUT' }),
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

    const kebabTrigger = screen.getByRole('button', { name: 'View options' })
    expect(kebabTrigger.className).toContain('min-[400px]:hidden')
  })
})

describe('WorkspaceTopBar — optional daemon-context props (RED-first)', () => {
  it('hides the back button when onNavigateBack is omitted', () => {
    render(<WorkspaceTopBar workspaceId="ws_1" path="canvas-a" />, { container: document.body })
    expect(screen.queryByLabelText('Back to documents')).toBeNull()
  })

  it('hides the fullscreen button when onToggleFullscreen is omitted', () => {
    render(<WorkspaceTopBar workspaceId="ws_1" path="canvas-a" onNavigateBack={() => {}} />, {
      container: document.body,
    })
    expect(screen.queryByLabelText('Fullscreen')).toBeNull()
  })

  it('hides HeaderVersionDot when versionsEnabled is false', () => {
    render(
      <WorkspaceTopBar
        workspaceId="ws_1"
        path="canvas-a"
        onNavigateBack={() => {}}
        onToggleFullscreen={() => {}}
        versionsEnabled={false}
        capabilities={{ branches: true, merge: true }}
      />,
      { container: document.body },
    )
    expect(screen.queryByTestId('header-version-dot')).toBeNull()
    // The version-history trigger lives in the canvas HistoryCluster now,
    // never in the top bar.
    expect(screen.queryByRole('button', { name: /history/i })).toBeNull()
  })

  it('never issues a POST /versions on Cmd/Ctrl+S when versionsEnabled is false', async () => {
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
        onNavigateBack={() => {}}
        onToggleFullscreen={() => {}}
        versionsEnabled={false}
        capabilities={{ branches: true, merge: true }}
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
        onNavigateBack={() => {}}
        onToggleFullscreen={() => {}}
        capabilities={{ branches: false, merge: true }}
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
        onToggleFullscreen={() => {}}
        onNavigateBack={() => {}}
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

describe('WorkspaceTopBar — titleSlot (merged canvas row)', () => {
  it('renders the page-provided title segment inside the header', () => {
    render(
      <WorkspaceTopBar
        workspaceId="ws_1"
        path="canvas-a"
        onToggleFullscreen={() => {}}
        onNavigateBack={() => {}}
        titleSlot={() => <input aria-label="Merged title" readOnly value="t" />}
      />,
      { container: document.body },
    )
    const header = screen.getByRole('banner')
    expect(header.contains(screen.getByLabelText('Merged title'))).toBe(true)
  })
})

// The pencil's Rename mounted a SECOND live text field into the same flex row
// as the title slot's own input — one name, two inputs, disagreeing on when a
// name is committed (keystroke vs. Enter/blur). Naming happens in place on the
// title (ADR-0006 point 3), so the bar keeps no rename of its own.
describe('WorkspaceTopBar — one rename surface', () => {
  it('renders no document-actions pencil beside the switcher', () => {
    render(
      <WorkspaceTopBar
        workspaceId="ws_1"
        path="canvas-a"
        onToggleFullscreen={() => {}}
        onNavigateBack={() => {}}
        titleSlot={() => <input aria-label="Merged title" readOnly value="t" />}
      />,
      { container: document.body },
    )

    expect(screen.queryByLabelText('Document actions')).toBeNull()
  })

  it('leaves the title slot as the only editable field in the header', () => {
    render(
      <WorkspaceTopBar
        workspaceId="ws_1"
        path="canvas-a"
        onToggleFullscreen={() => {}}
        onNavigateBack={() => {}}
        titleSlot={() => <input aria-label="Merged title" readOnly value="t" />}
      />,
      { container: document.body },
    )

    const header = screen.getByRole('banner')
    expect(
      within(header)
        .getAllByRole('textbox')
        .map((field) => field.getAttribute('aria-label')),
    ).toEqual(['Merged title'])
  })
})

// In-editor document switching is retired (user decision 2026-08-22): finding
// a document is the document browser's job, reached from the back control.
// The workspace-named menu that used to navigate, create and switch workspace
// from inside the editor is gone, and a launcher will be designed on its own
// rather than kept alive as that menu's side effect.
describe('WorkspaceTopBar — navigation left the document row', () => {
  it('renders no workspace-named switcher menu', () => {
    render(
      <WorkspaceTopBar
        workspaceId="ws_1"
        path="canvas-a"
        onToggleFullscreen={() => {}}
        onNavigateBack={() => {}}
      />,
      { container: document.body },
    )

    expect(screen.queryByRole('button', { name: /^Workspace:/i })).toBeNull()
  })

  // Navigation controls carry no visible text (user decision 2026-08-22);
  // their name lives in aria-label and the tooltip.
  it('names the back control without giving it visible text', () => {
    render(
      <WorkspaceTopBar
        workspaceId="ws_1"
        path="canvas-a"
        onToggleFullscreen={() => {}}
        onNavigateBack={() => {}}
      />,
      { container: document.body },
    )

    expect(screen.getByRole('button', { name: 'Back to documents' }).textContent).toBe('')
  })
})
